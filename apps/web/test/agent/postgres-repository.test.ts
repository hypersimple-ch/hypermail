import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { withPostgresSchemas } from '../../../worker/test/postgres-test.js';
import { describe, expect, it } from 'vitest';
import { PostgresAgentRepository } from '../../src/agent/postgres-repository.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../../src/activity/postgres-repository.js';

const scope = { subjectId: 'person-1', accountIds: ['account-a', 'account-b'] } as const;
class RecordingSql implements SqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  constructor(private readonly responses: readonly SqlQueryResult[]) {}
  private responseIndex = 0;
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes('FOR UPDATE OF account')) return Promise.resolve({ rows: [] });
    return Promise.resolve((this.responses[this.responseIndex++] ?? { rows: [] }) as SqlQueryResult<Row>);
  }
  rollbacks = 0;
  async transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    try { return await work(this); } catch (error) { this.rollbacks++; throw error; }
  }
}

const action = (overrides: SqlRow = {}): SqlRow => ({ id: 'action-1', activity_id: 'activity-1', account_id: 'account-a', version: 3, kind: 'recoverable_trash', state: 'succeeded', rationale: 'Clear clutter', question_id: null, verification_state: 'verified', outcome: null, ...overrides });

describe('PostgresAgentRepository', () => {
  it('projects scoped decisions/actions/verifications/questions and durable health, polling, and safety alerts', async () => {
    const db = new RecordingSql([
      { rows: [action()] },
      { rows: [{ id: 'question-1', account_id: 'account-a', version: 3, prompt: 'Proceed?', state: 'open' }] },
      { rows: [{ account_id: 'account-a', health_state: 'degraded', detail: 'Reconnect required', reason_code: 'TOKEN', consecutive_failures: 2, last_error_code: 'TIMEOUT', autonomy_paused_at: '2025-01-01T00:00:00Z', pause_event: 'agent.autonomy_paused' }] },
      { rows: [{ id: 'account-a', autonomy_paused_at: '2025-01-01T00:00:00Z', updated_at: new Date('2025-01-01T00:00:00Z') }, { id: 'account-b', autonomy_paused_at: null, updated_at: '2025-01-01T00:00:00Z' }] },
    ]);
    const result = await new PostgresAgentRepository(db).dashboard(scope);
    expect(result.actions[0]).toMatchObject({ status: 'completed', verification: 'Verified.', recoverable: true, reversalHref: '/activity/activity-1/reversal' });
    expect(result.alerts.map((item) => item.kind)).toEqual(['account_health', 'poll_failure', 'safety_pause']);
    expect(result.alerts[0]?.message).toBe('Reconnect required');
    expect(result.autonomy.accounts).toEqual({ 'account-a': { state: 'paused', version: 1735689600000 }, 'account-b': { state: 'running', version: 1735689600000 } });
  });


  it('uses the question lock and deterministic audit correlation to replay duplicate answers without resuming twice', async () => {
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'answered' }] },
      { rows: [{ id: 'audit-1', metadata: { answerDigest: createHash('sha256').update('Yes').digest('hex') } }] },
    ]);
    const result = await new PostgresAgentRepository(db).answerQuestion(scope, 'question-1', 'Yes', 2, 'stable-key');
    expect(result).toMatchObject({ kind: 'duplicate', question: { id: 'question-1', state: 'answered' } });
    expect(db.calls).toHaveLength(3);
  });


  it('rejects a duplicate idempotency key when its durable answer differs', async () => {
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'answered' }] },
      { rows: [{ id: 'audit-1', metadata: { answerDigest: createHash('sha256').update('Yes').digest('hex') } }] },
    ]);
    await expect(new PostgresAgentRepository(db).answerQuestion(scope, 'question-1', 'No', 2, 'stable-key')).resolves.toEqual({ kind: 'conflict', currentVersion: 2 });
    expect(db.calls).toHaveLength(3);
  });

  it('enforces retry state and open-question rules inside its scoped transaction', async () => {
    const db = new RecordingSql([{ rows: [action({ state: 'failed', open_question: true })] }]);
    const result = await new PostgresAgentRepository(db).retryAction(scope, 'action-1', 3);
    expect(result).toEqual({ kind: 'blocked', reason: 'Answer the open question before retrying this action.' });
  });


  it('never invents a rollback link for a non-recoverable action', async () => {
    const db = new RecordingSql([{ rows: [action({ kind: 'archive', state: 'failed' })] }, { rows: [] }, { rows: [] }, { rows: [] }]);
    const result = await new PostgresAgentRepository(db).dashboard(scope);
    expect(result.actions[0]?.reversalHref).toBeUndefined();
    expect(result.actions[0]?.recoverable).toBe(false);
  });

  it('does not report an unverified or still-verifying mutation as completed', async () => {
    for (const row of [action({ verification_state: null }), action({ state: 'verifying', verification_state: 'verifying' })]) {
      const db = new RecordingSql([{ rows: [row] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);
      const result = await new PostgresAgentRepository(db).dashboard(scope);
      expect(result.actions[0]?.status).not.toBe('completed');
      expect(result.actions[0]?.recoverable).toBe(false);
    }
  });
});

