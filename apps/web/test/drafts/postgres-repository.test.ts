import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { DraftService, PostgresDraftRepository, type ApprovalClaim, type DraftScope } from '../../src/drafts/index.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../../src/activity/postgres-repository.js';

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

describe('PostgresDraftRepository send completion', () => {
  it('casts completion state to the migrated draft enum and persists provider failures visibly', async () => {
    const sql = new RecordingSql([{ rows: [draftRow('failed')] }, { rows: [] }]);
    const result = await new PostgresDraftRepository(sql).completeSend(scope, claim, 'failed');
    expect(result).toMatchObject({ state: 'failed', body: 'Body', bodyFormat: 'html', version: 2 });
    const update = sql.calls[0] ?? { text: '', values: [] };
    expect(update.text).toContain('state = $1::app.draft_state');
    expect(update.values).toEqual(['failed', draftId, [accountId]]);
    expect((sql.calls[1] ?? { values: [] }).values).toContain('send.failed');
  });

  it('persists HTML format in the draft row and immutable revision snapshot', async () => {
    const editing = { ...draftRow('failed'), state: 'editing', body: '<p>Body</p>', version: 1 };
    const sql = new RecordingSql([{ rows: [editing] }, { rows: [] }, { rows: [] }]);
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

  it.skipIf(!process.env.DATABASE_URL)('runs completion and reused confirmation text against migrated PostgreSQL FKs', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const sql = postgres(databaseUrl);
    const client = (connection: Sql): SqlClient => ({
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- required by SqlClient.
      query: async <Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]) => ({ rows: await (values === undefined ? connection.unsafe(text) : connection.unsafe(text, values as never[])) as readonly Row[] }),
      transaction: async <T>(work: (transaction: SqlClient) => Promise<T>) => connection.begin((transaction) => work(client(transaction))),
    });
    try {
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await sql.unsafe('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mastra CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE');
      const migration = await readFile(resolve(process.cwd(), 'packages/db/drizzle/0000_solid_lady_deathstrike.sql'), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
      const userId = randomUUID(); const seededAccountId = randomUUID();
      await sql`INSERT INTO app.users (id, email, password_hash) VALUES (${userId}::uuid, ${`draft-${userId}@example.test`}, 'test')`;
      await sql`INSERT INTO app.accounts (id, provider, provider_account_id, email) VALUES (${seededAccountId}::uuid, 'gmail', ${seededAccountId}, ${`account-${seededAccountId}@example.test`})`;
      const providerCalls: string[] = [];
      let sequence = 0;
      const service = new DraftService(new PostgresDraftRepository(client(sql)), { send: (message) => { providerCalls.push(message.approvalId); return Promise.resolve({ providerMessageId: 'provider-message' }); } }, { read: () => Promise.resolve(null) }, () => new Date('2025-01-01T00:01:00.000Z'), () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
      const seededScope: DraftScope = { subjectId: userId, accountIds: [seededAccountId], freshAuthAt: '2025-01-01T00:00:00.000Z' };
      const input = { accountId: seededAccountId, createdBy: 'user' as const, recipients: [{ kind: 'to' as const, address: 'person@example.com' }], subject: 'Hello', body: 'Body', bodyFormat: 'markdown' as const };
      const first = await service.createUser(seededScope, input); const second = await service.createUser(seededScope, input);
      const confirmation = 'r'.repeat(16);
      const firstApproval = await service.beginApproval(seededScope, first.id, 1, confirmation);
      const secondApproval = await service.beginApproval(seededScope, second.id, 1, confirmation);
      expect(secondApproval.approvalId).not.toBe(firstApproval.approvalId);
      expect(await service.confirmSend(seededScope, firstApproval.approvalId, confirmation)).toMatchObject({ state: 'sent' });
      expect(providerCalls).toEqual([firstApproval.approvalId]);
    } finally {
      await sql.unsafe('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mastra CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE');
      await sql.end();
    }
  });
});
