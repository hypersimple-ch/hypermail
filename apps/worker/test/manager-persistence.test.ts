/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
import { randomUUID } from 'node:crypto';
import { AgentManagerStore, type SqlClient } from '@hypermail/db';
import type { Sql } from 'postgres';
import { expect, it } from 'vitest';
import { withPostgresSchemas } from './postgres-test.js';

function client(connection: Sql): SqlClient {
  return {
    query: async <Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) => ({
      rows: await connection.unsafe(statement, values as never[]) as Row[],
    }),
    transaction: async <T>(operation: (transaction: SqlClient) => Promise<T>) =>
      connection.begin((transaction) => operation(client(transaction))),
  };
}

it.skipIf(!process.env.DATABASE_URL)('enforces tenant-safe Manager revisions in PostgreSQL', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await withPostgresSchemas(databaseUrl, async sql => {
    const userId = randomUUID(); const otherUserId = randomUUID(); const accountId = randomUUID();
    const connectionId = randomUUID();
    await sql.unsafe(`insert into app.users (id, email, password_hash) values ($1, $2, 'test'), ($3, $4, 'test')`,
      [userId, `${userId}@example.test`, otherUserId, `${otherUserId}@example.test`]);
    await sql.unsafe(`insert into app.user_agent_preferences (user_id, default_manager_kind) values ($1, 'mastra')`, [userId]);
    await sql.begin(async transaction => {
      await transaction.unsafe(`insert into app.accounts (id, user_id, provider, provider_account_id, email) values ($1, $4, 'gmail', $2, $3)`,
        [accountId, accountId, `${accountId}@example.test`, userId]);
      await transaction.unsafe(`insert into app.user_accounts (user_id, account_id) values ($1, $2)`, [userId, accountId]);
    });
    const duplicateAccountId = randomUUID();
    await expect(sql.begin(async transaction => {
      await transaction.unsafe(
        `insert into app.accounts (id, user_id, provider, provider_account_id, email) values ($1, $2, 'gmail', $3, $4)`,
        [duplicateAccountId, otherUserId, accountId, `${accountId}@example.test`],
      );
      await transaction.unsafe(`insert into app.user_accounts (user_id, account_id) values ($1, $2)`, [otherUserId, duplicateAccountId]);
    })).resolves.toBeUndefined();
    const replacementAccountId = randomUUID();
    await expect(sql.begin(async transaction => {
      await transaction.unsafe(
        `insert into app.accounts (id, user_id, provider, provider_account_id, email) values ($1, $2, 'imap', $3, $4)`,
        [replacementAccountId, userId, replacementAccountId, `${replacementAccountId}@example.test`],
      );
      await transaction.unsafe(`update app.user_accounts set account_id = $1 where user_id = $2 and account_id = $3`, [replacementAccountId, userId, accountId]);
    })).rejects.toThrow(/exactly one matching ownership edge/);
    await expect(sql.begin(transaction => transaction.unsafe(
      `delete from app.user_accounts where user_id = $1 and account_id = $2`, [userId, accountId],
    ))).rejects.toThrow(/exactly one matching ownership edge/);
    expect((await sql.unsafe(`select count(*)::int as count from app.user_accounts where account_id = $1`, [accountId]))[0]?.count).toBe(1);

    const store = new AgentManagerStore(client(sql));
    await store.assignCurrentDefault(userId, accountId);
    expect((await sql.unsafe(`select manager_kind, revision from app.mailbox_manager_assignments where user_id = $1 and account_id = $2`, [userId, accountId]))[0]).toMatchObject({ manager_kind: 'mastra', revision: 1 });
    expect((await sql.unsafe(`select count(*)::int as count from app.mailbox_manager_assignment_revisions`))[0]?.count).toBe(1);

    const ownedConnectionId = randomUUID();
    await sql.unsafe(`insert into app.agent_connections (id, user_id, adapter, external_profile_id, display_name, verified_at) values ($1, $2, 'hermes', 'owned-profile', 'Owned Hermes', now())`, [ownedConnectionId, userId]);
    await expect(store.reviseAssignment({
      userId, accountId, expectedRevision: 1,
      manager: { kind: 'agent_connection', connectionId: ownedConnectionId }, automaticProcessingEnabled: true,
    })).resolves.toBe(2);
    expect((await sql.unsafe(`select count(*)::int as count from app.mailbox_manager_assignment_revisions`))[0]?.count).toBe(2);

    await sql.unsafe(`insert into app.agent_connections (id, user_id, adapter, external_profile_id, display_name, verified_at) values ($1, $2, 'hermes', 'profile', 'Hermes', now())`, [connectionId, otherUserId]);
    await expect(store.reviseAssignment({
      userId, accountId, expectedRevision: 2,
      manager: { kind: 'agent_connection', connectionId }, automaticProcessingEnabled: false,
    })).rejects.toThrow();
    expect((await sql.unsafe(`select manager_kind, revision from app.mailbox_manager_assignments where user_id = $1 and account_id = $2`, [userId, accountId]))[0]).toMatchObject({ manager_kind: 'agent_connection', revision: 2 });

    await expect(sql.unsafe(`update app.mailbox_manager_assignment_revisions set automatic_processing_enabled = true`)).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`delete from app.mailbox_manager_assignment_revisions`)).rejects.toThrow(/append-only/);
  });
});
