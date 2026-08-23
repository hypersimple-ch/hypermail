import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import type { SqlClient } from './postgres-client.js';

export type MailboxMemoryEventState = 'pending' | 'processing' | 'completed' | 'dead_letter';
export type MailboxMemoryPayload = Readonly<Record<string, unknown>>;
export type MailboxMemoryMetadata = Readonly<Record<string, unknown>>;

export type MailboxMemoryClaimFence = Readonly<{
  eventId: string;
  userId: string;
  mailboxId: string;
  generation: number;
  token: string;
}>;

export type MailboxMemoryEvent = Readonly<{
  id: string;
  userId: string;
  mailboxId: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  kind: string;
  contentDigest: string;
  contentPayload: MailboxMemoryPayload | null;
  state: MailboxMemoryEventState;
  attemptCount: number;
  maxAttempts: number;
  claimGeneration: number;
  availableAt: string;
  occurredAt: string;
  completedAt: string | null;
  deadLetteredAt: string | null;
  resultMetadata: MailboxMemoryMetadata | null;
  lastErrorCode: string | null;
  lastErrorMetadata: MailboxMemoryMetadata | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ClaimedMailboxMemoryEvent = Readonly<{
  event: MailboxMemoryEvent;
  fence: MailboxMemoryClaimFence;
}>;

export type EnqueueMailboxMemoryEvent = Readonly<{
  /** Stable UUID. Replays are also deduplicated by the tenant-owned source identity. */
  id: string;
  userId: string;
  mailboxId: string;
  sourceType: string;
  sourceId: string;
  sourceVersion?: number;
  kind: string;
  contentPayload: MailboxMemoryPayload;
  occurredAt: string;
  maxAttempts?: number;
}>;

export type CanonicalMailboxMemoryEvent = Omit<EnqueueMailboxMemoryEvent, 'id' | 'maxAttempts'>;

export type MailboxMemoryTextEvidence = Readonly<{
  text: string;
  digest: string;
  truncated: boolean;
}>;

export type MailboxMemoryFailure = Readonly<{
  /** Sanitized machine code. Never pass provider text, email content, or attachment bytes. */
  code: string;
  metadata?: MailboxMemoryMetadata;
}>;

/**
 * Durable seam between canonical Hypermail writes and Mailbox-memory delivery.
 * Implementations commit claims before returning them. Callers must perform all
 * external Hindsight I/O only after `claim` resolves, then call `complete` or `defer`.
 */
export interface MailboxMemoryEventStore {
  enqueue(input: EnqueueMailboxMemoryEvent): Promise<MailboxMemoryEvent>;
  claim(input: Readonly<{ workerId: string; limit?: number; leaseSeconds?: number }>): Promise<readonly ClaimedMailboxMemoryEvent[]>;
  renew(fence: MailboxMemoryClaimFence, leaseSeconds?: number): Promise<void>;
  complete(fence: MailboxMemoryClaimFence, resultMetadata?: MailboxMemoryMetadata): Promise<MailboxMemoryEvent>;
  defer(fence: MailboxMemoryClaimFence, failure: MailboxMemoryFailure): Promise<MailboxMemoryEvent>;
  recoverExpiredClaims(limit?: number): Promise<number>;
}

type EventRow = Record<string, unknown>;
const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_ATTEMPTS = 25;
const DEFAULT_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 3_600;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 15 * 60;
const METADATA_MAX_BYTES = 8 * 1024;
const CONTENT_PAYLOAD_MAX_BYTES = 64 * 1024;
const TEXT_EVIDENCE_MAX_BYTES = 12 * 1024;
const EVENT_ID_NAMESPACE = 'hypermail:mailbox-memory-event:v1';
const tokenPattern = /^[a-z][a-z0-9_]{0,63}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Mailbox memory JSON contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new Error('Mailbox memory JSON contains an unsupported value.');
      }
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(',')}}`;
  }
  throw new Error('Mailbox memory JSON contains an unsupported value.');
}

const digestPayload = (payload: MailboxMemoryPayload): string => createHash('sha256').update(canonicalJson(payload)).digest('hex');
const validatePayload = (payload: MailboxMemoryPayload): void => {
  const encoded = canonicalJson(payload);
  if (Buffer.byteLength(encoded, 'utf8') > CONTENT_PAYLOAD_MAX_BYTES) {
    throw new Error(`Mailbox memory content payload exceeds ${String(CONTENT_PAYLOAD_MAX_BYTES)} bytes.`);
  }
};

/** Stable UUID derived only from the immutable, tenant-owned source identity. */
export function deterministicMailboxMemoryEventId(input: Pick<EnqueueMailboxMemoryEvent, 'userId' | 'mailboxId' | 'sourceType' | 'sourceId' | 'sourceVersion' | 'kind'>): string {
  const identity = canonicalJson({ namespace: EVENT_ID_NAMESPACE, userId: input.userId, mailboxId: input.mailboxId,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceVersion: input.sourceVersion ?? 1, kind: input.kind });
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Bounded draft/question evidence. A digest preserves exact comparison when text is truncated. */
export function mailboxMemoryTextEvidence(value: string, maximumBytes = TEXT_EVIDENCE_MAX_BYTES): MailboxMemoryTextEvidence {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > TEXT_EVIDENCE_MAX_BYTES) {
    throw new Error(`maximumBytes must be an integer from 1 to ${String(TEXT_EVIDENCE_MAX_BYTES)}.`);
  }
  let text = ''; let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximumBytes) break;
    text += character; bytes += size;
  }
  return { text, digest: createHash('sha256').update(value).digest('hex'), truncated: bytes < Buffer.byteLength(value, 'utf8') };
}

const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const integerInRange = (value: number, minimum: number, maximum: number, name: string): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  return value;
};
const machineToken = (value: string, name: string): string => {
  if (!tokenPattern.test(value)) throw new Error(`${name} must be a lowercase machine token.`);
  return value;
};
const metadataJson = (metadata: MailboxMemoryMetadata): string => {
  const encoded = canonicalJson(metadata);
  if (Buffer.byteLength(encoded, 'utf8') > METADATA_MAX_BYTES) throw new Error(`Mailbox memory metadata exceeds ${String(METADATA_MAX_BYTES)} bytes.`);
  return encoded;
};

const eventFrom = (row: EventRow): MailboxMemoryEvent => ({
  id: row['id'] as string,
  userId: row['user_id'] as string,
  mailboxId: row['account_id'] as string,
  sourceType: row['source_type'] as string,
  sourceId: row['source_id'] as string,
  sourceVersion: row['source_version'] as number,
  kind: row['kind'] as string,
  contentDigest: row['content_digest'] as string,
  contentPayload: (row['content_payload'] ?? null) as MailboxMemoryPayload | null,
  state: row['state'] as MailboxMemoryEventState,
  attemptCount: row['attempt_count'] as number,
  maxAttempts: row['max_attempts'] as number,
  claimGeneration: row['claim_generation'] as number,
  availableAt: iso(row['available_at'] as Date | string),
  occurredAt: iso(row['occurred_at'] as Date | string),
  completedAt: row['completed_at'] == null ? null : iso(row['completed_at'] as Date | string),
  deadLetteredAt: row['dead_lettered_at'] == null ? null : iso(row['dead_lettered_at'] as Date | string),
  resultMetadata: (row['result_metadata'] ?? null) as MailboxMemoryMetadata | null,
  lastErrorCode: (row['last_error_code'] ?? null) as string | null,
  lastErrorMetadata: (row['last_error_metadata'] ?? null) as MailboxMemoryMetadata | null,
  createdAt: iso(row['created_at'] as Date | string),
  updatedAt: iso(row['updated_at'] as Date | string),
});

async function insertMailboxMemoryEvent(sql: Pick<SqlClient, 'query'>, input: EnqueueMailboxMemoryEvent): Promise<MailboxMemoryEvent> {
  const sourceType = machineToken(input.sourceType, 'sourceType');
  const kind = machineToken(input.kind, 'kind');
  const sourceVersion = integerInRange(input.sourceVersion ?? 1, 1, 2_147_483_647, 'sourceVersion');
  const maxAttempts = integerInRange(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS, 'maxAttempts');
  validatePayload(input.contentPayload);
  const contentDigest = digestPayload(input.contentPayload);
  const inserted = await sql.query<EventRow>(`insert into app.mailbox_memory_events
    (id,user_id,account_id,source_type,source_id,source_version,kind,content_digest,content_payload,state,attempt_count,max_attempts,claim_generation,available_at,occurred_at)
    select $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending',0,$10,0,$11::timestamptz,$11::timestamptz
    from app.accounts a where a.id=$3::uuid and a.user_id=$2::uuid and a.state in ('ready','degraded')
    on conflict(user_id,account_id,source_type,source_id,source_version,kind) do nothing returning *`,
  [input.id, input.userId, input.mailboxId, sourceType, input.sourceId, sourceVersion, kind, contentDigest, input.contentPayload, maxAttempts, input.occurredAt]);
  const existing = inserted.rows[0] ?? (await sql.query<EventRow>(`select * from app.mailbox_memory_events
    where user_id=$1 and account_id=$2 and source_type=$3 and source_id=$4 and source_version=$5 and kind=$6 for update`,
  [input.userId, input.mailboxId, sourceType, input.sourceId, sourceVersion, kind])).rows[0];
  if (!existing) throw new Error('Mailbox memory source is unavailable or inactive.');
  const event = eventFrom(existing);
  if (event.contentDigest !== contentDigest || event.occurredAt !== iso(input.occurredAt) || event.maxAttempts !== maxAttempts) {
    throw new Error('Mailbox memory source identity was replayed with different immutable content.');
  }
  return event;
}

/** Enqueue within the caller's canonical PostgreSQL transaction. No nested transaction or external I/O occurs. */
export function enqueueMailboxMemoryEventInTransaction(sql: Pick<SqlClient, 'query'>, input: CanonicalMailboxMemoryEvent): Promise<MailboxMemoryEvent> {
  return insertMailboxMemoryEvent(sql, { ...input, id: deterministicMailboxMemoryEventId(input) });
}

/** Adapter for repositories using postgres.js tagged transactions. */
export function enqueueMailboxMemoryEventInPostgresTransaction(sql: Pick<TransactionSql, 'unsafe'>, input: CanonicalMailboxMemoryEvent): Promise<MailboxMemoryEvent> {
  return enqueueMailboxMemoryEventInTransaction({ query: async <Row extends EventRow>(statement: string, values: readonly unknown[] = []) => ({
    rows: await sql.unsafe<Row[]>(statement, values as never[]),
  }) }, input);
}

/** PostgreSQL adapter for the Mailbox-memory event seam. It never performs external I/O. */
export class PostgresMailboxMemoryEventStore implements MailboxMemoryEventStore {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(input: EnqueueMailboxMemoryEvent): Promise<MailboxMemoryEvent> {
    return this.sql.transaction((db) => insertMailboxMemoryEvent(db, input));
  }

  async claim(input: Readonly<{ workerId: string; limit?: number; leaseSeconds?: number }>): Promise<readonly ClaimedMailboxMemoryEvent[]> {
    if (input.workerId.length < 1 || input.workerId.length > 128) throw new Error('workerId must contain 1 to 128 characters.');
    const limit = integerInRange(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
    const leaseSeconds = integerInRange(input.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 1, MAX_LEASE_SECONDS, 'leaseSeconds');
    const token = randomUUID();
    return this.sql.transaction(async (db) => {
      const claimed = await db.query<EventRow>(`with candidates as (
        select e.id from app.mailbox_memory_events e
        join app.accounts a on a.id=e.account_id and a.user_id=e.user_id and a.state in ('ready','degraded')
        where e.state='pending' and e.available_at<=clock_timestamp()
        order by e.available_at,e.occurred_at,e.id for update of e skip locked limit $1
      )
      update app.mailbox_memory_events e set state='processing',attempt_count=e.attempt_count+1,
        claim_generation=e.claim_generation+1,claim_token=$2::uuid,claim_worker=$3,
        claimed_at=clock_timestamp(),claim_expires_at=clock_timestamp()+make_interval(secs=>$4),updated_at=clock_timestamp(),
        last_error_code=null,last_error_metadata=null
      from candidates c where e.id=c.id returning e.*`, [limit, token, input.workerId, leaseSeconds]);
      return claimed.rows.map((row) => {
        const event = eventFrom(row);
        return { event, fence: { eventId: event.id, userId: event.userId, mailboxId: event.mailboxId,
          generation: event.claimGeneration, token } };
      });
    });
  }

  async renew(fence: MailboxMemoryClaimFence, leaseSeconds = MAX_LEASE_SECONDS): Promise<void> {
    const boundedLease = integerInRange(leaseSeconds, 1, MAX_LEASE_SECONDS, 'leaseSeconds');
    const renewed = await this.sql.query<{ id: string }>(`update app.mailbox_memory_events set
      claim_expires_at=clock_timestamp()+make_interval(secs=>$6),updated_at=clock_timestamp()
      where id=$1 and user_id=$2 and account_id=$3 and state='processing' and claim_generation=$4 and claim_token=$5::uuid returning id`,
    [fence.eventId, fence.userId, fence.mailboxId, fence.generation, fence.token, boundedLease]);
    if (renewed.rows.length !== 1) throw new Error('Mailbox memory event claim is stale or tenant scope does not match.');
  }

  async complete(fence: MailboxMemoryClaimFence, resultMetadata: MailboxMemoryMetadata = {}): Promise<MailboxMemoryEvent> {
    metadataJson(resultMetadata);
    const updated = await this.sql.query<EventRow>(`update app.mailbox_memory_events set
      state='completed',content_payload=null,result_metadata=$6::jsonb,last_error_code=null,last_error_metadata=null,
      completed_at=clock_timestamp(),dead_lettered_at=null,claim_worker=null,claimed_at=null,claim_expires_at=null,updated_at=clock_timestamp()
      where id=$1 and user_id=$2 and account_id=$3 and state='processing' and claim_generation=$4 and claim_token=$5::uuid returning *`,
    [fence.eventId, fence.userId, fence.mailboxId, fence.generation, fence.token, resultMetadata]);
    if (updated.rows[0]) return eventFrom(updated.rows[0]);
    const existing = await this.readScoped(fence);
    if (existing?.state === 'completed' && existing.claimGeneration === fence.generation && sameJson(existing.resultMetadata ?? {}, resultMetadata)) return existing;
    throw new Error('Mailbox memory event claim is stale or tenant scope does not match.');
  }

  async defer(fence: MailboxMemoryClaimFence, failure: MailboxMemoryFailure): Promise<MailboxMemoryEvent> {
    if (!errorCodePattern.test(failure.code)) throw new Error('Mailbox memory failure code must be a sanitized uppercase machine code.');
    const failureMetadata = failure.metadata ?? {};
    metadataJson(failureMetadata);
    const updated = await this.sql.query<EventRow>(`update app.mailbox_memory_events set
      state='pending'::app.mailbox_memory_event_state,
      available_at=clock_timestamp()+make_interval(secs=>least($8,power(2,least(attempt_count-1,16))*$7)),
      result_metadata=null,last_error_code=$6,last_error_metadata=$9::jsonb,completed_at=null,dead_lettered_at=null,
      claim_worker=null,claimed_at=null,claim_expires_at=null,updated_at=clock_timestamp()
      where id=$1 and user_id=$2 and account_id=$3 and state='processing' and claim_generation=$4 and claim_token=$5::uuid returning *`,
    [fence.eventId, fence.userId, fence.mailboxId, fence.generation, fence.token, failure.code, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS, failureMetadata]);
    if (updated.rows[0]) return eventFrom(updated.rows[0]);
    const existing = await this.readScoped(fence);
    if (existing?.state === 'pending' && existing.claimGeneration === fence.generation &&
      existing.lastErrorCode === failure.code && sameJson(existing.lastErrorMetadata ?? {}, failureMetadata)) return existing;
    throw new Error('Mailbox memory event claim is stale or tenant scope does not match.');
  }

  async recoverExpiredClaims(limit = MAX_LIMIT): Promise<number> {
    const boundedLimit = integerInRange(limit, 1, MAX_LIMIT, 'limit');
    const recovered = await this.sql.transaction(async (db) => db.query<{ id: string }>(`with candidates as (
      select id from app.mailbox_memory_events where state='processing' and claim_expires_at<=clock_timestamp()
      order by claim_expires_at,id for update skip locked limit $1
    )
    update app.mailbox_memory_events e set
      state='pending'::app.mailbox_memory_event_state,
      available_at=clock_timestamp()+make_interval(secs=>least($3,power(2,least(attempt_count-1,16))*$2)),
      result_metadata=null,last_error_code='CLAIM_EXPIRED',last_error_metadata='{}'::jsonb,completed_at=null,dead_lettered_at=null,
      claim_worker=null,claimed_at=null,claim_expires_at=null,updated_at=clock_timestamp()
    from candidates c where e.id=c.id returning e.id`, [boundedLimit, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS]));
    return recovered.rows.length;
  }

  private async readScoped(fence: MailboxMemoryClaimFence): Promise<MailboxMemoryEvent | null> {
    const row = (await this.sql.query<EventRow>('select * from app.mailbox_memory_events where id=$1 and user_id=$2 and account_id=$3',
      [fence.eventId, fence.userId, fence.mailboxId])).rows[0];
    return row ? eventFrom(row) : null;
  }
}
