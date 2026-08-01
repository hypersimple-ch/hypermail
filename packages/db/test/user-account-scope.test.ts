import { describe, expect, it } from 'vitest';
import { UserAccountScopeStore, type SqlClient } from '../src/index.js';

class FakeSql implements SqlClient {
  readonly calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  transactions = 0;
  constructor(private readonly responses: readonly (readonly Record<string, unknown>[])[]) {}
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- implements generic SqlClient.
  query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<{ rows: readonly Row[] }> {
    this.calls.push({ statement, values });
    return Promise.resolve({ rows: (this.responses[this.calls.length - 1] ?? []) as readonly Row[] });
  }
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { this.transactions++; return operation(this); }
}

const userId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';

describe('user account scope', () => {
  it('derives account ids from the authenticated user only', async () => {
    const sql = new FakeSql([[{ account_id: accountId }]]);
    await expect(new UserAccountScopeStore(sql).accountIdsForUser(userId)).resolves.toEqual([accountId]);
    expect(sql.calls[0]?.values).toEqual([userId]);
    expect(sql.calls[0]?.statement).toContain('app.user_accounts');
  });

  it('returns only joined account projections', async () => {
    const sql = new FakeSql([[{ id: accountId, provider: 'gmail', email: 'owner@example.test', display_name: null, state: 'ready' }]]);
    await expect(new UserAccountScopeStore(sql).accountsForUser(userId)).resolves.toEqual([
      { id: accountId, provider: 'gmail', email: 'owner@example.test', displayName: null, state: 'ready' },
    ]);
    expect(sql.calls[0]?.statement).toContain('join app.accounts');
  });

  it('fails closed when no ownership row exists', async () => {
    const sql = new FakeSql([[]]);
    await expect(new UserAccountScopeStore(sql).ownsAccount(userId, accountId)).resolves.toBe(false);
  });

  it('normalizes Outlook and creates a ready account linked to its owner transactionally', async () => {
    const sql = new FakeSql([[], [{ id: accountId }], [], [], []]);
    await expect(new UserAccountScopeStore(sql).projectReadyAccount(` ${userId} `, {
      provider: 'outlook', email: ' Owner@Example.Test ', displayName: ' Owner ',
    })).resolves.toEqual({ id: accountId, provider: 'microsoft', email: 'owner@example.test', displayName: 'Owner', state: 'ready' });
    expect(sql.transactions).toBe(1);
    expect(sql.calls[1]?.values).toEqual(['microsoft', 'owner@example.test', 'owner@example.test', 'Owner']);
    expect(sql.calls[1]?.statement).toContain("state)\n           values ($1, $2, $3, $4, 'ready')");
    expect(sql.calls[1]?.statement).not.toContain('baseline_completed_at');
    expect(sql.calls[3]?.statement).toContain("state = 'ready'");
    expect(sql.calls[3]?.statement).not.toContain('baseline_completed_at');
    expect(sql.calls[4]?.statement).toContain('on conflict (user_id, account_id) do nothing');
    expect(sql.calls[4]?.values).toEqual([userId, accountId]);
  });

  it('re-adds the same owner without duplicating its ready linkage', async () => {
    const sql = new FakeSql([
      [{ id: accountId, provider: 'gmail', provider_account_id: 'owner@example.test', email: 'owner@example.test' }],
      [{ user_id: userId }], [], [],
    ]);
    await expect(new UserAccountScopeStore(sql).projectReadyAccount(userId, { provider: 'gmail', email: 'OWNER@example.test' })).resolves.toMatchObject({ id: accountId, provider: 'gmail', state: 'ready' });
    expect(sql.calls[0]?.values).toEqual(['gmail', 'owner@example.test']);
    expect(sql.transactions).toBe(1);
    expect(sql.calls[3]?.statement).toContain('on conflict (user_id, account_id) do nothing');
  });

  it('fails closed for an incompatible provider identity', async () => {
    const sql = new FakeSql([[{ id: accountId, provider: 'gmail', provider_account_id: 'owner@example.test', email: 'owner@example.test' }]]);
    await expect(new UserAccountScopeStore(sql).projectReadyAccount(userId, { provider: 'outlook', email: 'owner@example.test' })).rejects.toThrow('Account identity conflict.');
    expect(sql.calls).toHaveLength(1);
  });

  it('fails closed when the account is linked to another owner', async () => {
    const sql = new FakeSql([
      [{ id: accountId, provider: 'imap', provider_account_id: 'owner@example.test', email: 'owner@example.test' }],
      [{ user_id: '00000000-0000-4000-8000-000000000003' }],
    ]);
    await expect(new UserAccountScopeStore(sql).projectReadyAccount(userId, { provider: 'imap', email: 'owner@example.test' })).rejects.toThrow('another user');
    expect(sql.calls[0]?.values).toEqual(['imap', 'owner@example.test']);
    expect(sql.calls).toHaveLength(2);
  });
});
