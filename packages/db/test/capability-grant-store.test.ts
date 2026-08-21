/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
import { describe, expect, it } from 'vitest';
import { CapabilityGrantStore, StaleCapabilityGrantRevisionError, type SqlClient } from '../src/index.js';

const userId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
const mailboxId = '00000000-0000-4000-8000-000000000003';
const grantId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-08-13T12:00:00.000Z');
class FakeSql implements SqlClient {
  calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  constructor(private readonly rows: readonly (readonly Record<string, unknown>[])[]) {}
  query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<{ rows: readonly Row[] }> {
    this.calls.push({ statement, values }); return Promise.resolve({ rows: (this.rows[this.calls.length - 1] ?? []) as readonly Row[] });
  }
  transaction<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> { return operation(this); }
}
const row = (revision = 1) => ({ id: grantId, user_id: userId, account_id: mailboxId, manager_kind: 'agent_connection',
  agent_connection_id: connectionId, capabilities: ['mail.read'], invocation_modes: ['interactive'], state: 'reapproval_required', revision,
  approved_at: now, created_at: now, updated_at: now });

describe('CapabilityGrantStore', () => {
  it('creates current revision one and relies on the database history trigger', async () => {
    const sql = new FakeSql([[row()]]); const store = new CapabilityGrantStore(sql);
    const result = await store.create({ id: grantId, userId, mailboxId, manager: { kind: 'agent_connection', connectionId },
      capabilities: ['mail.read'], invocationModes: ['interactive'], approvedAt: now.toISOString() });
    expect(result.revision).toBe(1);
    expect(sql.calls[0]?.statement).toContain('agent_capability_grants');
    expect(sql.calls[0]?.statement).not.toContain('agent_capability_grant_revisions');
  });
  it('uses revision compare-and-swap and rejects stale or unchanged writes', async () => {
    const successful = new FakeSql([[row(2)]]);
    await expect(new CapabilityGrantStore(successful).revise({ id: grantId, userId, expectedRevision: 1, manager: { kind: 'agent_connection', connectionId },
      capabilities: ['mail.read'], invocationModes: ['interactive'], state: 'reapproval_required', approvedAt: now.toISOString() })).resolves.toMatchObject({ revision: 2 });
    expect(successful.calls[0]?.statement).toContain('revision = revision + 1');
    expect(successful.calls[0]?.statement).toContain('revision = $3');
    await expect(new CapabilityGrantStore(new FakeSql([[]])).revise({ id: grantId, userId, expectedRevision: 1, manager: { kind: 'agent_connection', connectionId },
      capabilities: ['mail.read'], invocationModes: ['interactive'], state: 'reapproval_required', approvedAt: now.toISOString() })).rejects.toBeInstanceOf(StaleCapabilityGrantRevisionError);
    const duplicateSql = new FakeSql([[row(2)]]);
    await expect(new CapabilityGrantStore(duplicateSql).revise({ id: grantId, userId, expectedRevision: 1, manager: { kind: 'agent_connection', connectionId },
      capabilities: ['mail.read', 'mail.read'], invocationModes: ['interactive'], state: 'reapproval_required', approvedAt: now.toISOString() })).rejects.toThrow('unique');
    expect(duplicateSql.calls).toHaveLength(0);
  });
});
