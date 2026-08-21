import { describe, expect, it } from 'vitest';
import { AgentManagerStore, type SqlClient } from '../src/index.js';

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
const connectionId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';

describe('Agent Manager persistence writers', () => {
  it('safely initializes the first default and can assign it through idempotent inserts', async () => {
    const sql = new FakeSql([
      [],
      [{ manager_kind: 'mastra', agent_connection_id: null }],
      [],
    ]);
    const store = new AgentManagerStore(sql);
    await store.initializeDefaultManager(userId);
    await store.assignCurrentDefault(userId, accountId);
    expect(sql.calls[0]?.statement).toContain('on conflict (user_id) do nothing');
    expect(sql.calls[2]?.statement).toContain('on conflict (user_id, account_id) do nothing');
    expect(sql.calls[2]?.values).toEqual([userId, accountId, 'mastra', null]);
  });

  it('copies a locked default to current assignment and revision 1 atomically', async () => {
    const sql = new FakeSql([
      [{ manager_kind: 'agent_connection', agent_connection_id: connectionId }],
      [],
    ]);
    await new AgentManagerStore(sql).assignCurrentDefault(userId, accountId);
    expect(sql.transactions).toBe(1);
    expect(sql.calls[0]?.statement).toContain('for share');
    expect(sql.calls[1]?.statement).toContain('on conflict (user_id, account_id) do nothing');
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[1]?.values).toEqual([userId, accountId, 'agent_connection', connectionId]);
  });

  it('fails closed without a configured default', async () => {
    const sql = new FakeSql([[]]);
    await expect(new AgentManagerStore(sql).assignCurrentDefault(userId, accountId)).rejects.toThrow('default is not configured');
    expect(sql.calls).toHaveLength(1);
  });

  it('changes the default with CAS without touching existing assignments', async () => {
    const sql = new FakeSql([[{ revision: 3 }]]);
    await expect(new AgentManagerStore(sql).reviseDefaultManager({
      userId, expectedRevision: 2, manager: { kind: 'none' },
    })).resolves.toBe(3);
    expect(sql.calls[0]?.statement).toContain('revision = revision + 1');
    expect(sql.calls[0]?.statement).not.toContain('mailbox_manager_assignments');
  });

  it('uses lifecycle compare-and-swap and bumps the fence', async () => {
    const sql = new FakeSql([[{ lifecycle_revision: 4 }]]);
    await expect(new AgentManagerStore(sql).reviseConnectionLifecycle({
      userId, connectionId, expectedState: 'paused', expectedRevision: 3, state: 'connected',
    })).resolves.toBe(4);
    expect(sql.calls[0]?.statement).toContain('lifecycle_revision = $6');
    expect(sql.calls[0]?.values).toEqual([userId, connectionId, 'paused', 4, 'connected', 3]);
  });

  it('requires the distinct verified reconnect method after security revocation', async () => {
    const store = new AgentManagerStore(new FakeSql([[{ lifecycle_revision: 5 }]]));
    await expect(store.reviseConnectionLifecycle({ userId, connectionId, expectedState: 'security_revoked', expectedRevision: 4, state: 'connected' })).rejects.toThrow('Illegal');
    const sql = new FakeSql([[{ event_id: 'verified-reconnect-event-1' }], [{ lifecycle_revision: 5 }], []]);
    await expect(new AgentManagerStore(sql).reconnectSecurityRevoked({ userId, connectionId, expectedRevision: 4,
      verificationEventId: 'verified-reconnect-event-1', verifiedAt: '2026-08-13T12:00:00.000Z' })).resolves.toBe(5);
    expect(sql.calls[0]?.statement).toContain('consumed_at is null');
    expect(sql.calls[1]?.statement).toContain("state = 'security_revoked'");
    expect(sql.calls[1]?.values[1]).toBe(connectionId);
  });

  it('fails a stale lifecycle compare-and-swap', async () => {
    const sql = new FakeSql([[]]);
    await expect(new AgentManagerStore(sql).reviseConnectionLifecycle({
      userId, connectionId, expectedState: 'connected', expectedRevision: 2, state: 'paused',
    })).rejects.toThrow('Stale Agent Connection');
  });

  it('updates assignment and appends the matching snapshot in one transaction', async () => {
    const sql = new FakeSql([[{ id: 'assignment-1', revision: 8, updated_at: new Date() }]]);
    await expect(new AgentManagerStore(sql).reviseAssignment({
      userId, accountId, expectedRevision: 7,
      manager: { kind: 'agent_connection', connectionId }, automaticProcessingEnabled: true,
    })).resolves.toBe(8);
    expect(sql.transactions).toBe(1);
    expect(sql.calls[0]?.statement).toContain('revision = revision + 1');
    expect(sql.calls[0]?.statement).toContain('is distinct from');
    expect(sql.calls[0]?.statement).toContain('not exists');
    expect(sql.calls[0]?.statement).toContain('agent_capability_grants');
    expect(sql.calls[0]?.statement).toContain('then false else $6');
    expect(sql.calls).toHaveLength(1);
  });

  it('forces automatic processing off when reviseAssignment replaces a Manager without a grant', async () => {
    const sql = new FakeSql([[{ id: 'assignment-1', revision: 2, updated_at: new Date() }]]);
    await expect(new AgentManagerStore(sql).reviseAssignment({
      userId, accountId, expectedRevision: 1,
      manager: { kind: 'none' }, automaticProcessingEnabled: true,
    })).resolves.toBe(2);
    expect(sql.calls[0]?.statement).toContain('then false else $6');
    expect(sql.calls[0]?.values).toEqual([userId, accountId, 1, 'none', null, true]);
  });

  it('atomically disables automatic processing and requires reapproval for a replacement Manager', async () => {
    const secondConnectionId = '00000000-0000-4000-8000-000000000004';
    const sql = new FakeSql([[{ revision: 8 }], [{ revision: 12 }]]);
    await expect(new AgentManagerStore(sql).reviseAssignmentAndFenceGrant({
      userId, accountId, expectedAssignmentRevision: 7, expectedGrantRevision: 11,
      manager: { kind: 'agent_connection', connectionId: secondConnectionId },
    })).resolves.toEqual({ assignmentRevision: 8, grantRevision: 12 });
    expect(sql.transactions).toBe(1);
    expect(sql.calls[0]?.statement).toContain('automatic_processing_enabled = false');
    expect(sql.calls[0]?.statement).toContain('revision = $3');
    expect(sql.calls[1]?.statement).toContain("state = 'reapproval_required'");
    expect(sql.calls[1]?.statement).toContain('revision = $3');
    expect(sql.calls[1]?.values).toEqual([userId, accountId, 11, 'agent_connection', secondConnectionId]);
  });

  it('atomically assigns no Manager and revokes rather than retargeting the old grant', async () => {
    const sql = new FakeSql([[{ revision: 3 }], [{ revision: 6 }]]);
    await expect(new AgentManagerStore(sql).reviseAssignmentAndFenceGrant({
      userId, accountId, expectedAssignmentRevision: 2, expectedGrantRevision: 5,
      manager: { kind: 'none' }, automaticProcessingEnabled: true,
    })).resolves.toEqual({ assignmentRevision: 3, grantRevision: 6 });
    expect(sql.calls[0]?.values).toEqual([userId, accountId, 2, 'none', null]);
    expect(sql.calls[1]?.statement).toContain("state = 'revoked'");
    expect(sql.calls[1]?.statement).not.toContain('set manager_kind');
    expect(sql.calls[1]?.values).toEqual([userId, accountId, 5]);
  });

  it('fails closed when either side of the assignment and grant CAS is stale', async () => {
    const staleGrant = new FakeSql([[{ revision: 3 }], []]);
    await expect(new AgentManagerStore(staleGrant).reviseAssignmentAndFenceGrant({
      userId, accountId, expectedAssignmentRevision: 2, expectedGrantRevision: 5,
      manager: { kind: 'none' },
    })).rejects.toThrow('Stale assignment or capability grant revision');
    expect(staleGrant.calls).toHaveLength(2);
  });

});
