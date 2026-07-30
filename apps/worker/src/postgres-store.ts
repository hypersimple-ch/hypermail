import type { Account, Arrival, ArrivalResult, IngestionStore, SanitizedFailure } from './ingestion.js';

export interface SqlResult<Row> { rows: Row[]; }
export interface SqlClient { query<Row extends Record<string, unknown>>(statement: string, values?: ReadonlyArray<unknown>): Promise<SqlResult<Row>>; transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>; }
const one = <Row>(result: SqlResult<Row>): Row => { const row = result.rows[0]; if (!row) throw new Error('expected database row'); return row; };
const text = (value: string | undefined, maximum: number): string => (value ?? '').slice(0, maximum);
const date = (value: string | undefined, fallback: Date): Date => { const parsed = value ? new Date(value) : fallback; return Number.isNaN(parsed.valueOf()) ? fallback : parsed; };

/** Parameterized PostgreSQL implementation. SQL values are never interpolated. */
export class PostgresIngestionStore implements IngestionStore {
  constructor(private readonly sql: SqlClient) {}
  transaction<T>(operation: (store: IngestionStore) => Promise<T>): Promise<T> {
    return this.sql.transaction((client) => operation(new PostgresIngestionStore(client)));
  }
  async readyAccounts(): Promise<ReadonlyArray<Account>> {
    const result = await this.sql.query<{ id: string; email: string; provider: Account['provider']; baseline_completed_at: Date | null; consecutive_failures: number }>(
      `select a.id, a.email, a.provider, a.baseline_completed_at, coalesce(p.consecutive_failures, 0) as consecutive_failures
       from app.accounts a left join app.poll_states p on p.account_id = a.id
       where a.state = 'ready' and (p.consecutive_failures is null or p.consecutive_failures = 0 or p.last_poll_started_at <= now() - make_interval(secs => least(1800, 30 * power(2, least(p.consecutive_failures - 1, 5))::int)))`,
    );
    return result.rows.map((row) => ({ id: row.id, email: row.email, provider: row.provider, baselineCompletedAt: row.baseline_completed_at, consecutiveFailures: row.consecutive_failures }));
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
      `insert into app.messages (account_id, provider_message_id, sender, recipients, subject, preview, received_at, is_read, has_attachments, is_baseline)
       values ($1, $2, $3::jsonb, $4::jsonb, $5, '', $6, $7, $8, true)
       on conflict (account_id, provider_message_id) do update set updated_at = excluded.updated_at`,
      [arrival.accountId, message.id, JSON.stringify(sender), JSON.stringify(recipients), text(message.subject, 998), date(message.receivedAt, arrival.observedAt), message.isRead ?? false, (message.attachments?.length ?? 0) > 0],
    );
  }
  async recordArrival(arrival: Arrival): Promise<ArrivalResult | null> {
    const message = arrival.message;
    const recipients = [...(message.to ?? []).map((item) => ({ kind: 'to', ...item })), ...(message.cc ?? []).map((item) => ({ kind: 'cc', ...item }))];
    const sender = message.from ?? { address: 'unknown@invalid' };
    const result = await this.sql.query<{ job_id: string; idempotency_key: string; created: boolean }>(
      `with inserted_message as (
         insert into app.messages (account_id, provider_message_id, sender, recipients, subject, preview, received_at, is_read, has_attachments, is_baseline)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, '', $6, $7, $8, false)
         on conflict (account_id, provider_message_id) do update set updated_at = excluded.updated_at
         returning id, is_baseline, received_at, (xmax = 0) as created
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
       ), inserted_notification as (
         insert into app.logical_notifications (activity_id, state, sender_label, subject, status_label)
         select id, 'pending', $9, $5, 'New email' from activity on conflict (activity_id) do nothing
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
       select j.id as job_id, j.idempotency_key, m.created from activity a
       join job j on j.activity_id = a.id cross join inserted_message m`,
      [arrival.accountId, message.id, JSON.stringify(sender), JSON.stringify(recipients), text(message.subject, 998), date(message.receivedAt, arrival.observedAt), message.isRead ?? false, (message.attachments?.length ?? 0) > 0, text(sender.name ?? sender.address, 200), arrival.observedAt],
    );
    const row = result.rows[0];
    return row ? { jobId: row.job_id, idempotencyKey: row.idempotency_key, created: row.created } : null;
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
  async pendingDispatches(limit: number): Promise<ReadonlyArray<{ jobId: string; idempotencyKey: string }>> {
    const result = await this.sql.query<{ id: string; idempotency_key: string }>(`select id, idempotency_key from app.agent_jobs where state = 'pending' and queue_job_id is null and available_at <= now() order by created_at limit $1`, [limit]);
    return result.rows.map((row) => ({ jobId: row.id, idempotencyKey: row.idempotency_key }));
  }
  async markDispatched(jobId: string, queueJobId: string): Promise<void> { await this.sql.query(`update app.agent_jobs set queue_job_id = $2, updated_at = now() where id = $1 and queue_job_id is null`, [jobId, queueJobId]); }
  async acquireLease(name: string, holderId: string, now: Date, ttlMilliseconds: number): Promise<boolean> {
    const expires = new Date(now.valueOf() + ttlMilliseconds);
    const result = await this.sql.query<{ holder_id: string }>(`insert into app.scheduler_leases (name, holder_id, fencing_token, acquired_at, expires_at) values ($1, $2, 1, $3, $4) on conflict (name) do update set holder_id = excluded.holder_id, fencing_token = app.scheduler_leases.fencing_token + 1, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at where app.scheduler_leases.expires_at <= $3 or app.scheduler_leases.holder_id = $2 returning holder_id`, [name, holderId, now, expires]);
    return result.rows.length === 1;
  }
}
