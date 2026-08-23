import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createPostgresClient, PostgresMailboxMemoryEventStore } from '../src/index.js';
import { withPostgresSchemas } from '../../../apps/worker/test/postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresUrl = databaseUrl ?? '';
const occurredAt = '2026-08-21T12:00:00.000Z';
const timing = { retryBaseDelaySeconds: 5, retryMaximumDelaySeconds: 900, claimLeaseSeconds: 60, schedulerIntervalSeconds: 5 };

async function seedTenant(sql: Sql) {
  const userId = randomUUID(); const mailboxId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'hash')`;
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state)
      values(${mailboxId},${userId},'microsoft',${`provider-${mailboxId}`},${`${mailboxId}@example.test`},'ready')`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${mailboxId})`;
  });
  return { userId, mailboxId };
}

// This test is intentionally one serial scenario: the shared migration helper resets schemas.
describe('Mailbox-memory event PostgreSQL integration', () => {
  it.skipIf(!databaseUrl)('enforces tenant ownership, idempotent replay, fenced concurrency, and completion minimization', async () => {
    await withPostgresSchemas(postgresUrl, async (sql) => {
      const tenant = await seedTenant(sql); const other = await seedTenant(sql);
      const firstClient = createPostgresClient(postgresUrl); const secondClient = createPostgresClient(postgresUrl);
      const first = new PostgresMailboxMemoryEventStore(firstClient, timing); const second = new PostgresMailboxMemoryEventStore(secondClient, timing);
      const sourceId = randomUUID(); const eventId = randomUUID();
      const input = { id: eventId, ...tenant, sourceType: 'message', sourceId, sourceVersion: 1,
        kind: 'retain_email', contentPayload: { canonicalMessageId: sourceId, content: 'needed until retain completes' },
        occurredAt };
      try {
        await expect(first.enqueue(input)).resolves.toMatchObject({ id: eventId, state: 'pending' });
        await expect(first.enqueue({ ...input, id: randomUUID() })).resolves.toMatchObject({ id: eventId });
        expect(await sql`select count(*)::integer as count from app.mailbox_memory_events
          where user_id=${tenant.userId} and account_id=${tenant.mailboxId}`).toEqual([{ count: 1 }]);
        await expect(first.enqueue({ ...input, id: randomUUID(), contentPayload: { canonicalMessageId: sourceId, content: 'changed replay' } }))
          .rejects.toThrow('different immutable content');

        await expect(sql`insert into app.mailbox_memory_events
          (id,user_id,account_id,source_type,source_id,source_version,kind,content_digest,content_payload,available_at,occurred_at)
          values(${randomUUID()},${tenant.userId},${other.mailboxId},'message',${randomUUID()},1,'retain_email',${'a'.repeat(64)},${sql.json({})},${occurredAt},${occurredAt})`)
          .rejects.toThrow();

        const concurrentClaims = await Promise.all([
          first.claim({ workerId: 'memory-worker-a', limit: 1 }),
          second.claim({ workerId: 'memory-worker-b', limit: 1 }),
        ]);
        expect(concurrentClaims.flat()).toHaveLength(1);
        const claim = concurrentClaims.flat()[0];
        expect(claim).toBeDefined();
        if (!claim) throw new Error('Expected one Mailbox-memory claim.');

        await expect(first.renew(claim.fence)).resolves.toBeUndefined();
        await expect(first.complete({ ...claim.fence, userId: other.userId, mailboxId: other.mailboxId }, { documentId: `event-${eventId}` }))
          .rejects.toThrow('tenant scope');
        await expect(first.complete(claim.fence, { documentId: `event-${eventId}` })).resolves.toMatchObject({
          state: 'completed', contentPayload: null, userId: tenant.userId, mailboxId: tenant.mailboxId,
        });
        await expect(second.complete(claim.fence, { documentId: `event-${eventId}` })).resolves.toMatchObject({ state: 'completed' });

        expect(await sql`select state,content_payload,attempt_count,claim_generation from app.mailbox_memory_events where id=${eventId}`)
          .toEqual([{ state: 'completed', content_payload: null, attempt_count: 1, claim_generation: 1 }]);

        const retryId = randomUUID();
        await first.enqueue({ ...input, id: retryId, sourceId: randomUUID(), kind: 'retain_attachment_metadata',
          contentPayload: { mediaType: 'application/pdf', sizeBytes: 42 } });
        const retryClaim = (await first.claim({ workerId: 'memory-worker-a', limit: 1 }))[0];
        if (!retryClaim) throw new Error('Expected retry claim.');
        const deferred = await first.defer(retryClaim.fence, { code: 'HINDSIGHT_UNAVAILABLE', metadata: { retryable: true } });
        expect(deferred).toMatchObject({ state: 'pending', attemptCount: 1, lastErrorCode: 'HINDSIGHT_UNAVAILABLE' });
        expect(new Date(deferred.availableAt).valueOf() - new Date(deferred.updatedAt).valueOf()).toBeGreaterThanOrEqual(4_900);
        expect(new Date(deferred.availableAt).valueOf() - new Date(deferred.updatedAt).valueOf()).toBeLessThanOrEqual(5_100);

        const indefiniteRetryId = randomUUID();
        await first.enqueue({ ...input, id: indefiniteRetryId, sourceId: randomUUID(), kind: 'retain_question_answer',
          contentPayload: { answerDigest: 'b'.repeat(64) } });
        const indefiniteRetryClaim = (await first.claim({ workerId: 'memory-worker-a', limit: 1 }))[0];
        if (!indefiniteRetryClaim) throw new Error('Expected retryable claim.');
        await expect(first.defer(indefiniteRetryClaim.fence, { code: 'HINDSIGHT_UNAVAILABLE' })).resolves.toMatchObject({
          state: 'pending', contentPayload: { answerDigest: 'b'.repeat(64) }, attemptCount: 1,
        });
        await expect(second.defer(indefiniteRetryClaim.fence, { code: 'HINDSIGHT_UNAVAILABLE' })).resolves.toMatchObject({ state: 'pending' });
        await expect(first.complete(indefiniteRetryClaim.fence)).rejects.toThrow('stale');

        await expect(sql`update app.mailbox_memory_events set source_id=${randomUUID()} where id=${eventId}`).rejects.toThrow('identity is immutable');
        await expect(sql`delete from app.mailbox_memory_events where id=${eventId}`).rejects.toThrow('append-only');

        const sameSourceOtherMailbox = await second.enqueue({ ...input, id: randomUUID(), userId: other.userId,
          mailboxId: other.mailboxId, contentPayload: { canonicalMessageId: sourceId, content: 'other tenant content' } });
        expect(sameSourceOtherMailbox).toMatchObject({ userId: other.userId, mailboxId: other.mailboxId, sourceId });
      } finally {
        await Promise.all([firstClient.close(), secondClient.close()]);
      }
    });
  }, 30_000);
});
