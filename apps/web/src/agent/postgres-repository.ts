import { AgentProposalStore, enqueueMailboxMemoryEventInTransaction, mailboxMemoryTextEvidence } from '@hypermail/db';
import { ownerActionCorrectionSchema, plannedActionSchema } from '@hypermail/contracts';
import { createHash } from 'node:crypto';
import type { SqlClient, SqlRow } from '../activity/postgres-repository.js';
import type {
  AgentAction, AgentDashboard, AgentProposal, AgentQuestion, AgentRepository, AgentScope, AnswerResult, AutonomyResult, AutonomyScope,
  AutonomyState, ProposalFolder, ProposalReviewRequest, ProposalReviewResult, RetryResult,
} from './contracts.js';

const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const healthMessage = (row: SqlRow): string => {
  const reason = text(row['reason_code']) || text(row['last_error_code']);
  if (reason === 'provider_auth_failed') return 'Mailbox authentication expired. Reconnect this mailbox in More → Settings.';
  if (reason === 'provider_rate_limited') return 'The mail provider is rate limiting requests. Hypermail will retry automatically.';
  if (reason === 'provider_unavailable') return 'The mail provider is temporarily unavailable. Hypermail will retry automatically.';
  return text(row['detail']) || reason || 'Account connection needs attention.';
};
const scoped = (column: string, parameter: number): string => `${column} = ANY($${String(parameter)}::uuid[])`;
const accountVersion = (row: SqlRow): number => {
  const value = row['updated_at'];
  const milliseconds = value instanceof Date ? value.getTime() : new Date(text(value)).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('Account update timestamp is invalid.');
  return Math.max(1, Math.floor(milliseconds));
};
const answerDigest = (answer: string): string => createHash('sha256').update(answer).digest('hex');
const auditAnswerDigest = (row: SqlRow): string | undefined => {
  const metadata = row['metadata'];
  if (metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>)['answerDigest'] === 'string') return (metadata as Record<string, string>)['answerDigest'];
  if (typeof metadata !== 'string') return undefined;
  try { const parsed: unknown = JSON.parse(metadata); return parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['answerDigest'] === 'string' ? (parsed as Record<string, string>)['answerDigest'] : undefined; } catch { return undefined; }
};
class AutonomyUpdateConflict extends Error { constructor(readonly version: number) { super('Autonomy update conflicted.'); } }
const question = (row: SqlRow): AgentQuestion => ({
  id: text(row['id']), accountId: text(row['account_id']), version: Number(row['version']), prompt: text(row['prompt']), state: text(row['state']) as AgentQuestion['state'],
});
const action = (row: SqlRow): AgentAction => {
  const state = text(row['state']);
  const verification = text(row['verification_state']);
  const status = verification === 'verified' ? 'completed' : ['authorized', 'executing', 'verifying', 'planned'].includes(state) ? 'proposed' : verification === 'pending' ? 'blocked' : 'failed';
  const recoverable = text(row['kind']) === 'recoverable_trash' && verification === 'verified';
  return {
    id: text(row['id']), accountId: text(row['account_id']), version: Number(row['version']),
    title: text(row['kind']).replaceAll('_', ' '), reason: text(row['rationale']), status,
    ...(row['outcome'] == null ? {} : { outcome: text(row['outcome']) }),
    ...(row['verification_state'] == null ? {} : { verification: verification === 'verified' ? 'Verified.' : verification.replaceAll('_', ' ') }),
    recoverable, ...(recoverable ? { reversalHref: `/activity/${text(row['activity_id'])}/reversal` } : {}),
    ...(row['question_id'] == null ? {} : { questionId: text(row['question_id']) }),
  };
};

