import { createPushPayload, type DeliveryAttempt, type NotificationCounts, type NotificationInput, type NotificationState, type PushPayload, type PushSubscription } from './domain.js';
import { isRetryableFailure, isStaleSubscription, type NotificationPersistence, type PushSendResult, type VapidPushTransport } from './ports.js';

export type NotificationWorkerOptions = Readonly<{ maxAttempts?: number }>;
export type DeliverySummary = NotificationCounts & Readonly<{ notificationId: string; state: NotificationState; delivered: number; retryableFailures: number; permanentFailures: number; skipped: number }>;

/** Claims commit before provider calls. Logical completion is derived from all durable targets. */
export class NotificationWorker {
  readonly maxAttempts: number;
  constructor(private readonly persistence: NotificationPersistence, private readonly transport: VapidPushTransport, options: NotificationWorkerOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 3) throw new Error('maxAttempts must be between 1 and 3');
  }

  async deliver(input: NotificationInput): Promise<DeliverySummary> {
    const notification = await this.persistence.ensureLogicalNotification(input);
    if (notification.state === 'delivered' || notification.state === 'suppressed') {
      return { notificationId: notification.notificationId, state: notification.state, deliveredCount: notification.deliveredCount, failedCount: notification.failedCount, pendingCount: notification.pendingCount, delivered: 0, retryableFailures: 0, permanentFailures: 0, skipped: 1 };
    }
    await this.persistence.initializeTargets(notification.notificationId, notification.userId);
    const summary = { notificationId: notification.notificationId, state: notification.state as NotificationState, deliveredCount: notification.deliveredCount, failedCount: notification.failedCount, pendingCount: notification.pendingCount, delivered: 0, retryableFailures: 0, permanentFailures: 0, skipped: 0 };
    const payload = createPushPayload(notification);
    for (const subscription of await this.persistence.listEnabledSubscriptions(notification.userId)) {
      const attempt = await this.persistence.claimDelivery(notification.notificationId, subscription.id, this.maxAttempts);
      if (!attempt) { summary.skipped++; continue; }
      await this.sendAttempt(attempt, subscription, payload, summary);
    }
    summary.state = await this.persistence.finalizeNotification(notification.notificationId);
    const aggregate = await this.persistence.ensureLogicalNotification(input);
    summary.deliveredCount = aggregate.deliveredCount;
    summary.failedCount = aggregate.failedCount;
    summary.pendingCount = aggregate.pendingCount;
    return summary;
  }

  private async sendAttempt(attempt: DeliveryAttempt, subscription: PushSubscription, payload: PushPayload, summary: { delivered: number; retryableFailures: number; permanentFailures: number }): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let result: PushSendResult;
    try {
      const timeout = Promise.withResolvers<PushSendResult>();
      timer = setTimeout(() => { timeout.resolve({ ok: false, failure: { code: 'PUSH_PROVIDER_TIMEOUT' } }); }, 30_000);
      result = await Promise.race([
        this.transport.send(subscription, payload),
        timeout.promise,
      ]);
    } catch {
      result = { ok: false, failure: { code: 'PUSH_PROVIDER_UNAVAILABLE' } };
    } finally {
      clearTimeout(timer);
    }
    if (result.ok) {
      if (await this.persistence.finishDelivery(attempt, 'succeeded', result.statusCode === undefined ? undefined : { responseCode: result.statusCode })) {
        await this.persistence.markSubscriptionSucceeded(subscription.id);
        summary.delivered++;
      }
      return;
    }
    const { failure } = result;
    const detail = { ...(failure.statusCode === undefined ? {} : { responseCode: failure.statusCode }), ...(failure.code === undefined ? {} : { errorCode: failure.code }) };
    const retryable = isRetryableFailure(failure) && attempt.attempt < this.maxAttempts;
    if (!(await this.persistence.finishDelivery(attempt, retryable ? 'retryable' : 'permanent_failure', detail))) return;
    if (isStaleSubscription(failure)) await this.persistence.disableSubscription(subscription.id);
    if (retryable) summary.retryableFailures++; else summary.permanentFailures++;
  }
}

export async function deliverNotification(persistence: NotificationPersistence, transport: VapidPushTransport, input: NotificationInput, options?: NotificationWorkerOptions): Promise<DeliverySummary> {
  return new NotificationWorker(persistence, transport, options).deliver(input);
}
