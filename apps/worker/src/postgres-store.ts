import type { Account, Arrival, ArrivalResult, IngestionStore, SanitizedFailure } from './ingestion.js';

export interface SqlResult<Row> { rows: Row[]; }
export interface SqlClient { query<Row extends Record<string, unknown>>(statement: string, values?: ReadonlyArray<unknown>): Promise<SqlResult<Row>>; transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>; }
const one = <Row>(result: SqlResult<Row>): Row => { const row = result.rows[0]; if (!row) throw new Error('expected database row'); return row; };
const text = (value: string | undefined, maximum: number): string => (value ?? '').slice(0, maximum);
const date = (value: string | undefined, fallback: Date): Date => { const parsed = value ? new Date(value) : fallback; return Number.isNaN(parsed.valueOf()) ? fallback : parsed; };

/** Parameterized PostgreSQL implementation. SQL values are never interpolated. */
export class PostgresIngestionStore implements IngestionStore {
  constructor(private readonly sql: SqlClient,private readonly taskAdmission?:{bind?(sql:SqlClient):{authorizeTaskCreation(input:{userId:string;accountId:string;providerMessageId:string}):Promise<{allowed:boolean;reason?:string}>};authorizeTaskCreation(input:{userId:string;accountId:string;providerMessageId:string}):Promise<{allowed:boolean;reason?:string}>}) {}
  transaction<T>(operation: (store: IngestionStore) => Promise<T>): Promise<T> {
    return this.sql.transaction((client) => operation(new PostgresIngestionStore(client,this.taskAdmission?.bind?.(client) ?? this.taskAdmission)));
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
      `insert into app.messages (account_id, provider_message_id, sender, recipients, subject, preview, received_at, is_read, has_attachments, is_baseline)
       values ($1, $2, $3::jsonb, $4::jsonb, $5, '', $6, $7, $8, true)
       on conflict (account_id, provider_message_id) do update set updated_at = excluded.updated_at`,
      [arrival.accountId, message.id, JSON.stringify(sender), JSON.stringify(recipients), text(message.subject, 998), date(message.receivedAt, arrival.observedAt), message.isRead ?? false, (message.attachments?.length ?? 0) > 0],
    );
  }
  async recordArrival(arrival: Arrival): Promise<ArrivalResult | null> {
    const owner=one(await this.sql.query<{user_id:string}>('select user_id from app.accounts where id=$1',[arrival.accountId]));
    const admission=this.taskAdmission?await this.taskAdmission.authorizeTaskCreation({userId:owner.user_id,accountId:arrival.accountId,providerMessageId:arrival.message.id}):{allowed:true as const};
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
       ), canonical_activity as (
         -- Same identity as the legacy arrival projection. ON CONFLICT also repairs
         -- arrivals committed before canonical dual-write was deployed.
         insert into app.agent_activities
           (id, user_id, account_id, kind, source_message_id, correlation_id, state, revision, created_at, updated_at)
         select a.id, ac.user_id, $1, 'arrival', a.message_id, 'arrival:' || a.id::text,
                'open', 1, $10, $10
         from activity a join app.accounts ac on ac.id = $1
         on conflict (id) do nothing
         returning id
       ), inserted_task as (
         -- Canonical Task and its exact Manager authority are frozen before this
         -- transaction can advance any poll checkpoint or delivery cursor.
         insert into app.agent_tasks
           (id,enqueue_key,activity_id,user_id,account_id,manager_kind,manager_connection_id,
            manager_lifecycle_revision,assignment_id,assignment_revision,grant_id,grant_revision,
            safety_revision,state,pending_reason,version,attempt_count,max_attempts,lease_generation,
            available_at,deadline_at,created_at,updated_at)
         select (substr(md5('agent-task:'||a.id::text),1,8)||'-'||substr(md5('agent-task:'||a.id::text),9,4)||
                 '-5'||substr(md5('agent-task:'||a.id::text),14,3)||'-8'||substr(md5('agent-task:'||a.id::text),18,3)||
                 '-'||substr(md5('agent-task:'||a.id::text),21,12))::uuid,
                'arrival:'||a.id::text, a.id, ac.user_id, $1, ma.manager_kind, ma.agent_connection_id,
                case when ma.manager_kind='agent_connection' then c.lifecycle_revision end,
                ma.id,ma.revision,g.id,g.revision,s.revision,'pending','initial',1,0,5,0,$10,$10 + interval '24 hours',$10,$10
         from activity a join app.accounts ac on ac.id=$1
         join app.mailbox_manager_assignments ma on ma.user_id=ac.user_id and ma.account_id=$1
         join app.agent_capability_grants g on g.user_id=ac.user_id and g.account_id=$1
              and g.manager_kind=ma.manager_kind and g.agent_connection_id is not distinct from ma.agent_connection_id
         join app.agent_safety_ceiling s on s.singleton=true
         left join app.agent_connections c on c.id=ma.agent_connection_id
         where $11::boolean and ma.automatic_processing_enabled and ma.manager_kind<>'none' and g.state='active'
           and 'automatic'=any(g.invocation_modes) and 'mail.read'=any(g.capabilities)
           and 'automatic'=any(s.invocation_modes) and 'mail.read'=any(s.capabilities)
         on conflict(enqueue_key) do nothing returning id,activity_id,account_id,version,created_at
       ), blocked_task as (
         -- Never let a poll checkpoint erase an arrival merely because assignment,
         -- connection, grant, or safety authority is temporarily unavailable.
         insert into app.agent_task_blocks(activity_id,user_id,account_id,reason,available_at,created_at,updated_at)
         select a.id,ac.user_id,$1,
           case when not $11::boolean then 'OPERATIONAL_ADMISSION_DENIED:'||$12::text
                when ma.id is null or ma.manager_kind='none' then 'NO_MANAGER_ASSIGNED'
                when ma.manager_kind='agent_connection' and coalesce(c.state::text,'')<>'connected' then 'MANAGER_UNAVAILABLE'
                else 'CANONICAL_AUTHORITY_UNAVAILABLE' end,$10,$10,$10
         from activity a join app.accounts ac on ac.id=$1
         left join app.mailbox_manager_assignments ma on ma.user_id=ac.user_id and ma.account_id=$1
         left join app.agent_connections c on c.id=ma.agent_connection_id
         where not exists(select 1 from inserted_task)
         on conflict(activity_id) do update set reason=excluded.reason,available_at=excluded.available_at,updated_at=excluded.updated_at
       ), inserted_task_outbox as (
         insert into app.agent_task_outbox
           (id,task_id,activity_id,account_id,event,task_version,payload_digest,correlation_id,occurred_at,available_at)
         select gen_random_uuid(),t.id,t.activity_id,t.account_id,'task_available',t.version,
                md5(t.id::text)||md5('task:'||t.id::text),'arrival:'||t.activity_id::text,t.created_at,t.created_at
         from inserted_task t on conflict(task_id,task_version,event) do nothing
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
       select j.id as job_id, j.idempotency_key, m.created from activity a
       join job j on j.activity_id = a.id cross join inserted_message m`,
      [arrival.accountId, message.id, JSON.stringify(sender), JSON.stringify(recipients), text(message.subject, 998), date(message.receivedAt, arrival.observedAt), message.isRead ?? false, (message.attachments?.length ?? 0) > 0, text(sender.name ?? sender.address, 200), arrival.observedAt, admission.allowed, admission.allowed ? '' : admission.reason ?? 'unknown'],
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
  async pendingDispatches(limit: number): Promise<ReadonlyArray<{ jobId: string; userId: string; idempotencyKey: string }>> {
    const result = await this.sql.query<{ id: string; user_id: string; idempotency_key: string }>(
      `select j.id, ac.user_id, j.idempotency_key from app.agent_jobs j
       join app.activities a on a.id = j.activity_id join app.accounts ac on ac.id = a.account_id
       where j.state = 'pending' and j.queue_job_id is null and j.available_at <= now()
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
