/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-parameters */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPostgresClient, type ManagedSqlClient } from '@hypermail/db';
import { permanentlyDeleteMailboxMemory } from '../src/mailbox-memory-deletion.js';
import { withPostgresSchemas } from './postgres-test.js';

const userId = '00000000-0000-4000-8000-000000000001';
const mailboxId = '00000000-0000-4000-8000-000000000002';

function database() {
  const statements: string[] = []; let completed = false;
  const client: ManagedSqlClient = {
    query: async <Row extends Record<string, unknown>>(statement: string) => {
      statements.push(statement);
      if (statement.includes('select a.state')) return { rows: [{ state: 'ready' }] as Row[] };
      if (statement.includes("event='mailbox_memory.deleted'")) return { rows: [{ found: completed }] as Row[] };
      if (statement.includes("'mailbox_memory.deleted'")) completed = true;
      return { rows: [] as Row[] };
    },
    transaction: async <T>(work: (sql: ManagedSqlClient) => Promise<T>) => work(client),
    close: () => Promise.resolve(),
  };
  return { client, statements };
}

describe('permanent Mailbox memory deletion', () => {
  it('requires a stopped worker, disables the owned Mailbox, removes producers, deletes once and audits', async () => {
    const db = database(); let deletes = 0;
    const input = { database: db.client, memory: { deleteMailbox: () => { deletes++; return Promise.resolve(); } }, userId, mailboxId };
    await expect(permanentlyDeleteMailboxMemory({ ...input, workerStopped: false })).rejects.toThrow('REQUIRES_STOPPED_WORKER');
    await expect(permanentlyDeleteMailboxMemory({ ...input, workerStopped: true })).resolves.toMatchObject({ alreadyDeleted: false });
    await expect(permanentlyDeleteMailboxMemory({ ...input, workerStopped: true })).resolves.toMatchObject({ alreadyDeleted: true });
    expect(deletes).toBe(1);
    expect(db.statements.some((sql) => sql.includes("set state='disabled'"))).toBe(true);
    expect(db.statements.some((sql) => sql.includes("set state='cancelled'") && sql.includes('content_payload=null'))).toBe(true);
    expect(db.statements.some((sql) => sql.includes('delete from app.mailbox_memory_events'))).toBe(false);
    expect(db.statements.some((sql) => sql.includes("'mailbox_memory.delete_requested'"))).toBe(true);
    expect(db.statements.some((sql) => sql.includes("'mailbox_memory.deleted'"))).toBe(true);
  });
  it.skipIf(!process.env.DATABASE_URL)('atomically disables ownership, cancels replayable events, preserves completed history, and audits exact-bank deletion', async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL required');
    await withPostgresSchemas(url, async (sql) => {
      const user = randomUUID(); const mailbox = randomUUID(); const otherUser = randomUUID(); const otherMailbox = randomUUID();
      const pending = randomUUID(); const processing = randomUUID(); const completed = randomUUID(); const otherPending = randomUUID();
      await sql.begin(async tx => {
        for (const [owner, account] of [[user, mailbox], [otherUser, otherMailbox]] as const) {
          await tx`insert into app.users(id,email,password_hash) values(${owner},${`${owner}@example.test`},'hash')`;
          await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${account},${owner},'gmail',${account},${`${account}@example.test`},'ready')`;
          await tx`insert into app.user_accounts(user_id,account_id) values(${owner},${account})`;
        }
        for (const [id, owner, account, payload] of [[pending,user,mailbox,'pending secret'],[processing,user,mailbox,'processing secret'],[completed,user,mailbox,'completed secret'],[otherPending,otherUser,otherMailbox,'other secret']] as const) {
          await tx`insert into app.mailbox_memory_events(id,user_id,account_id,source_type,source_id,source_version,kind,content_digest,content_payload,available_at,occurred_at)
            values(${id},${owner},${account},'message',${id},1,'email_received',${'a'.repeat(64)},${tx.json({message:payload})},now(),now())`;
        }
        await tx`update app.mailbox_memory_events set state='processing',attempt_count=1,claim_generation=1,claim_token=${randomUUID()},claim_worker='worker',claimed_at=now(),claim_expires_at=now()+interval '1 hour' where id in (${processing},${completed})`;
        await tx`update app.mailbox_memory_events set state='completed',content_payload=null,result_metadata=${tx.json({retained:true})},completed_at=now(),claim_worker=null,claimed_at=null,claim_expires_at=null where id=${completed}`;
      });
      const completedBefore = (await sql<Record<string, unknown>[]>`select * from app.mailbox_memory_events where id=${completed}`)[0];
      const client = createPostgresClient(url); let deleted = 0;
      try {
        await permanentlyDeleteMailboxMemory({ database: client, memory: { deleteMailbox: () => { deleted++; return Promise.resolve(); } },
          userId: user, mailboxId: mailbox, workerStopped: true });
        expect(deleted).toBe(1);
        expect(await sql`select state from app.accounts where id=${mailbox}`).toEqual([{ state: 'disabled' }]);
        expect(await sql`select id,state,content_payload,last_error_code,cancelled_at is not null as cancelled from app.mailbox_memory_events where id in (${pending},${processing}) order by id`)
          .toEqual([pending, processing].sort().map(id => ({ id, state: 'cancelled', content_payload: null, last_error_code: 'OWNER_MEMORY_DELETION', cancelled: true })));
        expect((await sql<Record<string, unknown>[]>`select * from app.mailbox_memory_events where id=${completed}`)[0]).toEqual(completedBefore);
        expect(await sql`select state,content_payload from app.mailbox_memory_events where id=${otherPending}`).toEqual([{ state: 'pending', content_payload: { message: 'other secret' } }]);
        expect(await sql<{event:string}[]>`select event from app.audits where account_id=${mailbox} order by occurred_at,id`)
          .toEqual([{ event: 'mailbox_memory.delete_requested' }, { event: 'mailbox_memory.deleted' }]);
      } finally { await client.close(); }
    });
  }, 30_000);

});
