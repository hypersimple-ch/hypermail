import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deterministicMailboxMemoryEventId, enqueueMailboxMemoryEventInTransaction, mailboxMemoryTextEvidence, PostgresMailboxMemoryEventStore, type SqlClient } from '../src/index.js';

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
const mailboxId = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000003';
const eventId = '00000000-0000-4000-8000-000000000004';
const token = '00000000-0000-4000-8000-000000000005';
const occurredAt = '2026-08-21T12:00:00.000Z';
const timing = { retryBaseDelaySeconds: 5, retryMaximumDelaySeconds: 900, claimLeaseSeconds: 60, schedulerIntervalSeconds: 5 };
const payload = { document: { subject: 'A subject', body: 'necessary until retained' }, source: 'message' };
const contentDigest = createHash('sha256').update('{"document":{"body":"necessary until retained","subject":"A subject"},"source":"message"}').digest('hex');
const baseRow = {
  id: eventId, user_id: userId, account_id: mailboxId, source_type: 'message', source_id: sourceId,
  source_version: 1, kind: 'retain_email', content_digest: contentDigest, content_payload: payload, state: 'pending',
  attempt_count: 0, claim_generation: 0, claim_token: null, claim_worker: null,
  claimed_at: null, claim_expires_at: null, available_at: new Date(occurredAt), occurred_at: new Date(occurredAt),
  completed_at: null, cancelled_at: null, result_metadata: null, last_error_code: null,
  last_error_metadata: null, created_at: new Date(occurredAt), updated_at: new Date(occurredAt),
};
const input = { id: eventId, userId, mailboxId, sourceType: 'message', sourceId, kind: 'retain_email', contentPayload: payload, occurredAt };

const processingRow = { ...baseRow, state: 'processing', attempt_count: 1, claim_generation: 1,
  claim_token: token, claim_worker: 'memory-worker-1', claimed_at: new Date(occurredAt),
  claim_expires_at: new Date('2026-08-21T12:05:00.000Z') };
const fence = { eventId, userId, mailboxId, generation: 1, token };

describe('canonical mailbox learning enqueue', () => {
  it('derives a stable UUID and inserts through the caller transaction without opening a nested transaction', async () => {
    const canonical = { userId, mailboxId, sourceType: 'draft', sourceId, sourceVersion: 2, kind: 'draft_corrected',
      contentPayload: { outcome: 'corrected' }, occurredAt } as const;
    const id = deterministicMailboxMemoryEventId(canonical);
    const digest = createHash('sha256').update('{"outcome":"corrected"}').digest('hex');
    const sql = new FakeSql([[{ ...baseRow, id, source_type: 'draft', source_version: 2, kind: 'draft_corrected',
      content_digest: digest, content_payload: canonical.contentPayload }]]);
    await expect(enqueueMailboxMemoryEventInTransaction(sql, canonical)).resolves.toMatchObject({ id, kind: 'draft_corrected' });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicMailboxMemoryEventId(canonical)).toBe(id);
    expect(sql.transactions).toBe(0);
    expect(sql.calls[0]?.values[0]).toBe(id);
  });

  it('bounds text evidence while retaining an exact digest', () => {
    expect(mailboxMemoryTextEvidence('abcdef', 3)).toEqual({
      text: 'abc', truncated: true, digest: createHash('sha256').update('abcdef').digest('hex'),
    });
    const multilingual = mailboxMemoryTextEvidence('界'.repeat(20_000));
    expect(Buffer.byteLength(multilingual.text, 'utf8')).toBeLessThanOrEqual(12 * 1024);
    expect(multilingual.truncated).toBe(true);
  });
});

