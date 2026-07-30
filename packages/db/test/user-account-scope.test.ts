import { describe, expect, it } from 'vitest';
import { UserAccountScopeStore, type SqlClient } from '../src/index.js';

class FakeSql implements SqlClient {
  readonly calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  constructor(private readonly rows: readonly Record<string, unknown>[]) {}
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- implements generic SqlClient.
  query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<{ rows: readonly Row[] }> {
    this.calls.push({ statement, values });
    return Promise.resolve({ rows: this.rows as readonly Row[] });
  }
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return operation(this); }
}

const userId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';

describe('user account scope', () => {
  it('derives account ids from the authenticated user only', async () => {
    const sql = new FakeSql([{ account_id: accountId }]);
    await expect(new UserAccountScopeStore(sql).accountIdsForUser(userId)).resolves.toEqual([accountId]);
    expect(sql.calls[0]?.values).toEqual([userId]);
    expect(sql.calls[0]?.statement).toContain('app.user_accounts');
  });

  it('returns only joined account projections', async () => {
    const sql = new FakeSql([{ id: accountId, provider: 'gmail', email: 'owner@example.test', display_name: null, state: 'ready' }]);
    await expect(new UserAccountScopeStore(sql).accountsForUser(userId)).resolves.toEqual([
      { id: accountId, provider: 'gmail', email: 'owner@example.test', displayName: null, state: 'ready' },
    ]);
    expect(sql.calls[0]?.statement).toContain('join app.accounts');
  });

  it('fails closed when no ownership row exists', async () => {
    const sql = new FakeSql([]);
    await expect(new UserAccountScopeStore(sql).ownsAccount(userId, accountId)).resolves.toBe(false);
  });
});
