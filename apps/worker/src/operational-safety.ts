import { createHmac } from 'node:crypto';
import type { SqlClient } from './postgres-store.js';

export type OperationalDenial = 'creation_rate_limit' | 'pending_quota' | 'claim_rate_limit' | 'concurrency';
export type OperationalAdmission = Readonly<
  | { allowed: true; replay: boolean; databaseTime: Date }
  | { allowed: false; reason: OperationalDenial; databaseTime: Date }
>;
export interface OperationalLimits {
  tasksPerMinute: number;
  claimsPerMinute: number;
  concurrentTasks: number;
  pendingTasks: number;
}
export interface TaskCreationAdmission {
  authorizeTaskCreation(input: { userId: string; accountId: string; providerMessageId: string }): Promise<OperationalAdmission>;
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

/**
 * Transaction-bound, fail-closed admission guard. Callers MUST bind this guard to
 * the same SqlClient transaction which creates/claims the task. The per-subject
 * xact lock makes the count-and-create decision serializable without global locks.
 */
export class PostgresOperationalGuard implements TaskCreationAdmission {
  constructor(private readonly sql: SqlClient, private readonly limits: OperationalLimits, private readonly pseudonymKey: string) {
    positive(limits.tasksPerMinute, 'tasksPerMinute'); positive(limits.claimsPerMinute, 'claimsPerMinute');
    positive(limits.concurrentTasks, 'concurrentTasks'); positive(limits.pendingTasks, 'pendingTasks');
    if (Buffer.byteLength(pseudonymKey) < 32) throw new RangeError('pseudonymKey must be at least 32 bytes');
  }

  bind(sql: SqlClient): PostgresOperationalGuard { return new PostgresOperationalGuard(sql, this.limits, this.pseudonymKey); }

  async authorizeTaskCreation(input: { userId: string; accountId: string; providerMessageId: string }): Promise<OperationalAdmission> {
    const subject = this.subject(input.userId);
    const clock = await this.lockAndClock(subject);
    // Idempotency MUST precede quota/rate accounting: reconciliation is a replay,
    // not new work, and therefore neither consumes nor can be denied by capacity.
    const replay = await this.sql.query<{ present: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM app.agent_tasks t JOIN app.activities a ON a.id=t.activity_id
      JOIN app.messages m ON m.id=a.message_id
      WHERE a.account_id=$1 AND m.provider_message_id=$2) AS present`, [input.accountId, input.providerMessageId]);
    if (replay.rows[0]?.present) return { allowed: true, replay: true, databaseTime: clock };

    const usage = await this.sql.query<{ pending: number }>(`SELECT count(*)::int AS pending FROM app.agent_tasks
      WHERE user_id=$1 AND state IN ('pending','waiting_for_answer','awaiting_action_verification')`, [input.userId]);
    if ((usage.rows[0]?.pending ?? this.limits.pendingTasks) >= this.limits.pendingTasks) return this.deny(subject, clock, 'pending_quota');
    const count = await this.incrementRate('agent_task_create_minute', subject, clock);
    if (count > this.limits.tasksPerMinute) return this.deny(subject, clock, 'creation_rate_limit');
    return { allowed: true, replay: false, databaseTime: clock };
  }

  /** Compatibility admission used by AgentTaskStore until every caller supplies a claim request id. */
  async authorizeTask(userId: string, at: Date): Promise<Readonly<{ allowed: boolean; reason?: string }>> {
    void at; // Admission always uses the database clock.
    const subject = this.subject(userId);
    const clock = await this.lockAndClock(subject);
    const usage = await this.sql.query<{ active: number }>(`SELECT count(*)::int AS active FROM app.agent_tasks WHERE user_id=$1 AND state='leased'`, [userId]);
    if ((usage.rows[0]?.active ?? this.limits.concurrentTasks) >= this.limits.concurrentTasks) return this.deny(subject, clock, 'concurrency');
    const count = await this.incrementRate('agent_task_claim_minute', subject, clock);
    if (count > this.limits.claimsPerMinute) return this.deny(subject, clock, 'claim_rate_limit');
    return { allowed: true };
  }

  /** Claim-path guard for AgentTaskStore: call after locking the task and before creating a lease. */
  async authorizeTaskClaim(input: { userId: string; taskId: string; requestId: string }): Promise<OperationalAdmission> {
    const subject = this.subject(input.userId);
    const clock = await this.lockAndClock(subject);
    const replay = await this.sql.query<{ present: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM app.agent_task_delivery_attempts WHERE task_id=$1 AND request_id=$2) AS present`, [input.taskId, input.requestId]);
    if (replay.rows[0]?.present) return { allowed: true, replay: true, databaseTime: clock };
    const usage = await this.sql.query<{ active: number }>(`SELECT count(*)::int AS active FROM app.agent_tasks
      WHERE user_id=$1 AND state='leased'`, [input.userId]);
    if ((usage.rows[0]?.active ?? this.limits.concurrentTasks) >= this.limits.concurrentTasks) return this.deny(subject, clock, 'concurrency');
    const count = await this.incrementRate('agent_task_claim_minute', subject, clock);
    if (count > this.limits.claimsPerMinute) return this.deny(subject, clock, 'claim_rate_limit');
    return { allowed: true, replay: false, databaseTime: clock };
  }

  private subject(userId: string): string {
    return `hmusr_v1_${createHmac('sha256', this.pseudonymKey).update(userId).digest('base64url')}`;
  }
  private async lockAndClock(subject: string): Promise<Date> {
    const result = await this.sql.query<{ database_time: Date }>(`SELECT clock_timestamp() AS database_time,
      pg_advisory_xact_lock(hashtextextended($1, 0))`, [subject]);
    const at = result.rows[0]?.database_time;
    if (!at) throw new Error('operational admission database clock unavailable');
    return new Date(at);
  }
  private async incrementRate(bucket: string, subject: string, at: Date): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`INSERT INTO app.rate_limits(bucket,subject_hash,count,window_started_at,updated_at)
      VALUES($1,$2,1,date_trunc('minute',$3::timestamptz),$3)
      ON CONFLICT(bucket,subject_hash) DO UPDATE SET
        count=CASE WHEN app.rate_limits.window_started_at < date_trunc('minute',$3::timestamptz) THEN 1 ELSE app.rate_limits.count+1 END,
        window_started_at=CASE WHEN app.rate_limits.window_started_at < date_trunc('minute',$3::timestamptz) THEN date_trunc('minute',$3::timestamptz) ELSE app.rate_limits.window_started_at END,
        updated_at=$3 RETURNING count`, [bucket, subject, at]);
    const count = result.rows[0]?.count;
    if (count === undefined) throw new Error('operational admission rate counter unavailable');
    return count;
  }
  private async deny(subject: string, at: Date, reason: OperationalDenial): Promise<OperationalAdmission> {
    await this.sql.query(`INSERT INTO app.audits(occurred_at,actor_type,actor_id,event,correlation_id,metadata)
      VALUES($1,'system','operational_guard','task_admission_denied',$2,jsonb_build_object('reasonCode',$3))`,
    [at, `hmadm_v1_${subject.slice('hmusr_v1_'.length, 'hmusr_v1_'.length + 32)}`, reason]);
    return { allowed: false, reason, databaseTime: at };
  }
}
