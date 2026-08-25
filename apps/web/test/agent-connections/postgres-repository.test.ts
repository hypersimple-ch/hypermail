import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@hypermail/db';
import { PostgresAgentConnectionsRepository } from '../../src/agent-connections/postgres-repository.js';

class FakeSql {
  readonly calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  constructor(private readonly responses: readonly (readonly Record<string, unknown>[])[]) {}
  query(statement: string, values: readonly unknown[] = []): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push({ statement, values });
    return Promise.resolve({ rows: this.responses[this.calls.length - 1] ?? [] });
  }
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return operation(this as unknown as SqlClient); }
}

describe('agent connections repository grant minting', () => {
  it('mints a reapproval-required grant when a manager is first assigned', async () => {
    const sql = new FakeSql([
      [{ manager_kind: 'mastra', agent_connection_id: null }],
      [],
      [],
      [{ revision: 2 }],
    ]);
    await new PostgresAgentConnectionsRepository(sql as unknown as SqlClient).setAssignment('user-1', 'mailbox-1', { kind: 'mastra' }, true, 1);
    const insert = sql.calls.find((call) => call.statement.includes('insert into app.agent_capability_grants'));
    expect(insert).toBeTruthy();
    expect(insert?.statement).toContain('reapproval_required');
    expect(insert?.values[4]).toContain('mail.read');
    expect(insert?.values[5]).toContain('automatic');
  });

  it('does not duplicate a grant that already exists for the manager', async () => {
    const sql = new FakeSql([
      [{ manager_kind: 'mastra', agent_connection_id: null }],
      [{ id: 'grant-1' }],
      [{ revision: 2 }],
    ]);
    await new PostgresAgentConnectionsRepository(sql as unknown as SqlClient).setAssignment('user-1', 'mailbox-1', { kind: 'mastra' }, false, 1);
    expect(sql.calls.find((call) => call.statement.includes('insert into app.agent_capability_grants'))).toBeUndefined();
  });

  it('redispatches unavailable pending jobs when a grant is approved', async () => {
    const sql = new FakeSql([[{ id: 'grant-1', revision: 2 }], []]);
    await new PostgresAgentConnectionsRepository(sql as unknown as SqlClient).reapproveGrant('user-1', 'mailbox-1', 1, 'event-1', '2026-01-01T00:00:00Z');
    const redispatch = sql.calls.find((call) => call.statement.includes('unavailable_reason is not null'));
    expect(redispatch).toBeTruthy();
    expect(redispatch?.statement).toContain('queue_job_id=null');
  });
});
