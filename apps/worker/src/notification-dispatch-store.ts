import type { ManagedSqlClient } from '@hypermail/db';
import type { NotificationDispatchStore } from './runtime.js';

/** Recover unfinished fan-out, not terminal partial failures or live delivery leases. */
export class PostgresNotificationDispatchStore implements NotificationDispatchStore {
  constructor(private readonly db: Pick<ManagedSqlClient, 'query'>) {}
  async pendingNotificationIds(limit: number): Promise<readonly string[]> {
    const result = await this.db.query<{ id: string }>(`
      SELECT n.id FROM app.logical_notifications n
      WHERE n.state IN ('pending','failed','delivering') AND (
        n.targets_initialized_at IS NULL
        OR EXISTS(SELECT 1 FROM app.notification_deliveries d WHERE d.notification_id=n.id AND d.state='pending' AND d.claim_expires_at<=NOW())
        OR EXISTS(SELECT 1 FROM app.notification_targets t WHERE t.notification_id=n.id AND t.state='pending'
          AND NOT EXISTS(SELECT 1 FROM app.notification_deliveries d WHERE d.notification_id=t.notification_id AND d.subscription_id=t.subscription_id AND d.state='pending' AND d.claim_expires_at>NOW()))
        OR EXISTS(SELECT 1 FROM app.notification_targets t JOIN app.push_subscriptions s ON s.id=t.subscription_id
          WHERE t.notification_id=n.id AND t.state IN ('pending','failed') AND (s.disabled_at IS NOT NULL OR s.expires_at<=NOW()))
        OR (n.state IN ('pending','delivering') AND NOT EXISTS(SELECT 1 FROM app.notification_deliveries d WHERE d.notification_id=n.id AND d.state='pending' AND d.claim_expires_at>NOW()))
      ) ORDER BY n.created_at,n.id LIMIT $1`, [limit]);
    return result.rows.map((row) => row.id);
  }
}