describe('PostgresMailboxMemoryEventStore', () => {
  it('enqueues once by tenant-owned source identity and verifies immutable replay content', async () => {
    const sql = new FakeSql([[], [baseRow]]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).enqueue(input)).resolves.toMatchObject({ id: eventId, contentDigest, state: 'pending' });
    expect(sql.transactions).toBe(1);
    expect(sql.calls[0]?.statement).toContain('on conflict(user_id,account_id,source_type,source_id,source_version,kind) do nothing');
    expect(sql.calls[1]?.statement).toContain('for update');
    expect(sql.calls[0]?.values[8]).toEqual(payload);
  });

  it('rejects a source replay with different content without overwriting the first event', async () => {
    const sql = new FakeSql([[], [baseRow]]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).enqueue({ ...input, contentPayload: { document: { body: 'different' } } }))
      .rejects.toThrow('different immutable content');
    expect(sql.calls[0]?.statement).toContain('do nothing');
    expect(sql.calls[0]?.statement).not.toContain('do update');
  });

  it('claims with SKIP LOCKED and returns a tenant-bound generation/token fence after commit', async () => {
    const sql = new FakeSql([[processingRow]]);
    const claims = await new PostgresMailboxMemoryEventStore(sql, timing).claim({ workerId: 'memory-worker-1', limit: 2 });
    expect(sql.transactions).toBe(1);
    expect(sql.calls[0]?.statement).toContain('for update of e skip locked');
    expect(sql.calls[0]?.statement).toContain('claim_generation=e.claim_generation+1');
    expect(claims[0]).toMatchObject({ event: { id: eventId, userId, mailboxId }, fence: { eventId, userId, mailboxId, generation: 1 } });
    expect(claims[0]?.fence.token).toEqual(expect.any(String));
  });

  it('renews only the exact processing fence before long attachment operations', async () => {
    const sql = new FakeSql([[{ id: eventId }]]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).renew(fence)).resolves.toBeUndefined();
    expect(sql.calls[0]?.statement).toContain('claim_expires_at=clock_timestamp()+make_interval');
    expect(sql.calls[0]?.values).toEqual([eventId, userId, mailboxId, 1, token, 60]);
    expect(sql.calls[0]?.statement).toContain('claim_expires_at>clock_timestamp()');
  });

  it('completes only the exact tenant fence and minimizes retained content', async () => {
    const completed = { ...processingRow, state: 'completed', content_payload: null, claim_worker: null, claimed_at: null,
      claim_expires_at: null, result_metadata: { documentId: 'doc-stable-1' }, completed_at: new Date(occurredAt) };
    const sql = new FakeSql([[completed]]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).complete(fence, { documentId: 'doc-stable-1' }))
      .resolves.toMatchObject({ state: 'completed', contentPayload: null });
    expect(sql.transactions).toBe(0);
    expect(sql.calls[0]?.statement).toContain('id=$1 and user_id=$2 and account_id=$3');
    expect(sql.calls[0]?.statement).toContain('claim_generation=$4 and claim_token=$5');
  });

  it('defers indefinitely with capped exponential backoff while preserving the same fence history', async () => {
    const pending = { ...processingRow, state: 'pending', claim_worker: null, claimed_at: null,
      claim_expires_at: null, last_error_code: 'HINDSIGHT_UNAVAILABLE', last_error_metadata: { retryable: true },
      cancelled_at: null };
    const sql = new FakeSql([[pending]]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).defer(fence, { code: 'HINDSIGHT_UNAVAILABLE', metadata: { retryable: true } }))
      .resolves.toMatchObject({ state: 'pending', lastErrorCode: 'HINDSIGHT_UNAVAILABLE' });
    expect(sql.calls[0]?.statement).not.toContain("'dead_letter'");
    expect(sql.calls[0]?.statement).toContain('least($8,power(2,least(attempt_count-1,16))*$7)');
    expect(sql.calls[0]?.values).toEqual([eventId, userId, mailboxId, 1, token, 'HINDSIGHT_UNAVAILABLE', 5, 900, { retryable: true }]);
  });

  it('recovers expired leases in a bounded SKIP LOCKED transaction without external I/O', async () => {
    const sql = new FakeSql([[{ id: eventId }, { id: '00000000-0000-4000-8000-000000000006' }]]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).recoverExpiredClaims(2)).resolves.toBe(2);
    expect(sql.transactions).toBe(1);
    expect(sql.calls[0]?.statement).toContain("state='processing' and claim_expires_at<=clock_timestamp()");
    expect(sql.calls[0]?.statement).toContain('for update skip locked limit $1');
    expect(sql.calls[0]?.statement).toContain("last_error_code='CLAIM_EXPIRED'");
    expect(sql.calls[0]?.values).toEqual([2, 5, 900]);
  });

  it('rejects unsanitized error metadata before it can reach PostgreSQL', async () => {
    const sql = new FakeSql([]);
    await expect(new PostgresMailboxMemoryEventStore(sql, timing).defer(fence, { code: 'raw provider failure: email body' })).rejects.toThrow('sanitized');
    expect(sql.calls).toHaveLength(0);
  });
});
