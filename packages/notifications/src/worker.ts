import { createPushPayload, type DeliveryAttempt, type NotificationInput } from './domain.js';
import { isRetryableFailure, isStaleSubscription, type NotificationPersistence, type VapidPushTransport } from './ports.js';

export type NotificationWorkerOptions = Readonly<{ maxAttempts?: number }>;
export type DeliverySummary = Readonly<{ notificationId: string; delivered: number; retryableFailures: number; permanentFailures: number; skipped: number }>;

/**
 * Delivers a single logical notification. Persistence owns atomic claims, making replays and
 * concurrent workers harmless. Attempts are bounded and recorded before any provider call.
 */
export class NotificationWorker {
  readonly maxAttempts: number;

  constructor(private readonly persistence: NotificationPersistence, private readonly transport: VapidPushTransport, options: NotificationWorkerOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  }

  async deliver(input: NotificationInput): Promise<DeliverySummary> {
    const notification = await this.persistence.ensureLogicalNotification(input);
    if (notification.state === 'delivered' || notification.state === 'suppressed') {
      return { notificationId: notification.notificationId, delivered: 0, retryableFailures: 0, permanentFailures: 0, skipped: 1 };
    }
    // A retryable delivery leaves the logical notification failed and visible. A
    // later durable queue invocation performs the legal failed -> pending retry.
    if (notification.state === 'failed') await this.persistence.updateNotificationState(notification.notificationId, 'pending');
    await this.persistence.updateNotificationState(notification.notificationId, 'delivering');
    const payload = createPushPayload(notification);
    const summary = { notificationId: notification.notificationId, delivered: 0, retryableFailures: 0, permanentFailures: 0, skipped: 0 };
    let attempted = false;
    const subscriptions = await this.persistence.listEnabledSubscriptions(notification.userId);
    if (subscriptions.length === 0) {
      await this.persistence.updateNotificationState(notification.notificationId, 'suppressed');
      return summary;
    }

    for (const subscription of subscriptions) {
      const attempt = await this.persistence.claimDelivery(notification.notificationId, subscription.id, this.maxAttempts);
      if (!attempt) { summary.skipped++; continue; }
      attempted = true;
      await this.sendAttempt(attempt, subscription, payload, summary);
    }
    // Retryable attempts deliberately end this invocation. A later queue delivery claims the
    // next durable attempt instead of tight-looping provider calls in this process.
    // A second worker that acquired no claim must not overwrite an in-flight terminal result.
    if (attempted) await this.persistence.updateNotificationState(notification.notificationId, summary.delivered > 0 ? 'delivered' : 'failed');
    return summary;
  }

  private async sendAttempt(attempt: DeliveryAttempt, subscription: Awaited<ReturnType<NotificationPersistence['listEnabledSubscriptions']>>[number], payload: ReturnType<typeof createPushPayload>, summary: { delivered: number; retryableFailures: number; permanentFailures: number }): Promise<void> {
    const result = await this.transport.send(subscription, payload);
    if (result.ok) {
      await this.persistence.finishDelivery(attempt, 'succeeded', result.statusCode === undefined ? undefined : { responseCode: result.statusCode });
      await this.persistence.markSubscriptionSucceeded(subscription.id);
      summary.delivered++;
      return;
    }
    const { failure } = result;
    const detail = { ...(failure.statusCode === undefined ? {} : { responseCode: failure.statusCode }), ...(failure.code === undefined ? {} : { errorCode: failure.code }) };
    if (isStaleSubscription(failure)) {
      await this.persistence.finishDelivery(attempt, 'permanent_failure', detail);
      await this.persistence.disableSubscription(subscription.id);
      summary.permanentFailures++;
      return;
    }
    if (isRetryableFailure(failure) && attempt.attempt < this.maxAttempts) {
      await this.persistence.finishDelivery(attempt, 'retryable', detail);
      summary.retryableFailures++;
      return;
    }
    await this.persistence.finishDelivery(attempt, 'permanent_failure', detail);
    summary.permanentFailures++;
  }
}

/** Explicit helper for callers that want a function rather than an instance. */
export async function deliverNotification(persistence: NotificationPersistence, transport: VapidPushTransport, input: NotificationInput, options?: NotificationWorkerOptions): Promise<DeliverySummary> {
  return new NotificationWorker(persistence, transport, options).deliver(input);
}
