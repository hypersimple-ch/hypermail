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


  async purgeExpiredOAuth(cutoff: Date, at: Date, limit: number): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`
      WITH candidates AS MATERIALIZED (
        SELECT kind, id FROM (
          SELECT 'authorization_code'::text kind, code_digest id, expires_at due FROM app.oauth_authorization_codes WHERE expires_at <= $1
          UNION ALL SELECT 'consent_request', request_digest, expires_at FROM app.oauth_consent_requests WHERE expires_at <= $1
          UNION ALL SELECT 'token', token_digest, expires_at FROM app.oauth_tokens WHERE expires_at <= $1
        ) expired ORDER BY due, kind, id LIMIT $3
      ), deleted_codes AS (
        DELETE FROM app.oauth_authorization_codes o USING candidates c WHERE c.kind='authorization_code' AND o.code_digest=c.id RETURNING 1
      ), deleted_consents AS (
        DELETE FROM app.oauth_consent_requests o USING candidates c WHERE c.kind='consent_request' AND o.request_digest=c.id RETURNING 1
      ), deleted_tokens AS (
        DELETE FROM app.oauth_tokens o USING candidates c WHERE c.kind='token' AND o.token_digest=c.id RETURNING 1
      ), total AS (
        SELECT count(*)::int count FROM (SELECT * FROM deleted_codes UNION ALL SELECT * FROM deleted_consents UNION ALL SELECT * FROM deleted_tokens) d
      ), audited AS (
        INSERT INTO app.audits (occurred_at,actor_type,actor_id,event,correlation_id,metadata)
        SELECT $2,'system','lifecycle','oauth_records_purged','lifecycle:oauth:'||extract(epoch from $2)::text,jsonb_build_object('count',count,'retentionCutoff',$1)
        FROM total WHERE count>0
      ) SELECT count FROM total
    `, [cutoff, at, limit]);
    return result.rows[0]?.count ?? 0;
  }

  async purgeExpiredSessions(cutoff: Date, at: Date, limit: number): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`
      WITH candidates AS MATERIALIZED (
        SELECT kind,id FROM (
          SELECT 'session'::text kind,id::text,expires_at due FROM app.sessions WHERE expires_at <= $1
          UNION ALL SELECT 'auth_session',id,"expiresAt" FROM app.auth_sessions WHERE "expiresAt" <= $1
          UNION ALL SELECT 'oauth_family',id::text,expires_at FROM app.oauth_token_families WHERE expires_at <= $1
            AND NOT EXISTS (SELECT 1 FROM app.oauth_tokens t WHERE t.family_id=oauth_token_families.id)
        ) expired ORDER BY due,kind,id LIMIT $3
      ), deleted_sessions AS (
        DELETE FROM app.sessions s USING candidates c WHERE c.kind='session' AND s.id::text=c.id RETURNING 1
      ), deleted_auth_sessions AS (
        DELETE FROM app.auth_sessions s USING candidates c WHERE c.kind='auth_session' AND s.id=c.id RETURNING 1
      ), deleted_families AS (
        DELETE FROM app.oauth_token_families f USING candidates c WHERE c.kind='oauth_family' AND f.id::text=c.id RETURNING 1
      ), total AS (
        SELECT count(*)::int count FROM (SELECT * FROM deleted_sessions UNION ALL SELECT * FROM deleted_auth_sessions UNION ALL SELECT * FROM deleted_families) d
      ), audited AS (
        INSERT INTO app.audits (occurred_at,actor_type,actor_id,event,correlation_id,metadata)
        SELECT $2,'system','lifecycle','expired_sessions_purged','lifecycle:sessions:'||extract(epoch from $2)::text,jsonb_build_object('count',count,'retentionCutoff',$1)
        FROM total WHERE count>0
      ) SELECT count FROM total
    `, [cutoff, at, limit]);
    return result.rows[0]?.count ?? 0;
  }

  async minimizeTerminalTaskPayloads(cutoff: Date, at: Date, limit: number): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`
      WITH candidates AS MATERIALIZED (
        SELECT id FROM app.agent_tasks
        WHERE state='completed' AND result IS NOT NULL AND result->>'kind'<>'redacted'
          AND completed_at <= $1
        ORDER BY completed_at,id LIMIT $3 FOR UPDATE SKIP LOCKED
      ), minimized_reports AS (
        UPDATE app.agent_task_reports r
        SET response_snapshot=jsonb_set(r.response_snapshot,'{task,result}',jsonb_build_object('kind','redacted'))
        FROM candidates c WHERE r.task_id=c.id
          AND r.response_snapshot #>> '{task,state}'='completed'
          AND r.response_snapshot #>> '{task,result,kind}'<>'redacted' RETURNING r.id
      ), minimized AS (
        UPDATE app.agent_tasks t SET result=jsonb_build_object('kind','redacted'),updated_at=$2
        FROM candidates c WHERE t.id=c.id RETURNING t.id
      ), total AS (SELECT count(*)::int count FROM minimized), audited AS (
        INSERT INTO app.audits (occurred_at,actor_type,actor_id,event,correlation_id,metadata)
        SELECT $2,'system','lifecycle','terminal_task_payloads_minimized','lifecycle:task-payload:'||extract(epoch from $2)::text,jsonb_build_object('count',count,'retentionCutoff',$1)
        FROM total WHERE count>0
      ) SELECT count FROM total
    `, [cutoff, at, limit]);
    return result.rows[0]?.count ?? 0;
  }

  async purgeOperationalText(cutoff: Date, at: Date, limit: number): Promise<number> {
    const result = await this.sql.query<{ count: number }>(`
      WITH candidates AS MATERIALIZED (
        SELECT id FROM app.agent_task_outbox WHERE published_at <= $1 AND last_error IS NOT NULL
        ORDER BY published_at,id LIMIT $3 FOR UPDATE SKIP LOCKED
      ), purged AS (
        UPDATE app.agent_task_outbox o SET last_error=NULL FROM candidates c WHERE o.id=c.id AND o.last_error IS NOT NULL RETURNING o.id
      ), total AS (SELECT count(*)::int count FROM purged), audited AS (
        INSERT INTO app.audits (occurred_at,actor_type,actor_id,event,correlation_id,metadata)
        SELECT $2,'system','lifecycle','operational_text_purged','lifecycle:operational-text:'||extract(epoch from $2)::text,jsonb_build_object('count',count,'retentionCutoff',$1)
        FROM total WHERE count>0
      ) SELECT count FROM total
    `, [cutoff, at, limit]);
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
