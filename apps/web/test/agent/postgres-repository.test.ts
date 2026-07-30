import { describe, expect, it } from 'vitest';
import { PostgresAgentRepository } from '../../src/agent/postgres-repository.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../../src/activity/postgres-repository.js';

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
    expect(result.autonomy).toEqual({ global: { state: 'running', version: 1735689600000 }, accounts: { 'account-a': { state: 'paused', version: 1735689600000 }, 'account-b': { state: 'running', version: 1735689600000 } } });
    for (const call of db.calls) expect(call.values).toContain(scope.accountIds);
    expect(db.calls[0]?.text).toContain('app.decisions');
    expect(db.calls[0]?.text).toContain('app.action_verifications');
    expect(db.calls[0]?.text).toContain('app.audits');
  });

  it('uses the question lock and deterministic audit correlation to replay duplicate answers without resuming twice', async () => {
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'answered' }] },
      { rows: [{ id: 'audit-1', metadata: { answer: 'Yes' } }] },
    ]);
    const result = await new PostgresAgentRepository(db).answerQuestion(scope, 'question-1', 'Yes', 2, 'stable-key');
    expect(result).toMatchObject({ kind: 'duplicate', question: { id: 'question-1', state: 'answered' } });
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.text).toContain('FOR UPDATE');
    expect(db.calls[0]?.text).toContain('a.account_id = ANY($2::uuid[])');
    expect(db.calls[1]?.values).toContain('agent-question-answer:question-1:stable-key');
    expect(db.calls[1]?.text).toContain('metadata');
  });

  it('rejects a duplicate idempotency key when its durable answer differs', async () => {
    const db = new RecordingSql([
      { rows: [{ id: 'question-1', activity_id: 'activity-1', account_id: 'account-a', version: 2, prompt: 'Proceed?', state: 'answered' }] },
      { rows: [{ id: 'audit-1', metadata: { answer: 'Yes' } }] },
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
