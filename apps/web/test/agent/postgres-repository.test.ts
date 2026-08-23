import { createHash } from 'node:crypto';
import { deterministicMailboxMemoryEventId } from '@hypermail/db';
import { describe, expect, it } from 'vitest';
import { PostgresAgentRepository } from '../../src/agent/postgres-repository.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../../src/activity/postgres-repository.js';

const canonicalJson = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
const scope = { subjectId: 'person-1', accountIds: ['account-a', 'account-b'] } as const;
class RecordingSql implements SqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  constructor(private readonly responses: readonly SqlQueryResult[]) {}
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values }); return Promise.resolve((this.responses[this.calls.length - 1] ?? { rows: [] }) as SqlQueryResult<Row>);
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
    expect(db.calls[0]?.text).toContain('a.account_id');
    expect(db.calls[0]?.text).not.toContain('ac.account_id');
    expect(result.alerts.map((item) => item.kind)).toEqual(['account_health', 'poll_failure', 'safety_pause']);
    expect(result.alerts[0]?.message).toBe('Reconnect required');
    expect(result.autonomy).toEqual({ global: { state: 'running', version: 1735689600000 }, accounts: { 'account-a': { state: 'paused', version: 1735689600000 }, 'account-b': { state: 'running', version: 1735689600000 } } });
    for (const call of db.calls) expect(call.values).toContain(scope.accountIds);
    expect(db.calls[0]?.text).toContain('app.decisions');
    expect(db.calls[0]?.text).toContain('app.action_verifications');
    expect(db.calls[0]?.text).toContain('app.audits');
  });

  it('turns provider authentication failures into an actionable reconnect message', async () => {
    const db = new RecordingSql([
      { rows: [] },
      { rows: [] },
      { rows: [{ account_id: 'account-a', health_state: 'degraded', detail: 'Provider authentication failed', reason_code: 'provider_auth_failed', consecutive_failures: 1, last_error_code: 'provider_auth_failed', autonomy_paused_at: null }] },
      { rows: [{ id: 'account-a', autonomy_paused_at: null, updated_at: new Date('2025-01-01T00:00:00Z') }] },
    ]);
    const result = await new PostgresAgentRepository(db).dashboard(scope);
    expect(result.alerts[0]?.message).toBe('Mailbox authentication expired. Reconnect this mailbox in More → Settings.');
    expect(result.alerts[1]?.message).toContain('provider_auth_failed');
  });

  it('uses the question lock and deterministic audit correlation to replay duplicate answers without resuming twice', async () => {
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'answered' }] },
      { rows: [{ id: 'audit-1', metadata: { answerDigest: createHash('sha256').update('Yes').digest('hex') } }] },
    ]);
    const result = await new PostgresAgentRepository(db).answerQuestion(scope, 'question-1', 'Yes', 2, 'stable-key');
    expect(result).toMatchObject({ kind: 'duplicate', question: { id: 'question-1', state: 'answered' } });
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.text).toContain('FOR UPDATE');
    expect(db.calls[0]?.text).toContain('a.account_id = ANY($2::uuid[])');
    expect(db.calls[1]?.values).toContain('agent-question-answer:question-1:stable-key');
    expect(db.calls[1]?.text).toContain('metadata');
  });

  it('enqueues one bounded question-answer event in the canonical answer transaction', async () => {
    const occurredAt = '2025-01-01T00:01:00.000Z';
    const canonical = { userId: scope.subjectId, mailboxId: 'account-a', sourceType: 'question', sourceId: 'question-1', sourceVersion: 3,
      kind: 'question_answered', occurredAt, contentPayload: { outcome: 'answered', question: { text: 'Proceed?', digest: createHash('sha256').update('Proceed?').digest('hex'), truncated: false }, answer: { text: 'Yes', digest: createHash('sha256').update('Yes').digest('hex'), truncated: false } } } as const;
    const eventId = deterministicMailboxMemoryEventId(canonical);
    const contentDigest = createHash('sha256').update(canonicalJson(canonical.contentPayload)).digest('hex');
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'open' }] },
      { rows: [] }, { rows: [{ id: 'question-1' }] }, { rows: [{ version: 3, updated_at: occurredAt }] }, { rows: [] }, { rows: [] },
      { rows: [{ id: eventId, user_id: scope.subjectId, account_id: 'account-a', source_type: 'question', source_id: 'question-1', source_version: 3,
        kind: 'question_answered', content_digest: contentDigest, content_payload: canonical.contentPayload, state: 'pending', attempt_count: 0, claim_generation: 0, available_at: occurredAt, occurred_at: occurredAt, completed_at: null, cancelled_at: null,
        result_metadata: null, last_error_code: null, last_error_metadata: null, created_at: occurredAt, updated_at: occurredAt }] },
    ]);
    await expect(new PostgresAgentRepository(db).answerQuestion(scope, 'question-1', 'Yes', 2, 'stable-key')).resolves.toMatchObject({ kind: 'answered' });
    const enqueue = db.calls.find((call) => call.text.includes('mailbox_memory_events'));
    expect(enqueue?.values?.[0]).toBe(eventId);
    expect(enqueue?.values?.[8]).toEqual(canonical.contentPayload);
    const audit = db.calls.find((call) => call.text.includes('INSERT INTO app.audits'));
    expect(audit?.values?.at(-1)).not.toContain('"answer":"Yes"');
  });

  it('rejects a duplicate idempotency key when its durable answer differs', async () => {
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'answered' }] },
      { rows: [{ id: 'audit-1', metadata: { answerDigest: createHash('sha256').update('Yes').digest('hex') } }] },
    ]);
    await expect(new PostgresAgentRepository(db).answerQuestion(scope, 'question-1', 'No', 2, 'stable-key')).resolves.toEqual({ kind: 'conflict', currentVersion: 2 });
    expect(db.calls).toHaveLength(2);
  });

  it('enforces retry state and open-question rules inside its scoped transaction', async () => {
    const db = new RecordingSql([{ rows: [action({ state: 'failed', open_question: true })] }]);
    const result = await new PostgresAgentRepository(db).retryAction(scope, 'action-1', 3);
    expect(result).toEqual({ kind: 'blocked', reason: 'Answer the open question before retrying this action.' });
    expect(db.calls[0]?.text).toContain('FOR UPDATE');
    expect(db.calls[0]?.values).toContain(scope.accountIds);
  });

  it('pauses all scoped accounts atomically and targets only the requested account for an account pause', async () => {
    const stamp = 1735689600000;
    const global = new RecordingSql([
      { rows: [{ id: 'account-a', updated_at: '2025-01-01T00:00:00.000Z' }, { id: 'account-b', updated_at: '2025-01-01T00:00:00.000Z' }] },
      { rows: [{ id: 'account-a' }, { id: 'account-b' }] }, { rows: [] }, { rows: [] },
    ]);
    await expect(new PostgresAgentRepository(global).setAutonomy(scope, { kind: 'global' }, 'paused', stamp)).resolves.toEqual({ kind: 'updated', state: 'paused' });
    expect(global.calls[1]?.values).toEqual([true, scope.accountIds, stamp]);
    expect(global.calls[1]?.text).toContain('autonomy_paused_at');
    const account = new RecordingSql([
      { rows: [{ id: 'account-a', updated_at: '2025-01-01T00:00:00.000Z' }] }, { rows: [{ id: 'account-a' }] }, { rows: [] },
    ]);
    await new PostgresAgentRepository(account).setAutonomy(scope, { kind: 'account', accountId: 'account-a' }, 'running', stamp);
    expect(account.calls[0]?.values).toEqual([['account-a']]);
    expect(account.calls[1]?.values).toEqual([false, ['account-a'], stamp]);
    expect(global.calls[1]?.text).toContain('= $3::bigint');
  });

  it('rolls back a global autonomy update when any account no longer has the dashboard version', async () => {
    const stamp = 1735689600000;
    const db = new RecordingSql([
      { rows: [{ id: 'account-a', updated_at: '2025-01-01T00:00:00.000Z' }, { id: 'account-b', updated_at: '2025-01-01T00:00:00.000Z' }] },
      { rows: [{ id: 'account-a' }] },
    ]);
    await expect(new PostgresAgentRepository(db).setAutonomy(scope, { kind: 'global' }, 'paused', stamp)).resolves.toEqual({ kind: 'conflict', currentVersion: stamp });
    expect(db.rollbacks).toBe(1);
    expect(db.calls).toHaveLength(2);
  });

  it('never invents a rollback link for a non-recoverable action', async () => {
    const db = new RecordingSql([{ rows: [action({ kind: 'archive', state: 'failed' })] }, { rows: [] }, { rows: [] }, { rows: [] }]);
    const result = await new PostgresAgentRepository(db).dashboard(scope);
    expect(result.actions[0]?.reversalHref).toBeUndefined();
    expect(result.actions[0]?.recoverable).toBe(false);
  });
});