/** Shared read projection for dashboard and Activity detail; null means filtered Activity is absent. */
export async function listAgentProposals(sql: SqlClient, scope: AgentScope, activityId?: string): Promise<readonly AgentProposal[] | null> {
  if (activityId !== undefined) {
    const activity = await sql.query(`SELECT id FROM app.agent_activities WHERE id=$1::uuid AND user_id=$2::uuid AND account_id=ANY($3::uuid[])`, [activityId, scope.subjectId, scope.accountIds]);
    if (!activity.rows[0]) return null;
  }
  const result = await sql.query(`SELECT p.*, action.state AS action_state, action.error_code AS action_error_code,
      COALESCE(dependencies.items,'[]'::jsonb) AS dependencies
    FROM app.agent_action_proposals p
    LEFT JOIN app.agent_authorized_actions action ON action.id=p.authorized_action_id AND action.user_id=p.user_id AND action.account_id=p.account_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('proposalId',dependency.id,'state',dependency.state,'actionState',a.state) ORDER BY dependency.created_at,dependency.id) AS items
      FROM app.agent_proposal_dependencies d
      JOIN app.agent_action_proposals dependency ON dependency.id=d.depends_on_id AND dependency.user_id=p.user_id AND dependency.account_id=p.account_id
      LEFT JOIN app.agent_authorized_actions a ON a.id=dependency.authorized_action_id
      WHERE d.proposal_id=p.id
    ) dependencies ON true
    WHERE p.user_id=$1::uuid AND p.account_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR p.activity_id=$3::uuid)
    ORDER BY p.created_at,p.id`, [scope.subjectId, scope.accountIds, activityId ?? null]);
  return result.rows.map((row) => {
    const payload = row['origin'] === 'owner' ? ownerActionCorrectionSchema.parse(row['payload']) : plannedActionSchema.parse(row['payload']);
    return {
      id: text(row['id']), activityId: text(row['activity_id']), accountId: text(row['account_id']), runId: text(row['run_id']),
      origin: text(row['origin']) as AgentProposal['origin'], kind: payload.kind, payload,
      confidence: row['confidence'] == null ? null : Number(row['confidence']), threshold: Number(row['threshold']), revision: Number(row['revision']),
      state: text(row['state']) as AgentProposal['state'], reason: payload.reason, evidenceSnapshot: row['evidence_snapshot'],
      dependencies: row['dependencies'] as AgentProposal['dependencies'],
      action: row['authorized_action_id'] == null ? null : { id: text(row['authorized_action_id']), state: text(row['action_state']), errorCode: row['action_error_code'] == null ? null : text(row['action_error_code']) },
      supersedesProposalId: row['supersedes_proposal_id'] == null ? null : text(row['supersedes_proposal_id']),
      createdAt: row['created_at'] instanceof Date ? row['created_at'].toISOString() : text(row['created_at']),
    };
  });
}

