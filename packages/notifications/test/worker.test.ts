/* eslint-disable @typescript-eslint/require-await -- concise deterministic async port doubles */
import { describe, expect, it } from 'vitest';
import { NotificationWorker, type DeliveryAttempt, type DeliveryState, type LogicalNotification, type NotificationInput, type NotificationPersistence, type PushSubscription, type VapidPushTransport } from '../src/index.js';

const input: NotificationInput = { notificationId: 'n1', activityId: 'a1', userId: 'u1', senderLabel: 'Alice', subject: 'Action needed', statusLabel: 'waiting' };
class MemoryPersistence implements NotificationPersistence {
  notification: LogicalNotification | undefined;
  readonly subscriptions: PushSubscription[] = [{ id: 's1', endpoint: 'https://push.example/1', p256dh: 'key', auth: 'auth' }];
  readonly deliveries: Array<{ attempt: DeliveryAttempt; state: DeliveryState }> = [];
  disabled: string[] = [];
  async ensureLogicalNotification(value: NotificationInput) { return this.notification ??= { ...value, state: 'pending' }; }
  async listEnabledSubscriptions() { return this.subscriptions.filter((s) => !this.disabled.includes(s.id)); }
  async claimDelivery(notificationId: string, subscriptionId: string, max: number) {
    const records = this.deliveries.filter((d) => d.attempt.notificationId === notificationId && d.attempt.subscriptionId === subscriptionId);
    if (records.some((d) => d.state === 'pending' || d.state === 'succeeded' || d.state === 'permanent_failure') || records.length >= max) return null;
    const attempt = { notificationId, subscriptionId, attempt: records.length + 1 }; this.deliveries.push({ attempt, state: 'pending' }); return attempt;
  }
  async finishDelivery(attempt: DeliveryAttempt, state: DeliveryState) { const record = this.deliveries.find((d) => d.attempt === attempt); if (record) record.state = state; }
  async markSubscriptionSucceeded() { /* durable DB adapter writes last_success_at */ }
  async disableSubscription(subscriptionId: string) { this.disabled.push(subscriptionId); }
  async updateNotificationState(_id: string, state: LogicalNotification['state']) { if (this.notification) this.notification = { ...this.notification, state }; }
}

describe('notification worker', () => {
  it('deduplicates replay and projects an adversarial input into the redacted payload', async () => {
    const store = new MemoryPersistence(); const sent: unknown[] = [];
    const transport: VapidPushTransport = { async send(_subscription, payload) { sent.push(payload); return { ok: true }; } };
    const unsafe = { ...input, body: 'secret body', preview: 'secret preview', address: 'alice@example.test' };
    const worker = new NotificationWorker(store, transport);
    await worker.deliver(unsafe); await worker.deliver(unsafe);
    expect(sent).toEqual([{ notificationId: 'n1', activityId: 'a1', senderLabel: 'Alice', subject: 'Action needed', statusLabel: 'waiting' }]);
    expect(JSON.stringify(sent)).not.toContain('secret');
  });

  it('persists a retry for a future queue invocation and makes the bounded replay permanent', async () => {
    const store = new MemoryPersistence(); let calls = 0;
    const worker = new NotificationWorker(store, { async send() { calls++; return { ok: false, failure: { statusCode: 503, code: 'unavailable' } }; } }, { maxAttempts: 2 });
    await worker.deliver(input);
    expect(calls).toBe(1); expect(store.deliveries.map((d) => d.state)).toEqual(['retryable']); expect(store.notification?.state).toBe('failed');
    await worker.deliver(input);
    expect(calls).toBe(2); expect(store.deliveries.map((d) => d.state)).toEqual(['retryable', 'permanent_failure']); expect(store.notification?.state).toBe('failed');
  });

  it.each([404, 410])('disables stale %i subscriptions and does not retry permanent provider failures', async (statusCode) => {
    const store = new MemoryPersistence();
    const worker = new NotificationWorker(store, { async send() { return { ok: false, failure: { statusCode } }; } });
    await worker.deliver(input);
    expect(store.disabled).toEqual(['s1']); expect(store.deliveries).toHaveLength(1); expect(store.deliveries[0]?.state).toBe('permanent_failure');
  });
});
