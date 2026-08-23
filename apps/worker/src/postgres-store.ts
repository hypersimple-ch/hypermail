import { enqueueMailboxMemoryEventInTransaction } from '@hypermail/db';
import type { Account, Arrival, ArrivalResult, IngestionStore, SanitizedFailure } from './ingestion.js';

export interface SqlResult<Row> { rows: Row[]; }
export interface SqlClient { query<Row extends Record<string, unknown>>(statement: string, values?: ReadonlyArray<unknown>): Promise<SqlResult<Row>>; transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>; }
const one = <Row>(result: SqlResult<Row>): Row => { const row = result.rows[0]; if (!row) throw new Error('expected database row'); return row; };
const text = (value: string | undefined, maximum: number): string => (value ?? '').slice(0, maximum);
const date = (value: string | undefined, fallback: Date): Date => { const parsed = value ? new Date(value) : fallback; return Number.isNaN(parsed.valueOf()) ? fallback : parsed; };
const attachmentMetadata = (items: Arrival['message']['attachments']): string => JSON.stringify((items ?? []).slice(0, 100).map((item) => ({
  provider_attachment_id: text(item.id, 2_000), filename: text(item.name, 1_000),
  media_type: text(item.contentType ?? 'application/octet-stream', 255),
  size_bytes: Math.min(2_147_483_647, Math.max(0, Number.isSafeInteger(item.size) ? item.size ?? 0 : 0)),
})));

