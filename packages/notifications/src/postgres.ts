import type { DeliveryAttempt, DeliveryState, LogicalNotification, NotificationInput, NotificationState, PushSubscription } from './domain.js';
import type { NotificationPersistence, PushSubscriptionInput, PushSubscriptionLifecycle } from './ports.js';

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

/** Compatible with pg's Pool, PoolClient, and transaction-scoped query clients. */
export interface PostgreSqlClient {
  query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
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
};
type SubscriptionRow = Record<string, unknown> & { id: string; endpoint_ciphertext: string; p256dh_ciphertext: string; auth_ciphertext: string };
type AttemptRow = Record<string, unknown> & { attempt: number };

/** PostgreSQL implementation using only parameterized queries. It never logs subscription material. */
export class PostgresNotificationPersistence implements NotificationPersistence, PushSubscriptionLifecycle {
  constructor(private readonly db: PostgreSqlClient, private readonly codec: PushSubscriptionCryptoCodec) {}

  async ensureLogicalNotification(input: NotificationInput): Promise<LogicalNotification> {
    const result = await this.db.query<NotificationRow>(`
      INSERT INTO app.logical_notifications (activity_id, state, sender_label, subject, status_label)
      VALUES ($1, 'pending', $2, $3, $4)
      ON CONFLICT (activity_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, activity_id, state, sender_label, subject, status_label
    `, [input.activityId, input.senderLabel, input.subject, input.statusLabel]);
    const row = requireRow(result.rows[0], 'logical notification');
    return { notificationId: row.id, activityId: row.activity_id, userId: input.userId, senderLabel: row.sender_label, subject: row.subject, statusLabel: row.status_label, state: row.state };
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
    const result = await this.db.query<AttemptRow>(`
      WITH locked_notification AS (
        SELECT id FROM app.logical_notifications
        WHERE id = $1 AND state IN ('pending', 'delivering')
        FOR UPDATE
      ), next_attempt AS (
        SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
        FROM app.notification_deliveries
        WHERE notification_id = $1 AND subscription_id = $2
      )
      INSERT INTO app.notification_deliveries (notification_id, subscription_id, attempt, state)
      SELECT $1, $2, next_attempt.attempt, 'pending'
      FROM locked_notification CROSS JOIN next_attempt
      WHERE next_attempt.attempt <= $3
        AND NOT EXISTS (
          SELECT 1 FROM app.notification_deliveries
          WHERE notification_id = $1 AND subscription_id = $2 AND state = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.notification_deliveries
          WHERE notification_id = $1 AND subscription_id = $2 AND state IN ('succeeded', 'permanent_failure')
        )
      ON CONFLICT (notification_id, subscription_id, attempt) DO NOTHING
      RETURNING attempt
    `, [notificationId, subscriptionId, maxAttempts]);
    const row = result.rows[0];
    return row === undefined ? null : { notificationId, subscriptionId, attempt: row.attempt };
  }

  async finishDelivery(attempt: DeliveryAttempt, state: DeliveryState, detail?: Readonly<{ responseCode?: number; errorCode?: string }>): Promise<void> {
    await this.db.query(`
      UPDATE app.notification_deliveries
      SET state = $4, response_code = $5, error_code = $6, finished_at = NOW()
      WHERE notification_id = $1 AND subscription_id = $2 AND attempt = $3 AND state = 'pending'
    `, [attempt.notificationId, attempt.subscriptionId, attempt.attempt, state, detail?.responseCode ?? null, detail?.errorCode ?? null]);
  }

  async markSubscriptionSucceeded(subscriptionId: string): Promise<void> {
    await this.db.query('UPDATE app.push_subscriptions SET last_success_at = NOW(), updated_at = NOW() WHERE id = $1', [subscriptionId]);
  }

  async disableSubscription(subscriptionId: string): Promise<void> {
    await this.db.query('UPDATE app.push_subscriptions SET disabled_at = COALESCE(disabled_at, NOW()), updated_at = NOW() WHERE id = $1', [subscriptionId]);
  }

  async updateNotificationState(notificationId: string, state: NotificationState): Promise<void> {
    await this.db.query(`
      UPDATE app.logical_notifications SET state = $2, updated_at = NOW()
      WHERE id = $1 AND (
        state = $2
        OR (state = 'pending' AND $2 IN ('delivering', 'suppressed'))
        OR (state = 'delivering' AND $2 IN ('delivered', 'failed'))
        OR (state = 'failed' AND $2 IN ('pending', 'suppressed'))
      )
    `, [notificationId, state]);
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
