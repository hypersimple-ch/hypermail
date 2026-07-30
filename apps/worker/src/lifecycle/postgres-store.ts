import type { SqlClient } from '../postgres-store.js';
import type { LifecycleStore } from './retention.js';

/** Parameterized PostgreSQL lifecycle storage. Cache deletion and audit insertion are atomic. */
export class PostgresLifecycleStore implements LifecycleStore {
  constructor(private readonly sql: SqlClient) {}

  async purgeCachedBodies(cutoff: Date, at: Date, limit: number): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`
      WITH candidates AS (
        SELECT b.message_id, m.account_id
        FROM app.message_bodies b
        JOIN app.messages m ON m.id = b.message_id
        WHERE b.cached_at <= $1 AND b.purge_after <= $2
        ORDER BY b.purge_after, b.message_id
        LIMIT $3
        FOR UPDATE OF b SKIP LOCKED
      ), purged AS (
        DELETE FROM app.message_bodies b
        USING candidates c
        WHERE b.message_id = c.message_id
        RETURNING b.message_id, c.account_id
      ), audited AS (
        INSERT INTO app.audits (occurred_at, actor_type, actor_id, account_id, event, correlation_id, metadata)
        SELECT $2, 'system', 'lifecycle', p.account_id, 'message_body_purged',
          'lifecycle:body-purge:' || p.message_id::text,
          jsonb_build_object('messageId', p.message_id, 'retentionCutoff', $1)
        FROM purged p
      )
      SELECT count(*)::int AS count FROM purged
    `, [cutoff, at, limit]);
    return result.rows[0]?.count ?? 0;
  }

  async disableExpiredPushSubscriptions(at: Date, limit: number): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`
      WITH candidates AS (
        SELECT id
        FROM app.push_subscriptions
        WHERE disabled_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1
        ORDER BY expires_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      ), disabled AS (
        UPDATE app.push_subscriptions s
        SET disabled_at = $1, updated_at = $1
        FROM candidates c
        WHERE s.id = c.id AND s.disabled_at IS NULL
        RETURNING s.id
      ), audited AS (
        INSERT INTO app.audits (occurred_at, actor_type, actor_id, event, correlation_id, metadata)
        SELECT $1, 'system', 'lifecycle', 'push_subscription_expired',
          'lifecycle:push-expiry:' || d.id::text,
          jsonb_build_object('subscriptionId', d.id, 'reason', 'expired')
        FROM disabled d
      )
      SELECT count(*)::int AS count FROM disabled
    `, [at, limit]);
    return result.rows[0]?.count ?? 0;
  }

  acquireLease(name: string, holderId: string, now: Date, ttlMilliseconds: number): Promise<boolean> {
    const expires = new Date(now.valueOf() + ttlMilliseconds);
    return this.sql.query<{ holder_id: string }>(`
      INSERT INTO app.scheduler_leases (name, holder_id, fencing_token, acquired_at, expires_at)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (name) DO UPDATE SET
        holder_id = EXCLUDED.holder_id,
        fencing_token = app.scheduler_leases.fencing_token + 1,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
      WHERE app.scheduler_leases.expires_at <= $3 OR app.scheduler_leases.holder_id = $2
      RETURNING holder_id
    `, [name, holderId, now, expires]).then((result) => result.rows.length === 1);
  }
}
