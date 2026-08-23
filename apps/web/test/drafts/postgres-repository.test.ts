import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deterministicMailboxMemoryEventId } from '@hypermail/db';
import { withPostgresSchemas } from '../../../worker/test/postgres-test.js';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { DraftService, PostgresDraftRepository, type ApprovalClaim, type DraftScope } from '../../src/drafts/index.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../../src/activity/postgres-repository.js';

const canonicalJson = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
const accountId = '00000000-0000-4000-8000-000000000001';
const draftId = '00000000-0000-4000-8000-000000000002';
const approvalId = '00000000-0000-4000-8000-000000000003';
const scope: DraftScope = { subjectId: '00000000-0000-4000-8000-000000000004', accountIds: [accountId] };
const draftRow = (state: 'sent' | 'failed'): SqlRow => ({
  id: draftId, account_id: accountId, source_message_id: null, created_by: 'user', state, version: 2,
  created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:01:00.000Z', recipients: [{ kind: 'to', address: 'person@example.com' }], subject: 'Hello', body: 'Body', body_format: 'html',
});
const claim: ApprovalClaim = {
  approval: { id: approvalId, draftId, draftVersion: 1, userId: scope.subjectId, confirmationHash: 'hash', idempotencyKey: `send:${approvalId}:${draftId}:1`, expiresAt: '2025-01-01T00:10:00.000Z' },
  draft: { ...draftRow('sending'), id: draftId, accountId, sourceMessageId: null, createdBy: 'user', state: 'sending', version: 1, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', recipients: [{ kind: 'to', address: 'person@example.com' }], subject: 'Hello', body: 'Body', bodyFormat: 'html' },
};

class RecordingSql implements SqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  constructor(private readonly responses: readonly SqlQueryResult[]) {}
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return Promise.resolve((this.responses[this.calls.length - 1] ?? { rows: [] }) as SqlQueryResult<Row>);
  }
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> { return work(this); }
}

describe('PostgresDraftRepository learning transitions', () => {
  it('does not learn an unconfirmed agent-created draft', async () => {
    const created = { ...draftRow('failed'), created_by: 'agent', state: 'editing', version: 1 };
    const sql = new RecordingSql([{ rows: [created] }, { rows: [] }, { rows: [] }]);
    await expect(new PostgresDraftRepository(sql).create(scope, { accountId, sourceMessageId: null, createdBy: 'agent', state: 'editing',
      recipients: [{ kind: 'to', address: 'person@example.com' }], subject: 'Proposal', body: 'Unconfirmed', bodyFormat: 'markdown' }))
      .resolves.toMatchObject({ createdBy: 'agent', version: 1 });
    expect(sql.calls.some(({ text }) => text.includes('mailbox_memory_events'))).toBe(false);
  });

  it('does not learn an unconfirmed agent-only edit', async () => {
    const before = { ...draftRow('failed'), created_by: 'agent', state: 'editing', version: 1, body: 'First proposal' };
    const after = { ...before, version: 2, body: 'Second proposal' };
    const sql = new RecordingSql([{ rows: [before] }, { rows: [after] }, { rows: [] }, { rows: [] }]);
    await expect(new PostgresDraftRepository(sql).edit(scope, draftId, 1, { recipients: [{ kind: 'to', address: 'person@example.com' }],
      subject: 'Proposal', body: 'Second proposal', bodyFormat: 'markdown' }, 'agent'))
      .resolves.toMatchObject({ kind: 'updated', draft: { version: 2 } });
    expect(sql.calls.some(({ text }) => text.includes('mailbox_memory_events'))).toBe(false);
  });

  it('records bounded before/after evidence when a user corrects an agent draft', async () => {
    const before = { ...draftRow('failed'), created_by: 'agent', state: 'editing', version: 1, updated_at: '2025-01-01T00:00:00.000Z', body: 'Agent wording' };
    const after = { ...before, version: 2, updated_at: '2025-01-01T00:01:00.000Z', body: 'User wording' };
    const evidence = (value: string) => ({ text: value, digest: createHash('sha256').update(value).digest('hex'), truncated: false });
    const fields = (body: string) => ({ recipients: [{ kind: 'to', address: 'person@example.com' }], subject: evidence('Hello'), body: evidence(body), bodyFormat: 'html' });
    const contentPayload = { outcome: 'corrected', creator: 'agent', editor: 'user', before: fields('Agent wording'), after: fields('User wording') };
    const eventId = deterministicMailboxMemoryEventId({ userId: scope.subjectId, mailboxId: accountId, sourceType: 'draft', sourceId: draftId, sourceVersion: 2, kind: 'draft_corrected' });
    const event = { id: eventId, user_id: scope.subjectId, account_id: accountId, source_type: 'draft', source_id: draftId, source_version: 2,
      kind: 'draft_corrected', content_digest: createHash('sha256').update(canonicalJson(contentPayload)).digest('hex'), content_payload: contentPayload,
      state: 'pending', attempt_count: 0, claim_generation: 0, available_at: after.updated_at, occurred_at: after.updated_at,
      completed_at: null, cancelled_at: null, result_metadata: null, last_error_code: null, last_error_metadata: null, created_at: after.updated_at, updated_at: after.updated_at };
    const sql = new RecordingSql([{ rows: [before] }, { rows: [after] }, { rows: [] }, { rows: [] }, { rows: [event] }]);
    await expect(new PostgresDraftRepository(sql).edit(scope, draftId, 1, { recipients: [{ kind: 'to', address: 'person@example.com' }], subject: 'Hello', body: 'User wording' }, 'user'))
      .resolves.toMatchObject({ kind: 'updated', draft: { version: 2 } });
    expect(sql.calls[4]?.values?.[6]).toBe('draft_corrected');
    expect(sql.calls[4]?.values?.[8]).toEqual(contentPayload);
  });
});

