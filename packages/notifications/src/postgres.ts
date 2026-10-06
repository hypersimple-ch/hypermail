import type { DeliveryAttempt, DeliveryState, LogicalNotification, NotificationInput, NotificationState, PushSubscription } from './domain.js';
import type { NotificationPersistence, PushSubscriptionInput, PushSubscriptionLifecycle } from './ports.js';

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

/** Compatible with pg's Pool, PoolClient, and transaction-scoped query clients. */
export interface PostgreSqlClient {
  query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  transaction<T>(operation: (client: PostgreSqlClient) => Promise<T>): Promise<T>;
}

/** Encryption stays outside this adapter so key management is an application concern. */
export interface PushSubscriptionCryptoCodec {
  encrypt(value: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  hashEndpoint(endpoint: string): Promise<string>;
}

type NotificationRow = Record<string, unknown> & {
  id: string;
  activity_id: string;
  state: NotificationState;
  sender_label: string;
  subject: string;
  status_label: string;
  delivered_count: number;
  failed_count: number;
  pending_count: number;
};
type SubscriptionRow = Record<string, unknown> & { id: string; endpoint_ciphertext: string; p256dh_ciphertext: string; auth_ciphertext: string };
type AttemptRow = Record<string, unknown> & { attempt: number; claim_token: string };

/** PostgreSQL implementation using only parameterized queries. It never logs subscription material. */
export class PostgresNotificationPersistence implements NotificationPersistence, PushSubscriptionLifecycle {
  constructor(private readonly db: PostgreSqlClient, private readonly codec: PushSubscriptionCryptoCodec) {}

  async ensureLogicalNotification(input: NotificationInput): Promise<LogicalNotification> {
    const result = await this.db.query<NotificationRow>(`
      INSERT INTO app.logical_notifications (activity_id, state, sender_label, subject, status_label)
      VALUES ($1, 'pending', $2, $3, $4)
      ON CONFLICT (activity_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, activity_id, state, sender_label, subject, status_label, delivered_count, failed_count, pending_count
    `, [input.activityId, input.senderLabel, input.subject, input.statusLabel]);
    const row = requireRow(result.rows[0], 'logical notification');
    return { notificationId: row.id, activityId: row.activity_id, userId: input.userId, senderLabel: row.sender_label, subject: row.subject, statusLabel: row.status_label, state: row.state, deliveredCount: row.delivered_count, failedCount: row.failed_count, pendingCount: row.pending_count };
  }