describe('owner proposal repository PostgreSQL', () => {
  const databaseUrl = process.env.DATABASE_URL;
  it.skipIf(!databaseUrl)('enforces owner scope and replays one immutable review and JSON memory event under concurrency', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async (sql) => {
      const userId = randomUUID(), otherUser = randomUUID(), accountId = randomUUID(), messageId = randomUUID();
      const activityId = randomUUID(), assignmentId = randomUUID(), grantId = randomUUID(), runId = randomUUID(), decisionId = randomUUID(), proposalId = randomUUID();
      const payload = { key: 'archive', kind: 'archive', target: { accountId, messageId }, confidence: 0.4, reason: 'Owner should decide.', evidenceIds: [], dependsOn: [] };
      await sql.begin(async (tx) => {
        await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@test`},'h'),(${otherUser},${`${otherUser}@test`},'h')`;
        await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'microsoft',${accountId},${`${accountId}@test`},'ready')`;
        await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
        await tx`insert into app.folders(account_id,provider_folder_id,name,selectable) values(${accountId},'archive','Archive',true),(${accountId},'hidden','Hidden',false)`;
        await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',true)`;
        await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'mastra',array['mail.archive']::text[],array['automatic']::text[],'active',now())`;
        await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,received_at) values(${messageId},${accountId},'m','{"address":"s@test"}','[]','Review subject',now())`;
        await tx`insert into app.activities(id,account_id,message_id,state) values(${activityId},${accountId},${messageId},'waiting_question')`;
        await tx`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id,state) values(${activityId},${userId},${accountId},'arrival',${messageId},${`arrival:${activityId}`},'waiting_for_answer')`;
        await tx`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,created_at,started_at,completed_at) values(${runId},${activityId},${userId},${accountId},1,'mastra',${assignmentId},1,${grantId},1,1,'automatic',${tx.json({kind:'arrival',messageId})},${'d'.repeat(64)},${`run:${runId}`},'completed','action_requests_emitted',now(),now(),now())`;
        await tx`insert into app.decisions(id,activity_id,attempt,state,rationale,model_provider,model_name,input_digest,output,schema_version,run_id,user_id,account_id) values(${decisionId},${activityId},1,'actionable','review','fixture','fixture',${'d'.repeat(64)},${tx.json({schemaVersion:2,state:'actionable',rationale:'review',actions:[payload]})},2,${runId},${userId},${accountId})`;
        await tx`insert into app.agent_action_proposals(id,user_id,account_id,activity_id,run_id,decision_id,action_key,origin,kind,payload,confidence,threshold,evidence_snapshot,state) values(${proposalId},${userId},${accountId},${activityId},${runId},${decisionId},'archive','model','archive',${tx.json(payload)},0.4,0.6,'[]','waiting_review')`;
      });
      const client = (connection: Sql): SqlClient => ({
        query: async (statement, values) => ({ rows: await connection.unsafe(statement, values as never[]) }),
        transaction: async (work) => connection.begin((tx) => work(client(tx))),
      });
      const repository = new PostgresAgentRepository(client(sql)), owner = { subjectId: userId, accountIds: [accountId] };
      expect(await repository.listProposals({ ...owner, subjectId: otherUser })).toEqual([]);
      expect(await repository.listProposals({ ...owner, subjectId: otherUser }, activityId)).toBeNull();
      expect(await repository.listProposals(owner, randomUUID())).toBeNull();
      expect(await repository.listProposals(owner, activityId)).toMatchObject([{ id: proposalId, confidence: 0.4, threshold: 0.6, payload, dependencies: [], action: null, state: 'waiting_review' }]);
      expect(await repository.listProposals({ ...owner, accountIds: [] })).toEqual([]);
      expect(await repository.listProposalFolders(owner, accountId)).toMatchObject([{ name: 'Archive', accountId }]);
      expect(await repository.listProposalFolders({ ...owner, subjectId: otherUser }, accountId)).toBeNull();
      expect(await repository.listProposalFolders({ ...owner, accountIds: [] })).toEqual([]);
      const input = { expectedRevision: 1, idempotencyKey: 'review-key', decision: 'reject' as const, reason: 'Keep this mail.' };
      expect(await repository.reviewProposal({ ...owner, subjectId: otherUser }, proposalId, input)).toEqual({ kind: 'not_found' });
      expect(await repository.reviewProposal({ ...owner, accountIds: [] }, proposalId, input)).toEqual({ kind: 'not_found' });
      const results = await Promise.all([repository.reviewProposal(owner, proposalId, input), repository.reviewProposal(owner, proposalId, input)]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({ kind: 'reviewed', proposalId, successorProposalId: null });
      expect(await repository.reviewProposal(owner, proposalId, { ...input, reason: 'Different' })).toEqual({ kind: 'conflict', reasonCode: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await repository.reviewProposal(owner, proposalId, { ...input, idempotencyKey: 'new-key' })).toEqual({ kind: 'conflict', reasonCode: 'PROPOSAL_REVISION_CONFLICT' });
      expect(await repository.listProposals(owner, activityId)).toMatchObject([{ id: proposalId, state: 'rejected', revision: 2, confidence: 0.4 }]);
      const events = await sql`select content_payload from app.mailbox_memory_events where source_type='action_review'`;
      expect(events).toHaveLength(1);
      expect(events[0]?.content_payload).toMatchObject({ outcome: 'reject', proposalId, target: { accountId, messageId }, ownerResponse: { text: 'Keep this mail.' } });
      const detail = await sql`select detail from app.agent_activity_events where activity_id=${activityId}`;
      expect(detail).toHaveLength(1);
      expect(detail[0]?.detail).toMatchObject({ type: 'action_reviewed', proposalId, decision: 'reject' });
      expect(await sql`select count(*)::integer as count from app.agent_authorized_actions where activity_id=${activityId}`).toEqual([{ count: 0 }]);
    });
  });
});