/** Injected, account-scoped PostgreSQL implementation for the Agent dashboard. */
export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly sql: SqlClient) {}

  listProposals(scope: AgentScope, activityId?: string): Promise<readonly AgentProposal[] | null> {
    return listAgentProposals(this.sql, scope, activityId);
  }

  reviewProposal(scope: AgentScope, proposalId: string, input: Omit<ProposalReviewRequest, 'proposalId'>): Promise<ProposalReviewResult> {
    const { reason, correction, ...review } = input;
    return new AgentProposalStore(this.sql).review({ userId: scope.subjectId, accountIds: scope.accountIds }, proposalId, {
      ...review, ...(reason === undefined ? {} : { reason }), ...(correction === undefined ? {} : { correction }),
    });
  }

  async listProposalFolders(scope: AgentScope, accountId?: string): Promise<readonly ProposalFolder[] | null> {
    if (accountId !== undefined) {
      const owned = await this.sql.query(`SELECT account_id FROM app.user_accounts WHERE user_id=$1::uuid AND account_id=$2::uuid AND account_id=ANY($3::uuid[])`, [scope.subjectId, accountId, scope.accountIds]);
      if (!owned.rows[0]) return null;
    }
    const result = await this.sql.query(`SELECT f.id,f.name,f.account_id FROM app.folders f JOIN app.user_accounts ua ON ua.account_id=f.account_id WHERE ua.user_id=$1::uuid AND f.account_id=ANY($2::uuid[]) AND f.selectable AND ($3::uuid IS NULL OR f.account_id=$3::uuid) ORDER BY f.account_id,f.name,f.id`, [scope.subjectId, scope.accountIds, accountId ?? null]);
    return result.rows.map((row) => ({ id: text(row['id']), name: text(row['name']), accountId: text(row['account_id']) }));
  }

  async dashboard(scope: AgentScope): Promise<AgentDashboard> {
    const [actionRows, questionRows, alertRows, accountRows, proposals, ownerRows] = await Promise.all([
      this.sql.query(`SELECT ac.id, ac.activity_id, a.account_id, a.version, ac.kind, COALESCE(canonical.state::text,ac.state::text) AS state, d.rationale,
          q.id AS question_id, CASE WHEN canonical.id IS NOT NULL THEN canonical.state::text ELSE v.state::text END AS verification_state,
          COALESCE(canonical.error_code,ac.error_code, receipt.metadata->>'message') AS outcome
        FROM app.actions ac
        JOIN app.activities a ON a.id = ac.activity_id
        JOIN app.decisions d ON d.id = ac.decision_id
        LEFT JOIN app.agent_authorized_actions canonical ON canonical.id=ac.id
        LEFT JOIN LATERAL (SELECT q.id FROM app.questions q WHERE q.activity_id = a.id AND q.state = 'open' ORDER BY q.created_at DESC LIMIT 1) q ON true
        LEFT JOIN LATERAL (SELECT state FROM app.action_verifications WHERE action_id = ac.id ORDER BY attempt DESC LIMIT 1) v ON true
        LEFT JOIN LATERAL (SELECT metadata FROM app.audits WHERE activity_id = a.id AND event LIKE 'policy.action_%' ORDER BY occurred_at DESC LIMIT 1) receipt ON true
        WHERE ${scoped('a.account_id', 1)} AND EXISTS(SELECT 1 FROM app.user_accounts ua WHERE ua.account_id=a.account_id AND ua.user_id=$2::uuid) ORDER BY ac.created_at DESC, ac.id DESC`, [scope.accountIds, scope.subjectId]),
      this.sql.query(`SELECT q.id, a.account_id, a.version, q.prompt, q.state
        FROM app.questions q JOIN app.activities a ON a.id = q.activity_id
        WHERE ${scoped('a.account_id', 1)} AND EXISTS(SELECT 1 FROM app.user_accounts ua WHERE ua.account_id=a.account_id AND ua.user_id=$2::uuid) AND q.state IN ('open', 'answered') ORDER BY q.created_at DESC, q.id DESC`, [scope.accountIds, scope.subjectId]),
      this.sql.query(`SELECT ah.account_id, ah.state AS health_state, ah.detail, ah.reason_code, ps.consecutive_failures, ps.last_error_code,
          ac.autonomy_paused_at
        FROM app.accounts ac
        LEFT JOIN app.account_health ah ON ah.account_id = ac.id
        LEFT JOIN app.poll_states ps ON ps.account_id = ac.id
        WHERE ${scoped('ac.id', 1)} AND ac.user_id=$2::uuid`, [scope.accountIds, scope.subjectId]),
      this.sql.query(`SELECT id, autonomy_paused_at, updated_at FROM app.accounts WHERE ${scoped('id', 1)} AND user_id=$2::uuid ORDER BY id`, [scope.accountIds, scope.subjectId]),
      this.listProposals(scope),
      this.sql.query(`SELECT id,autonomy_paused_at,updated_at FROM app.users WHERE id=$1::uuid`,[scope.subjectId]),
    ]);
    const alerts = alertRows.rows.flatMap((row) => {
      const accountId = text(row['account_id']);
      const items: AgentDashboard['alerts'][number][] = [];
      if (row['health_state'] && row['health_state'] !== 'healthy' && row['health_state'] !== 'paused') items.push({ id: `health:${accountId}`, kind: 'account_health', accountId, message: healthMessage(row) });
      if (Number(row['consecutive_failures']) > 0) items.push({ id: `poll:${accountId}`, kind: 'poll_failure', accountId, message: `Polling is retrying${row['last_error_code'] ? ` (${text(row['last_error_code'])})` : ''}; previous results remain visible.` });
      if (row['autonomy_paused_at'] || row['health_state'] === 'paused') items.push({ id: `pause:${accountId}`, kind: 'safety_pause', accountId, message: 'Safety pause is active.' });
      return items;
    });
    const accounts = Object.fromEntries(accountRows.rows.map((row) => [text(row['id']), { state: row['autonomy_paused_at'] ? 'paused' : 'running', version: accountVersion(row) }] as const));
    const owner=ownerRows.rows[0];
    const allPaused=Boolean(owner?.['autonomy_paused_at']);
    const globalVersion=owner?accountVersion(owner):1;
    return { actions: actionRows.rows.map(action), proposals: proposals ?? [], questions: questionRows.rows.map(question), alerts, autonomy: { global: { state: allPaused ? 'paused' : 'running', version: globalVersion }, accounts } };
  }

  async answerQuestion(scope: AgentScope, questionId: string, answerText: string, expectedVersion: number, idempotencyKey: string): Promise<AnswerResult> {
    return this.sql.transaction(async (sql) => {
      await sql.query(`SELECT account.id FROM app.accounts account JOIN app.activities activity ON activity.account_id=account.id JOIN app.questions q ON q.activity_id=activity.id WHERE q.id=$1::uuid AND account.user_id=$2::uuid AND account.id=ANY($3::uuid[]) FOR UPDATE OF account`, [questionId, scope.subjectId, scope.accountIds]);
      const current = await sql.query(`SELECT q.id, q.activity_id, q.prompt, q.state, a.account_id, a.version
        FROM app.questions q JOIN app.activities a ON a.id = q.activity_id
        WHERE q.id = $1::uuid AND ${scoped('a.account_id', 2)} AND EXISTS(SELECT 1 FROM app.user_accounts ua WHERE ua.account_id=a.account_id AND ua.user_id=$3::uuid) FOR UPDATE`, [questionId, scope.accountIds, scope.subjectId]);
      const row = current.rows[0];
      if (!row) return { kind: 'not_found' };
      const replay = await sql.query(`SELECT id, metadata FROM app.audits WHERE activity_id = $1::uuid AND event = 'agent.question_answered' AND correlation_id = $2 FOR UPDATE`, [text(row['activity_id']), this.answerCorrelation(questionId, idempotencyKey)]);
      if (replay.rows[0]) {
        if (auditAnswerDigest(replay.rows[0]) !== answerDigest(answerText)) return { kind: 'conflict', currentVersion: Number(row['version']) };
        return { kind: 'duplicate', question: question(row) };
      }
      if (Number(row['version']) !== expectedVersion) return { kind: 'conflict', currentVersion: Number(row['version']) };
      if (row['state'] !== 'open') return { kind: 'conflict', currentVersion: Number(row['version']) };
      const updated = await sql.query(`UPDATE app.questions SET state = 'answered', answer = $1, answered_at = now(), updated_at = now() WHERE id = $2::uuid AND state = 'open' RETURNING id`, [answerText, questionId]);
      if (!updated.rows[0]) return { kind: 'conflict', currentVersion: Number(row['version']) };
      const activity = await sql.query(`UPDATE app.activities SET state = 'new', version = version + 1, updated_at = now() WHERE id = $1::uuid AND ${scoped('account_id', 2)} AND version = $3 RETURNING version, updated_at`, [text(row['activity_id']), scope.accountIds, expectedVersion]);
      if (!activity.rows[0]) return { kind: 'conflict', currentVersion: Number(row['version']) };
      const version = Number(activity.rows[0]['version']);
      await sql.query(`INSERT INTO app.agent_jobs (activity_id, idempotency_key, state, attempt, available_at, created_at, updated_at) VALUES ($1::uuid, $2, 'pending', 0, now(), now(), now()) ON CONFLICT (activity_id) DO UPDATE SET state = 'pending', available_at = now(), updated_at = now()`, [text(row['activity_id']), `question-answer:${questionId}:${String(version)}`]);
      const occurredAt = activity.rows[0]['updated_at'] instanceof Date ? activity.rows[0]['updated_at'].toISOString() : text(activity.rows[0]['updated_at']);
      await this.audit(sql, scope, text(row['activity_id']), text(row['account_id']), 'agent.question_answered', this.answerCorrelation(questionId, idempotencyKey), { questionId, idempotencyKey, answerDigest: answerDigest(answerText) });
      await enqueueMailboxMemoryEventInTransaction(sql, { userId: scope.subjectId, mailboxId: text(row['account_id']), sourceType: 'question', sourceId: questionId, sourceVersion: version, kind: 'question_answered', occurredAt, contentPayload: { outcome: 'answered', question: mailboxMemoryTextEvidence(text(row['prompt'])), answer: mailboxMemoryTextEvidence(answerText) } });
      return { kind: 'answered', question: { ...question(row), state: 'answered', version } };
    });
  }

  async retryAction(scope: AgentScope, actionId: string, expectedVersion: number): Promise<RetryResult> {
    return this.sql.transaction(async (sql) => {
      await sql.query(`SELECT account.id FROM app.accounts account JOIN app.actions action ON action.account_id=account.id WHERE action.id=$1::uuid AND account.user_id=$2::uuid AND account.id=ANY($3::uuid[]) FOR UPDATE OF account`, [actionId, scope.subjectId, scope.accountIds]);
      const found = await sql.query(`SELECT ac.id, ac.activity_id, ac.account_id, a.version, ac.kind, ac.state, d.rationale,
          EXISTS (SELECT 1 FROM app.questions q WHERE q.activity_id = a.id AND q.state = 'open') AS open_question
        FROM app.actions ac JOIN app.activities a ON a.id = ac.activity_id JOIN app.decisions d ON d.id = ac.decision_id
        WHERE ac.id = $1::uuid AND ${scoped('a.account_id', 2)} AND EXISTS(SELECT 1 FROM app.user_accounts ua WHERE ua.account_id=a.account_id AND ua.user_id=$3::uuid) FOR UPDATE`, [actionId, scope.accountIds, scope.subjectId]);
      const row = found.rows[0];
      if (!row) return { kind: 'not_found' };
      if (Number(row['version']) !== expectedVersion) return { kind: 'conflict', currentVersion: Number(row['version']) };
      if (row['open_question'] === true || row['open_question'] === 'true') return { kind: 'blocked', reason: 'Answer the open question before retrying this action.' };
      if (!['failed', 'unverifiable', 'incorrect'].includes(text(row['state']))) return { kind: 'blocked', reason: 'Only a failed, unverifiable, or incorrect action can be retried.' };
      const updated = await sql.query(`UPDATE app.activities SET state = 'new', version = version + 1, updated_at = now() WHERE id = $1::uuid AND ${scoped('account_id', 2)} AND version = $3 RETURNING version`, [text(row['activity_id']), scope.accountIds, expectedVersion]);
      if (!updated.rows[0]) return { kind: 'conflict', currentVersion: Number(row['version']) };
      const version = Number(updated.rows[0]['version']);
      await sql.query(`INSERT INTO app.agent_jobs (activity_id, idempotency_key, state, attempt, available_at, last_error_code, queue_job_id, created_at, updated_at) VALUES ($1::uuid, $2, 'pending', 0, now(), NULL, NULL, now(), now()) ON CONFLICT (activity_id) DO UPDATE SET state = 'pending', attempt = app.agent_jobs.attempt + 1, available_at = now(), last_error_code = NULL, queue_job_id = NULL, updated_at = now()`, [text(row['activity_id']), `agent-action-retry:${actionId}:${String(version)}`]);
      await this.audit(sql, scope, text(row['activity_id']), text(row['account_id']), 'agent.action_retry_requested', `agent-action-retry:${actionId}:${String(version)}`, { actionId, version });
      return { kind: 'queued', action: action({ ...row, version, verification_state: null }) };
    });
  }

  async setAutonomy(scope: AgentScope, target: AutonomyScope, state: AutonomyState, expectedVersion: number): Promise<AutonomyResult> {
    try {
      return await this.sql.transaction(async (sql) => {
        if(target.kind==='global'){
          const locked=await sql.query(`SELECT id,updated_at FROM app.users WHERE id=$1::uuid FOR UPDATE`,[scope.subjectId]);
          const owner=locked.rows[0];if(!owner)return {kind:'not_found'};
          const version=accountVersion(owner);if(version!==expectedVersion)return {kind:'conflict',currentVersion:version};
          await sql.query(`UPDATE app.users SET autonomy_paused_at=CASE WHEN $2::boolean THEN clock_timestamp() ELSE NULL END,updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond') WHERE id=$1::uuid`,[scope.subjectId,state==='paused']);
          await sql.query(`INSERT INTO app.audits(actor_type,actor_id,event,correlation_id,metadata) VALUES('user',$1,$2,$3,$4::jsonb)`,[scope.subjectId,state==='paused'?'agent.autonomy_paused':'agent.autonomy_resumed',`agent-autonomy:global:${scope.subjectId}:${String(expectedVersion)}`,{target:'global',state}]);
          return {kind:'updated',state};
        }
        const ids = [target.accountId];
        const locked = await sql.query(`SELECT id, updated_at FROM app.accounts WHERE ${scoped('id', 1)} AND user_id=$2::uuid FOR UPDATE`, [ids,scope.subjectId]);
        if (locked.rows.length !== ids.length) return { kind: 'not_found' };
        const version = Math.max(...locked.rows.map(accountVersion));
        if (version !== expectedVersion) return { kind: 'conflict', currentVersion: version };
        const updated = await sql.query(`UPDATE app.accounts SET autonomy_paused_at = CASE WHEN $1::boolean THEN now() ELSE NULL END, autonomy_pause_reason = CASE WHEN $1::boolean THEN 'user' ELSE NULL END, updated_at = now() WHERE ${scoped('id', 2)} RETURNING id`, [state === 'paused', ids]);
        if (updated.rows.length !== ids.length) throw new AutonomyUpdateConflict(version);
        if(state==='running')await sql.query(`UPDATE app.account_health SET state='healthy',reason_code=NULL,detail=NULL,updated_at=clock_timestamp() WHERE account_id=ANY($1::uuid[]) AND state='paused'`,[ids]);
        for (const row of locked.rows) await this.audit(sql, scope, '', text(row['id']), state === 'paused' ? 'agent.autonomy_paused' : 'agent.autonomy_resumed', `agent-autonomy:${target.kind}:${text(row['id'])}:${String(expectedVersion)}`, { target: target.kind, state });
        return { kind: 'updated', state };
      });
    } catch (error) {
      if (error instanceof AutonomyUpdateConflict) return { kind: 'conflict', currentVersion: error.version };
      throw error;
    }
  }

  private answerCorrelation(questionId: string, idempotencyKey: string): string { return `agent-question-answer:${questionId}:${idempotencyKey}`; }
  private audit(sql: SqlClient, scope: AgentScope, activityId: string, accountId: string, event: string, correlationId: string, metadata: Record<string, unknown>): Promise<unknown> {
    return sql.query(`INSERT INTO app.audits (actor_type, actor_id, account_id, activity_id, event, correlation_id, metadata) VALUES ('user', $1, $2::uuid, NULLIF($3, '')::uuid, $4, $5, $6::text::jsonb)`, [scope.subjectId, accountId, activityId, event, correlationId, JSON.stringify(metadata)]);
  }
}
