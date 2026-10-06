import { randomUUID } from 'node:crypto';
import { withPostgresSchemas } from '../../../worker/test/postgres-test.js';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { DraftService, PostgresDraftRepository, type DraftScope } from '../../src/drafts/index.js';
import { IntegratedApprovedSendProvider } from '@hypermail/send';
import type { SqlClient, SqlRow } from '../../src/activity/postgres-repository.js';




describe('PostgresDraftRepository durable boundaries', () => {
  it.skipIf(!process.env.DATABASE_URL)('keeps a near-limit multilingual canonical edit when auxiliary evidence is bounded', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    await withPostgresSchemas(databaseUrl, async (sql) => {
      const client = (connection: Sql): SqlClient => ({
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- required by SqlClient.
        query: async <Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]) => ({ rows: await (values === undefined ? connection.unsafe(text) : connection.unsafe(text, values as never[])) as readonly Row[] }),
        transaction: async <T>(work: (transaction: SqlClient) => Promise<T>) => connection.begin((transaction) => work(client(transaction))),
      });
      const userId = randomUUID(); const seededAccountId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO app.users (id, email, password_hash) VALUES (${userId}::uuid, ${`draft-budget-${userId}@example.test`}, 'test')`;
        await tx`INSERT INTO app.accounts (id, user_id, provider, provider_account_id, email, state) VALUES (${seededAccountId}::uuid, ${userId}, 'gmail', ${seededAccountId}, ${`account-${seededAccountId}@example.test`}, 'ready')`;
        await tx`INSERT INTO app.user_accounts(user_id,account_id) VALUES (${userId},${seededAccountId})`;
      });
      const repository = new PostgresDraftRepository(client(sql));
      const seededScope: DraftScope = { subjectId: userId, accountIds: [seededAccountId] };
      const beforeBody = '漢🙂'.repeat(300_000);
      const afterBody = '\u0001'.repeat(2_000_000);
      const created = await repository.create(seededScope, { accountId: seededAccountId, sourceMessageId: null, createdBy: 'agent', state: 'editing', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: '多言語🙂', body: beforeBody, bodyFormat: 'html' });
      const edited = await repository.edit(seededScope, created.id, 1, { recipients: created.recipients, subject: '修正版🚀', body: afterBody, bodyFormat: 'html' }, 'user');
      expect(edited).toMatchObject({ kind: 'updated', draft: { body: afterBody, bodyFormat: 'html', version: 2 } });
      const stored = (await sql<{body:string}[]>`select body from app.drafts where id=${created.id}`)[0];
      expect(stored?.body).toBe(afterBody);
      const events = await sql<{kind:string;content_payload:Record<string,unknown>;payload_bytes:number}[]>`select kind,content_payload,octet_length(content_payload::text) payload_bytes from app.mailbox_memory_events where source_id=${created.id} order by source_version`;
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('draft_corrected');
      expect(events.every((event) => event.payload_bytes <= 64 * 1024)).toBe(true);
    });
  }, 30_000);

  it.skipIf(!process.env.DATABASE_URL)('runs completion and reused confirmation text against migrated PostgreSQL FKs', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    await withPostgresSchemas(databaseUrl, async (sql) => {
      const client = (connection: Sql): SqlClient => ({
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- required by SqlClient.
        query: async <Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]) => ({ rows: await (values === undefined ? connection.unsafe(text) : connection.unsafe(text, values as never[])) as readonly Row[] }),
        transaction: async <T>(work: (transaction: SqlClient) => Promise<T>) => connection.begin((transaction) => work(client(transaction))),
      });
      const userId = randomUUID(); const seededAccountId = randomUUID();
      const sessionId = randomUUID(); const freshAuthAt = new Date().toISOString();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO app.users (id, email, password_hash) VALUES (${userId}::uuid, ${`draft-${userId}@example.test`}, 'test')`;
        await tx`INSERT INTO app.accounts (id, user_id, provider, provider_account_id, email, state) VALUES (${seededAccountId}::uuid, ${userId}, 'gmail', ${seededAccountId}, ${`account-${seededAccountId}@example.test`}, 'ready')`;
        await tx`INSERT INTO app.user_accounts(user_id,account_id) VALUES (${userId},${seededAccountId})`;
        await tx`INSERT INTO app.sessions(id,user_id,token_hash,created_at,expires_at) VALUES(${sessionId}::uuid,${userId}::uuid,${randomUUID()},${freshAuthAt}::timestamptz,now()+interval '1 hour')`;
      });
      const providerCalls: string[] = [];
      let sequence = 0;
      const provider = new IntegratedApprovedSendProvider(client(sql), userId, {
        submit: message => { providerCalls.push(message.approvalId); return Promise.resolve({ state: 'reported', reference: { kind: 'native_id', value: 'provider-message' } }); },
        verify: snapshot => Promise.resolve(providerCalls.length === 1 && snapshot.reference?.value === 'provider-message'
          ? { state: 'verified', providerMessageId: 'provider-message', observedAt: new Date().toISOString(), evidence: { source: 'readback' } }
          : { state: 'unknown', reasonCode: 'SENT_REFERENCE_NOT_OBSERVED' }),
      });
      const service = new DraftService(new PostgresDraftRepository(client(sql)), provider, { read: () => Promise.resolve(null) }, () => new Date(), () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
      const seededScope: DraftScope = { subjectId: userId, accountIds: [seededAccountId], sessionId, freshAuthAt };
      const input = { accountId: seededAccountId, createdBy: 'user' as const, recipients: [{ kind: 'to' as const, address: 'person@example.com' }], subject: 'Hello', body: 'Body', bodyFormat: 'markdown' as const };
      const first = await service.createUser(seededScope, input); const second = await service.createUser(seededScope, input);
      const confirmation = 'r'.repeat(16);
      const firstApproval = await service.beginApproval(seededScope, first.id, 1, confirmation);
      const secondApproval = await service.beginApproval(seededScope, second.id, 1, confirmation);
      expect(secondApproval.approvalId).not.toBe(firstApproval.approvalId);
      expect(await service.confirmSend(seededScope, firstApproval.approvalId, confirmation)).toMatchObject({ state: 'sent' });
      expect(providerCalls).toEqual([firstApproval.approvalId]);
      expect(await sql<{kind:string}[]>`select kind from app.mailbox_memory_events where source_id=${first.id} order by source_version,kind`)
        .toEqual([{ kind: 'draft_created' }]);
      expect(await sql<{kind:string}[]>`select kind from app.mailbox_memory_events where source_id=${firstApproval.approvalId} order by kind`)
        .toEqual([{ kind: 'send_owner_confirmed' }, { kind: 'send_verified' }]);
    });
  }, 30_000);
});
