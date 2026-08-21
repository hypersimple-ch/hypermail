/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { AgentManagerStore, CapabilityGrantStore, type SqlClient } from '@hypermail/db';
import type { Sql } from 'postgres';
import { expect, it } from 'vitest';
import { withPostgresSchemas } from './postgres-test.js';
function client(connection: Sql): SqlClient { return {
  query: async <Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) => ({ rows: await connection.unsafe(statement, values as never[]) as Row[] }),
  transaction: async <T>(operation: (transaction: SqlClient) => Promise<T>) => connection.begin(transaction => operation(client(transaction))),
}; }
it.skipIf(!process.env.DATABASE_URL)('migrates and enforces current plus append-only capability grants in PostgreSQL', async () => {
  const databaseUrl = process.env.DATABASE_URL; if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await withPostgresSchemas(databaseUrl, async sql => {
    const userId = randomUUID(), accountId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID();
    await sql.unsafe(`insert into app.users (id, email, password_hash) values ($1, $2, 'test')`, [userId, `${userId}@example.test`]);
    await sql.begin(async transaction => {
      await transaction.unsafe(`insert into app.accounts (id, user_id, provider, provider_account_id, email) values ($1, $2, 'gmail', $3, $4)`, [accountId, userId, accountId, `${accountId}@example.test`]);
      await transaction.unsafe(`insert into app.user_accounts (user_id, account_id) values ($1, $2)`, [userId, accountId]);
    });
    await sql.unsafe(`insert into app.agent_connections (id, user_id, adapter, external_profile_id, display_name, verified_at) values ($1, $2, 'hermes', $3, 'Hermes', now())`, [connectionId, userId, connectionId]);
    await sql.unsafe(`insert into app.mailbox_manager_assignments (user_id, account_id, manager_kind, agent_connection_id) values ($1, $2, 'agent_connection', $3)`, [userId, accountId, connectionId]);
    const store = new CapabilityGrantStore(client(sql));
    const created = await store.create({ id: grantId, userId, mailboxId: accountId, manager: { kind: 'agent_connection', connectionId },
      capabilities: ['mail.read', 'send.request'], invocationModes: ['interactive'], approvedAt: new Date().toISOString() });
    expect(created.revision).toBe(1);
    await expect(store.revise({ id: grantId, userId, expectedRevision: 1, manager: { kind: 'agent_connection', connectionId }, capabilities: ['mail.read'], invocationModes: ['interactive'],
      state: 'reapproval_required', approvedAt: new Date(Date.now() + 1_000).toISOString() })).resolves.toMatchObject({ revision: 2 });
    await expect(store.revise({ id: grantId, userId, expectedRevision: 1, manager: { kind: 'agent_connection', connectionId }, capabilities: ['mail.read'], invocationModes: ['interactive'],
      state: 'revoked', approvedAt: new Date().toISOString() })).rejects.toThrow('Stale');
    await expect(store.revise({ id: grantId, userId, expectedRevision: 2, manager: { kind: 'agent_connection', connectionId }, capabilities: ['mail.read'], invocationModes: ['interactive'],
      state: 'active', approvedAt: new Date().toISOString() })).rejects.toThrow('Stale');
    await expect(store.reapprove({ grantId, approverUserId: userId, expectedRevision: 2, approvalEventId: `approval-${randomUUID()}`, approvedAt: new Date().toISOString() })).resolves.toMatchObject({ revision: 3, state: 'active' });
    expect((await sql.unsafe(`select revision, state from app.agent_capability_grant_revisions where grant_id = $1 order by revision`, [grantId])).map(row => row.revision)).toEqual([1, 2, 3]);
    await expect(sql.unsafe(`delete from app.agent_capability_grant_revisions where grant_id = $1`, [grantId])).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`update app.agent_capability_grant_revisions set state = 'revoked' where grant_id = $1`, [grantId])).rejects.toThrow(/append-only/);
    const managers = new AgentManagerStore(client(sql));
    await expect(managers.reviseAssignmentAndFenceGrant({ userId, accountId, expectedAssignmentRevision: 1, expectedGrantRevision: 3,
      manager: { kind: 'mastra' }, automaticProcessingEnabled: true })).resolves.toEqual({ assignmentRevision: 2, grantRevision: 4 });
    await expect(store.reapprove({ grantId, approverUserId: userId, expectedRevision: 4, approvalEventId: `approval-${randomUUID()}`, approvedAt: new Date().toISOString() })).resolves.toMatchObject({ revision: 5, manager: { kind: 'mastra' } });
    const secondConnectionId = randomUUID();
    await sql.unsafe(`insert into app.agent_connections (id, user_id, adapter, external_profile_id, display_name, verified_at) values ($1, $2, 'hermes', $3, 'Hermes 2', now())`, [secondConnectionId, userId, secondConnectionId]);
    await expect(managers.reviseAssignmentAndFenceGrant({ userId, accountId, expectedAssignmentRevision: 2, expectedGrantRevision: 5,
      manager: { kind: 'agent_connection', connectionId: secondConnectionId }, automaticProcessingEnabled: false })).resolves.toEqual({ assignmentRevision: 3, grantRevision: 6 });
    await expect(store.reapprove({ grantId, approverUserId: userId, expectedRevision: 6, approvalEventId: `approval-${randomUUID()}`, approvedAt: new Date().toISOString() })).resolves.toMatchObject({ revision: 7, manager: { kind: 'agent_connection', connectionId: secondConnectionId } });
    await managers.reviseConnectionLifecycle({ userId, connectionId: secondConnectionId, expectedState: 'connected', expectedRevision: 1, state: 'security_revoked' });
    const reconnectEventId = `reconnect-${randomUUID()}`; const verifiedAt = new Date().toISOString();
    await managers.issueVerifiedReconnectProof({ userId, connectionId: secondConnectionId, verificationEventId: reconnectEventId, verifiedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(managers.reconnectSecurityRevoked({ userId, connectionId: secondConnectionId, expectedRevision: 2, verificationEventId: reconnectEventId, verifiedAt })).resolves.toBe(3);
    await expect(managers.reconnectSecurityRevoked({ userId, connectionId: secondConnectionId, expectedRevision: 2, verificationEventId: reconnectEventId, verifiedAt })).rejects.toThrow(/already consumed/);
    await expect(sql.unsafe(`update app.agent_capability_grants set capabilities = ARRAY['mail.read','mail.read'], revision = revision + 1 where id = $1`, [grantId])).rejects.toThrow();
    await expect(sql.unsafe(`insert into app.agent_capability_grants (user_id, account_id, manager_kind, agent_connection_id, capabilities, invocation_modes, approved_at) values ($1, $2, 'agent_connection', $3, ARRAY['send_email'], ARRAY['interactive'], now())`, [userId, accountId, connectionId])).rejects.toThrow();
  });
});