/** Parameterized PostgreSQL implementation. SQL values are never interpolated. */
export class PostgresIngestionStore implements IngestionStore {
  constructor(private readonly sql: SqlClient) {}
  transaction<T>(operation: (store: IngestionStore) => Promise<T>): Promise<T> {
    return this.sql.transaction((client) => operation(new PostgresIngestionStore(client)));
  }
  async readyAccounts(): Promise<ReadonlyArray<Account>> {
    const result = await this.sql.query<{ user_id: string; id: string; email: string; provider: Account['provider']; baseline_completed_at: Date | null; consecutive_failures: number }>(
      `select a.user_id, a.id, a.email, a.provider, a.baseline_completed_at, coalesce(p.consecutive_failures, 0) as consecutive_failures
       from app.accounts a left join app.poll_states p on p.account_id = a.id
       where a.state = 'ready' and (p.consecutive_failures is null or p.consecutive_failures = 0 or p.last_poll_started_at <= now() - make_interval(secs => least(1800, 30 * power(2, least(p.consecutive_failures - 1, 5))::int)))`,
    );
    return result.rows.map((row) => ({ userId: row.user_id, id: row.id, email: row.email, provider: row.provider, baselineCompletedAt: row.baseline_completed_at, consecutiveFailures: row.consecutive_failures }));
  }
  async markBaseline(accountId: string, at: Date): Promise<void> {
    await this.sql.query(`update app.accounts set baseline_completed_at = coalesce(baseline_completed_at, $2), updated_at = $2 where id = $1`, [accountId, at]);
    await this.markPollSucceeded(accountId, at, false);
  }
  async recordBaseline(arrival: Arrival): Promise<void> {
    const message = arrival.message;
    const recipients = [...(message.to ?? []).map((item) => ({ kind: 'to', ...item })), ...(message.cc ?? []).map((item) => ({ kind: 'cc', ...item }))];
    const sender = message.from ?? { address: 'unknown@invalid' };
    await this.sql.query(
      `with projected_message as (
         insert into app.messages (account_id, provider_message_id, sender, recipients, subject, preview, received_at, is_read, has_attachments, is_baseline)
         values ($1, $2, $3::text::jsonb, $4::text::jsonb, $5, '', $6, $7, $8, true)
         on conflict (account_id, provider_message_id) do update set updated_at = excluded.updated_at
         returning id
       )
       insert into app.attachments(message_id,provider_attachment_id,filename,media_type,size_bytes)
       select m.id,x.provider_attachment_id,x.filename,x.media_type,x.size_bytes from projected_message m
       cross join jsonb_to_recordset($9::text::jsonb) as x(provider_attachment_id text,filename text,media_type text,size_bytes integer)
       on conflict(message_id,provider_attachment_id) do update set filename=excluded.filename,media_type=excluded.media_type,size_bytes=excluded.size_bytes`,
      [arrival.accountId, message.id, JSON.stringify(sender), JSON.stringify(recipients), text(message.subject, 998), date(message.receivedAt, arrival.observedAt), message.isRead ?? false, (message.attachments?.length ?? 0) > 0, attachmentMetadata(message.attachments)],
    );
  }
  async recordArrival(arrival: Arrival): Promise<ArrivalResult | null> {
    const message = arrival.message;
    const recipients = [...(message.to ?? []).map((item) => ({ kind: 'to', ...item })), ...(message.cc ?? []).map((item) => ({ kind: 'cc', ...item }))];
    const sender = message.from ?? { address: 'unknown@invalid' };
    return this.sql.transaction(async (sql) => {
      const result = await sql.query<{ job_id: string; idempotency_key: string; created: boolean; source_id: string; user_id: string; activity_created: boolean }>(
        `with inserted_message as (
           insert into app.messages (account_id, provider_message_id, sender, recipients, subject, preview, received_at, is_read, has_attachments, is_baseline)
           values ($1, $2, $3::text::jsonb, $4::text::jsonb, $5, '', $6, $7, $8, false)
           on conflict (account_id, provider_message_id) do update set updated_at = excluded.updated_at
           returning id, is_baseline, received_at, (xmax = 0) as created
         ), projected_attachments as (
           insert into app.attachments(message_id,provider_attachment_id,filename,media_type,size_bytes)
           select m.id,x.provider_attachment_id,x.filename,x.media_type,x.size_bytes from inserted_message m
           cross join jsonb_to_recordset($11::text::jsonb) as x(provider_attachment_id text,filename text,media_type text,size_bytes integer)
           on conflict(message_id,provider_attachment_id) do update set filename=excluded.filename,media_type=excluded.media_type,size_bytes=excluded.size_bytes
           returning id
         ), inserted_activity as (
           insert into app.activities (account_id, message_id, state)
           select $1, m.id, 'new' from inserted_message m
           join app.accounts a on a.id = $1
           where not m.is_baseline and m.received_at >= a.baseline_completed_at
           on conflict (message_id) do nothing
           returning id, message_id
         ), activity as (
           select id, message_id from inserted_activity union all
           select a.id, a.message_id from app.activities a join inserted_message m on m.id = a.message_id
           where not m.is_baseline
           limit 1
         ), canonical_activity as (
           insert into app.agent_activities
             (id, user_id, account_id, kind, source_message_id, correlation_id, state, revision, created_at, updated_at)
           select a.id, ac.user_id, $1, 'arrival', a.message_id, 'arrival:' || a.id::text,
                  'open', 1, $10, $10
           from activity a join app.accounts ac on ac.id = $1
           on conflict (id) do nothing
           returning id
         ), inserted_notification as (
           insert into app.logical_notifications (activity_id, state, sender_label, subject, status_label)
           select a.id, 'pending', $9, $5, 'New email' from activity a
           left join canonical_activity ca on ca.id = a.id
           on conflict (activity_id) do nothing
         ), inserted_job as (
           insert into app.agent_jobs (activity_id, idempotency_key, state, available_at)
           select id, 'agent:evaluate:' || id::text, 'pending', $10 from activity on conflict (activity_id) do nothing
           returning id, activity_id, idempotency_key
         ), job as (
           select id, activity_id, idempotency_key from inserted_job
           union all
           select j.id, j.activity_id, j.idempotency_key from app.agent_jobs j join activity a on a.id = j.activity_id
           where not exists (select 1 from inserted_job)
           limit 1
         )
         select j.id as job_id,j.idempotency_key,m.created,a.message_id as source_id,ac.user_id,
                exists(select 1 from inserted_activity) as activity_created
         from activity a join job j on j.activity_id=a.id cross join inserted_message m join app.accounts ac on ac.id=$1`,
        [arrival.accountId, message.id, JSON.stringify(sender), JSON.stringify(recipients), text(message.subject, 998), date(message.receivedAt, arrival.observedAt), message.isRead ?? false, (message.attachments?.length ?? 0) > 0, text(sender.name ?? sender.address, 200), arrival.observedAt, attachmentMetadata(message.attachments)],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.activity_created) await enqueueMailboxMemoryEventInTransaction(sql, {
        userId: row.user_id, mailboxId: arrival.accountId, sourceType: 'message', sourceId: row.source_id,
        sourceVersion: 1, kind: 'email_received', occurredAt: arrival.observedAt.toISOString(), contentPayload: {},
      });
      return { jobId: row.job_id, idempotencyKey: row.idempotency_key, created: row.created };
    });
  }
  async markPollSucceeded(accountId: string, at: Date, reconciled: boolean): Promise<void> {
    await this.sql.query(
      `insert into app.poll_states (account_id, checkpoint_observed_at, last_poll_started_at, last_poll_succeeded_at, last_reconciled_at, consecutive_failures, updated_at)
       values ($1, $2, $2, $2, case when $3 then $2 else null end, 0, $2)
       on conflict (account_id) do update set checkpoint_observed_at = $2, last_poll_started_at = $2, last_poll_succeeded_at = $2,
       last_reconciled_at = case when $3 then $2 else app.poll_states.last_reconciled_at end, consecutive_failures = 0, last_error_code = null, updated_at = $2`, [accountId, at, reconciled]);
    await this.sql.query(`insert into app.account_health (account_id, state, reason_code, detail, first_observed_at, updated_at) values ($1, 'healthy', null, null, $2, $2) on conflict (account_id) do update set state = 'healthy', reason_code = null, detail = null, updated_at = $2`, [accountId, at]);
  }
  async markPollFailed(accountId: string, at: Date, failure: SanitizedFailure): Promise<number> {
    const row = one(await this.sql.query<{ consecutive_failures: number }>(
      `insert into app.poll_states (account_id, last_poll_started_at, consecutive_failures, last_error_code, updated_at) values ($1, $2, 1, $3, $2)
       on conflict (account_id) do update set last_poll_started_at = $2, consecutive_failures = app.poll_states.consecutive_failures + 1, last_error_code = $3, updated_at = $2
       returning consecutive_failures`, [accountId, at, failure.code],
    ));
    await this.sql.query(`insert into app.account_health (account_id, state, reason_code, detail, first_observed_at, updated_at) values ($1, 'degraded', $2, $3, $4, $4) on conflict (account_id) do update set state = 'degraded', reason_code = $2, detail = $3, updated_at = $4`, [accountId, failure.code, failure.detail, at]);
    return row.consecutive_failures;
  }
  async pendingDispatches(limit: number): Promise<ReadonlyArray<{ jobId: string; userId: string; idempotencyKey: string }>> {
    const result = await this.sql.query<{ id: string; user_id: string; idempotency_key: string }>(
      `select j.id, ac.user_id, j.idempotency_key from app.agent_jobs j
       join app.activities a on a.id = j.activity_id join app.accounts ac on ac.id = a.account_id
       where ac.state in ('ready','degraded') and j.state = 'pending' and j.queue_job_id is null and j.available_at <= now()
       order by j.created_at limit $1`, [limit]);
    return result.rows.map((row) => ({ jobId: row.id, userId: row.user_id, idempotencyKey: row.idempotency_key }));
  }
  async markDispatched(jobId: string, queueJobId: string): Promise<void> { await this.sql.query(`update app.agent_jobs set queue_job_id = $2, updated_at = now() where id = $1 and queue_job_id is null`, [jobId, queueJobId]); }
  async acquireLease(name: string, holderId: string, now: Date, ttlMilliseconds: number): Promise<boolean> {
    const expires = new Date(now.valueOf() + ttlMilliseconds);
    const result = await this.sql.query<{ holder_id: string }>(`insert into app.scheduler_leases (name, holder_id, fencing_token, acquired_at, expires_at) values ($1, $2, 1, $3, $4) on conflict (name) do update set holder_id = excluded.holder_id, fencing_token = app.scheduler_leases.fencing_token + 1, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at where app.scheduler_leases.expires_at <= $3 or app.scheduler_leases.holder_id = $2 returning holder_id`, [name, holderId, now, expires]);
    return result.rows.length === 1;
  }
}
