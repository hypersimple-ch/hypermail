/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresIngestionStore, type SqlClient } from '../src/postgres-store.js';
import { withPostgresSchemas } from './postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;

const clientFor = (sql: Sql): SqlClient => ({
  query: async <Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) =>
    ({ rows: [...await sql.unsafe<Row[]>(statement, [...values] as never[])] }),
  transaction: <T>(operation: (client: SqlClient) => Promise<T>) => sql.begin((tx) => operation(clientFor(tx))),
});

async function tenant(sql: Sql) {
  const userId = randomUUID(); const accountId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'hash')`;
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state,baseline_completed_at)
      values(${accountId},${userId},'gmail',${`provider-${accountId}`},${`${accountId}@example.test`},'ready',${'2026-01-01T00:00:00.000Z'})`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
  });
  return { userId, accountId, email: `${accountId}@example.test` };
}

describe('arrival Mailbox-memory outbox PostgreSQL integration', () => {
  it.skipIf(!databaseUrl)('enqueues only a newly accepted post-baseline Activity and isolates duplicate/tenant replay', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async (sql) => {
      const first = await tenant(sql); const other = await tenant(sql);
      const store = new PostgresIngestionStore(clientFor(sql));
      const observedAt = new Date('2026-01-02T00:00:00.000Z');
      const arrival = { accountId: first.accountId, observedAt, message: { id: 'new-provider-message', account: first.email,
        subject: 'new', receivedAt: observedAt.toISOString(), attachments: [{ id: 'pdf-1', name: 'document.pdf', contentType: 'application/pdf', size: 3 }] } };
      await store.recordArrival(arrival);
      await store.recordArrival(arrival);
      expect(await sql`select user_id,account_id,kind,source_type from app.mailbox_memory_events`).toEqual([
        { user_id: first.userId, account_id: first.accountId, kind: 'email_received', source_type: 'message' },
      ]);
      expect(await sql`select provider_attachment_id,filename,media_type,size_bytes from app.attachments`).toEqual([
        { provider_attachment_id: 'pdf-1', filename: 'document.pdf', media_type: 'application/pdf', size_bytes: 3 },
      ]);

      await store.recordBaseline({ accountId: first.accountId, observedAt, message: { id: 'history', account: first.email, receivedAt: observedAt.toISOString() } });
      expect((await sql`select count(*)::integer as count from app.mailbox_memory_events`)[0]?.count).toBe(1);

      const reconciledMessageId = randomUUID(); const reconciledActivityId = randomUUID();
      await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,preview,received_at,is_baseline)
        values(${reconciledMessageId},${first.accountId},'already-active',${sql.json({address:'sender@example.test'})},${sql.json([])},'old','','2026-01-02T00:00:00Z',false)`;
      await sql`insert into app.activities(id,account_id,message_id,state) values(${reconciledActivityId},${first.accountId},${reconciledMessageId},'new')`;
      await store.recordArrival({ accountId: first.accountId, observedAt, message: { id: 'already-active', account: first.email, receivedAt: observedAt.toISOString() } });
      expect((await sql`select count(*)::integer as count from app.mailbox_memory_events`)[0]?.count).toBe(1);

      await store.recordArrival({ accountId: other.accountId, observedAt, message: { ...arrival.message, account: other.email } });
      expect(await sql`select user_id,count(*)::integer as count from app.mailbox_memory_events group by user_id order by user_id`)
        .toEqual([{ user_id: first.userId, count: 1 }, { user_id: other.userId, count: 1 }].sort((a, b) => a.user_id.localeCompare(b.user_id)));
    });
  }, 30_000);
});