describe('PostgresDraftRepository send completion', () => {
  it('casts completion state to the migrated draft enum and persists provider failures visibly', async () => {
    const contentPayload = { outcome: 'failed', draftId, draftVersion: 1 };
    const occurredAt = '2025-01-01T00:01:00.000Z';
    const eventId = deterministicMailboxMemoryEventId({ userId: scope.subjectId, mailboxId: accountId, sourceType: 'send_approval', sourceId: approvalId, sourceVersion: 1, kind: 'send_failed' });
    const contentDigest = createHash('sha256').update(`{"draftId":"${draftId}","draftVersion":1,"outcome":"failed"}`).digest('hex');
    const sql = new RecordingSql([{ rows: [draftRow('failed')] }, { rows: [] }, { rows: [{ id: eventId, user_id: scope.subjectId, account_id: accountId, source_type: 'send_approval', source_id: approvalId, source_version: 1, kind: 'send_failed', content_digest: contentDigest, content_payload: contentPayload, state: 'pending', attempt_count: 0, claim_generation: 0, available_at: occurredAt, occurred_at: occurredAt, completed_at: null, cancelled_at: null, result_metadata: null, last_error_code: null, last_error_metadata: null, created_at: occurredAt, updated_at: occurredAt }] }]);
    const result = await new PostgresDraftRepository(sql).completeSend(scope, claim, 'failed');
    expect(result).toMatchObject({ state: 'failed', body: 'Body', bodyFormat: 'html', version: 2 });
    const update = sql.calls[0] ?? { text: '', values: [] };
    expect(update.text).toContain('state = $1::app.draft_state');
    expect(update.values).toEqual(['failed', draftId, [accountId]]);
    expect((sql.calls[1] ?? { values: [] }).values).toContain('send.failed');
    expect(sql.calls[2]?.values?.[0]).toBe(eventId);
    expect(sql.calls[2]?.values?.[8]).toEqual(contentPayload);
  });

  it('persists HTML format in the draft row and immutable revision snapshot', async () => {
    const editing = { ...draftRow('failed'), state: 'editing', body: '<p>Body</p>', version: 1 };
    const evidence = (value: string) => ({ text: value, digest: createHash('sha256').update(value).digest('hex'), truncated: false });
    const recipients = [{ kind: 'to', address: 'person@example.com' }]; const occurredAt = '2025-01-01T00:00:00.000Z';
    const payload = { outcome: 'created', actor: 'user', after: { recipients, subject: evidence('Hello'), body: evidence('<p>Body</p>'), bodyFormat: 'html' } };
    const eventId = deterministicMailboxMemoryEventId({ userId: scope.subjectId, mailboxId: accountId, sourceType: 'draft', sourceId: draftId, sourceVersion: 1, kind: 'draft_created' });
    const event = { id: eventId, user_id: scope.subjectId, account_id: accountId, source_type: 'draft', source_id: draftId, source_version: 1,
      kind: 'draft_created', content_digest: createHash('sha256').update(canonicalJson(payload)).digest('hex'), content_payload: payload,
      state: 'pending', attempt_count: 0, claim_generation: 0, available_at: occurredAt, occurred_at: occurredAt,
      completed_at: null, cancelled_at: null, result_metadata: null, last_error_code: null, last_error_metadata: null, created_at: occurredAt, updated_at: occurredAt };
    const sql = new RecordingSql([{ rows: [editing] }, { rows: [] }, { rows: [] }, { rows: [event] }]);
    const result = await new PostgresDraftRepository(sql).create(scope, { accountId, sourceMessageId: null, createdBy: 'user', state: 'editing', recipients: [{ kind: 'to', address: 'person@example.com' }], subject: 'Hello', body: '<p>Body</p>', bodyFormat: 'html' });
    expect(result.bodyFormat).toBe('html');
    expect(sql.calls[0]?.text).toContain('body_format');
    expect(sql.calls[0]?.values?.at(-1)).toBe('html');
    expect(JSON.parse(String(sql.calls[1]?.values?.[2]))).toMatchObject({ body: '<p>Body</p>', bodyFormat: 'html' });
  });

  it('migrates existing draft rows and legacy revision snapshots to markdown', async () => {
    const migration = await readFile(resolve(process.cwd(), 'packages/db/drizzle/0013_draft_body_format.sql'), 'utf8');
    expect(migration).toContain("body_format text DEFAULT 'markdown' NOT NULL");
    expect(migration).toContain(`jsonb_set(snapshot, '{bodyFormat}', '"markdown"'::jsonb`);
  });



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
      await sql.begin(async (tx) => {
        await tx`INSERT INTO app.users (id, email, password_hash) VALUES (${userId}::uuid, ${`draft-${userId}@example.test`}, 'test')`;
        await tx`INSERT INTO app.accounts (id, user_id, provider, provider_account_id, email, state) VALUES (${seededAccountId}::uuid, ${userId}, 'gmail', ${seededAccountId}, ${`account-${seededAccountId}@example.test`}, 'ready')`;
        await tx`INSERT INTO app.user_accounts(user_id,account_id) VALUES (${userId},${seededAccountId})`;
      });
      const providerCalls: string[] = [];
      let sequence = 0;
      const service = new DraftService(new PostgresDraftRepository(client(sql)), {
        send: (message) => { providerCalls.push(message.approvalId); return Promise.resolve({ providerMessageId: 'provider-message' }); },
        status: () => Promise.resolve({ state: 'verified' as const, providerMessageId: 'provider-message', observedAt: '2025-01-01T00:01:01.000Z', evidence: { source: 'readback' } }),
      }, { read: () => Promise.resolve(null) }, () => new Date('2025-01-01T00:01:00.000Z'), () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
      const seededScope: DraftScope = { subjectId: userId, accountIds: [seededAccountId], freshAuthAt: '2025-01-01T00:00:00.000Z' };
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
  });
});