  async initializeTargets(notificationId: string, userId: string): Promise<void> {
    await this.db.transaction(async (db) => {
      const locked = await db.query<Record<string, unknown> & { targets_initialized_at: unknown }>(
        'SELECT targets_initialized_at FROM app.logical_notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      if (!locked.rows[0] || locked.rows[0].targets_initialized_at !== null) return;
      await db.query(`INSERT INTO app.notification_targets(notification_id,subscription_id)
        SELECT $1,id FROM app.push_subscriptions WHERE user_id=$2 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())
        ON CONFLICT DO NOTHING`, [notificationId, userId]);
      await db.query(`UPDATE app.logical_notifications SET targets_initialized_at=NOW(),
        pending_count=(SELECT count(*)::integer FROM app.notification_targets WHERE notification_id=$1 AND state='pending')
        WHERE id=$1`, [notificationId]);
    });
  }

  async listEnabledSubscriptions(userId: string): Promise<readonly PushSubscription[]> {
    const result = await this.db.query<SubscriptionRow>(`
      SELECT id, endpoint_ciphertext, p256dh_ciphertext, auth_ciphertext
      FROM app.push_subscriptions
      WHERE user_id = $1 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
    `, [userId]);
    return Promise.all(result.rows.map(async (row) => ({
      id: row.id,
      endpoint: await this.codec.decrypt(row.endpoint_ciphertext),
      p256dh: await this.codec.decrypt(row.p256dh_ciphertext),
      auth: await this.codec.decrypt(row.auth_ciphertext),
    })));
  }

  async claimDelivery(notificationId: string, subscriptionId: string, maxAttempts: number): Promise<DeliveryAttempt | null> {
    return this.db.transaction(async (db) => {
      await db.query('SELECT id FROM app.logical_notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      await db.query(`UPDATE app.notification_deliveries SET state='retryable',error_code='DELIVERY_LEASE_EXPIRED',
        finished_at=NOW(),claim_expires_at=NULL WHERE notification_id=$1 AND subscription_id=$2
        AND state='pending' AND claim_expires_at<=NOW()`, [notificationId, subscriptionId]);
      const result = await db.query<AttemptRow>(`
        INSERT INTO app.notification_deliveries(notification_id,subscription_id,attempt,state,claim_token,claim_expires_at)
        SELECT $1,$2,COALESCE((SELECT MAX(attempt) FROM app.notification_deliveries WHERE notification_id=$1 AND subscription_id=$2),0)+1,
          'pending',gen_random_uuid(),NOW()+interval '120 seconds'
        FROM app.notification_targets t JOIN app.push_subscriptions s ON s.id=t.subscription_id
        WHERE t.notification_id=$1 AND t.subscription_id=$2 AND t.state='pending'
          AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>NOW())
          AND NOT EXISTS(SELECT 1 FROM app.notification_deliveries WHERE notification_id=$1 AND subscription_id=$2
            AND (state IN ('pending','succeeded','permanent_failure') OR attempt >= $3))
        RETURNING attempt,claim_token`, [notificationId, subscriptionId, Math.min(maxAttempts, 3)]);
      if (result.rows[0]) await db.query("UPDATE app.logical_notifications SET state='delivering',updated_at=NOW() WHERE id=$1", [notificationId]);
      const row = result.rows[0];
      return row ? { notificationId, subscriptionId, attempt: row.attempt, claimToken: row.claim_token } : null;
    });
  }

  async finishDelivery(attempt: DeliveryAttempt, state: DeliveryState, detail?: Readonly<{ responseCode?: number; errorCode?: string }>): Promise<boolean> {
    return this.db.transaction(async (db) => {
      await db.query('SELECT id FROM app.logical_notifications WHERE id=$1 FOR UPDATE', [attempt.notificationId]);
      const result = await db.query<Record<string, unknown> & { id: string }>(`
        UPDATE app.notification_deliveries SET state=$4,response_code=$5,error_code=$6,finished_at=NOW(),claim_expires_at=NULL
        WHERE notification_id=$1 AND subscription_id=$2 AND attempt=$3 AND state='pending'
          AND claim_token=$7 AND claim_expires_at>NOW() RETURNING id`,
      [attempt.notificationId, attempt.subscriptionId, attempt.attempt, state, detail?.responseCode ?? null, detail?.errorCode ?? null, attempt.claimToken]);
      if (!result.rows[0]) return false;
      await db.query(`UPDATE app.notification_targets SET state=$3,updated_at=NOW()
        WHERE notification_id=$1 AND subscription_id=$2 AND state='pending'`,
      [attempt.notificationId, attempt.subscriptionId, state === 'succeeded' ? 'delivered' : state === 'permanent_failure' ? 'failed' : 'pending']);
      return true;
    });
  }

  async markSubscriptionSucceeded(subscriptionId: string): Promise<void> {
    await this.db.query('UPDATE app.push_subscriptions SET last_success_at = NOW(), updated_at = NOW() WHERE id = $1', [subscriptionId]);
  }

  async disableSubscription(subscriptionId: string): Promise<void> {
    await this.db.query('UPDATE app.push_subscriptions SET disabled_at = COALESCE(disabled_at, NOW()), updated_at = NOW() WHERE id = $1', [subscriptionId]);
  }

  async finalizeNotification(notificationId: string): Promise<NotificationState> {
    return this.db.transaction(async (db) => {
      await db.query('SELECT id FROM app.logical_notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      await db.query(`UPDATE app.notification_deliveries SET state='retryable',error_code='DELIVERY_LEASE_EXPIRED',
        finished_at=NOW(),claim_expires_at=NULL WHERE notification_id=$1 AND state='pending' AND claim_expires_at<=NOW()`, [notificationId]);
      await db.query(`UPDATE app.notification_targets t SET state='suppressed',updated_at=NOW()
        FROM app.push_subscriptions s WHERE t.notification_id=$1 AND s.id=t.subscription_id
        AND t.state IN ('pending','failed') AND (s.disabled_at IS NOT NULL OR s.expires_at<=NOW())`, [notificationId]);
      await db.query(`UPDATE app.notification_targets t SET state='failed',updated_at=NOW()
        WHERE t.notification_id=$1 AND t.state='pending'
        AND NOT EXISTS(SELECT 1 FROM app.notification_deliveries d WHERE d.notification_id=t.notification_id AND d.subscription_id=t.subscription_id AND d.state='pending')
        AND EXISTS(SELECT 1 FROM app.notification_deliveries d WHERE d.notification_id=t.notification_id AND d.subscription_id=t.subscription_id AND (d.attempt>=3 OR d.state='permanent_failure'))`, [notificationId]);
      const result = await db.query<Record<string, unknown> & { state: NotificationState }>(`
        WITH counts AS (SELECT count(*) FILTER(WHERE state='delivered')::integer AS delivered,
          count(*) FILTER(WHERE state='failed')::integer AS failed,count(*) FILTER(WHERE state='pending')::integer AS pending
          FROM app.notification_targets WHERE notification_id=$1)
        UPDATE app.logical_notifications SET delivered_count=c.delivered,failed_count=c.failed,pending_count=c.pending,
          state=CASE
            WHEN EXISTS(SELECT 1 FROM app.notification_deliveries WHERE notification_id=$1 AND state='pending' AND claim_expires_at>NOW()) THEN 'delivering'::app.notification_state
            WHEN c.pending>0 THEN 'pending'::app.notification_state
            WHEN c.failed>0 THEN 'failed'::app.notification_state
            WHEN c.delivered>0 THEN 'delivered'::app.notification_state
            ELSE 'suppressed'::app.notification_state END,updated_at=NOW()
        FROM counts c WHERE id=$1 RETURNING state`, [notificationId]);
      return requireRow(result.rows[0], 'logical notification').state;
    });
  }

  async upsertSubscription(input: PushSubscriptionInput): Promise<string> {
    const [endpointHash, endpointCiphertext, p256dhCiphertext, authCiphertext] = await Promise.all([
      this.codec.hashEndpoint(input.endpoint), this.codec.encrypt(input.endpoint), this.codec.encrypt(input.p256dh), this.codec.encrypt(input.auth),
    ]);
    const result = await this.db.query<Record<string, unknown> & { id: string }>(`
      INSERT INTO app.push_subscriptions (user_id, endpoint_hash, endpoint_ciphertext, p256dh_ciphertext, auth_ciphertext, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (endpoint_hash) DO UPDATE SET
        user_id = EXCLUDED.user_id, endpoint_ciphertext = EXCLUDED.endpoint_ciphertext,
        p256dh_ciphertext = EXCLUDED.p256dh_ciphertext, auth_ciphertext = EXCLUDED.auth_ciphertext,
        expires_at = EXCLUDED.expires_at, disabled_at = NULL, updated_at = NOW()
      RETURNING id
    `, [input.userId, endpointHash, endpointCiphertext, p256dhCiphertext, authCiphertext, input.expiresAt ?? null]);
    return requireRow(result.rows[0], 'push subscription').id;
  }

  async unsubscribe(endpoint: string): Promise<void> {
    const endpointHash = await this.codec.hashEndpoint(endpoint);
    await this.db.query('UPDATE app.push_subscriptions SET disabled_at = COALESCE(disabled_at, NOW()), updated_at = NOW() WHERE endpoint_hash = $1', [endpointHash]);
  }
}

function requireRow<Row>(row: Row | undefined, name: string): Row {
  if (row === undefined) throw new Error(`${name} query returned no row`);
  return row;
}
