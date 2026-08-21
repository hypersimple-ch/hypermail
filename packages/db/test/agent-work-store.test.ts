import { describe, expect, it } from 'vitest';
import { AgentWorkStore, type SqlClient } from '../src/index.js';

class FakeSql implements SqlClient {
  readonly calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  constructor(private readonly responses: readonly (readonly Record<string, unknown>[])[]) {}
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- implements generic SqlClient.
  query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<{ rows: readonly Row[] }> {
    this.calls.push({ statement, values });
    return Promise.resolve({ rows: (this.responses[this.calls.length - 1] ?? []) as readonly Row[] });
  }
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return operation(this); }
}

const activity = {
  id: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000003', kind: 'interactive_request' as const,
  sourceMessageId: null, correlationId: 'correlation-unit-1', causationId: null, state: 'open' as const,
  revision: 1, createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
};
const row = { id: activity.id, user_id: activity.userId, account_id: activity.mailboxId, kind: activity.kind,
  source_message_id: null, correlation_id: activity.correlationId, causation_id: null, state: activity.state,
  revision: 1, created_at: new Date(activity.createdAt), updated_at: new Date(activity.updatedAt) };

describe('AgentWorkStore safety semantics', () => {
  it('uses a non-mutating conflict path and accepts only an exact Activity replay', async () => {
    const sql = new FakeSql([[], [row]]);
    await expect(new AgentWorkStore(sql).createActivity(activity)).resolves.toEqual(activity);
    expect(sql.calls[0]?.statement).toContain('do nothing');
    expect(sql.calls[0]?.statement).not.toContain('do update');
    expect(sql.calls[1]?.statement).toContain('for update');
  });

  it('rejects an idempotency collision whose stored payload differs', async () => {
    const sql = new FakeSql([[], [{ ...row, causation_id: '00000000-0000-4000-8000-000000000099' }]]);
    await expect(new AgentWorkStore(sql).createActivity(activity)).rejects.toThrow('different payload');
  });

  it('requires the expected Activity revision in both the lock check and CAS update', async () => {
    const sql = new FakeSql([[row], [{ ...row, state: 'resolved', revision: 2, updated_at: new Date('2026-08-13T12:01:00.000Z') }]]);
    await expect(new AgentWorkStore(sql).transitionActivity(activity.userId, activity.mailboxId, activity.id, 1, 'resolved', '2026-08-13T12:01:00.000Z')).resolves.toMatchObject({ state: 'resolved', revision: 2 });
    expect(sql.calls[1]?.statement).toContain('and revision=$4');
    expect(sql.calls[1]?.statement).toContain('revision=$4+1');
  });
});
