/* eslint-disable @typescript-eslint/require-await -- deterministic async port doubles */
import { describe, expect, it, vi } from 'vitest';
import { NotificationWorker, type DeliveryAttempt, type DeliveryState, type LogicalNotification, type NotificationInput, type NotificationPersistence, type PushSubscription, type VapidPushTransport } from '../src/index.js';

const input: NotificationInput = { notificationId: 'n1', activityId: 'a1', userId: 'u1', senderLabel: 'Alice', subject: 'Action needed', statusLabel: 'waiting' };
class MemoryPersistence implements NotificationPersistence {
  notification: LogicalNotification | undefined;
  readonly subscriptions: PushSubscription[] = [{ id: 's1', endpoint: 'https://push.example/1', p256dh: 'key', auth: 'auth' }];
  readonly deliveries: Array<{ attempt: DeliveryAttempt; state: DeliveryState }> = [];
  targets: Map<string, string> | undefined;
  disabled: string[] = [];
  async ensureLogicalNotification(value: NotificationInput) { return this.notification ??= { ...value, state: 'pending', deliveredCount: 0, failedCount: 0, pendingCount: 0 }; }
  async initializeTargets() { this.targets ??= new Map(this.subscriptions.filter((s) => !this.disabled.includes(s.id)).map((s) => [s.id, 'pending'])); }
  async listEnabledSubscriptions() { return this.subscriptions.filter((s) => !this.disabled.includes(s.id)); }
  async claimDelivery(notificationId: string, subscriptionId: string, max: number) {
    const records = this.deliveries.filter((d) => d.attempt.subscriptionId === subscriptionId);
    if (this.targets?.get(subscriptionId) !== 'pending' || records.some((d) => d.state === 'pending') || records.length >= max) return null;
    const attempt = { notificationId, subscriptionId, attempt: records.length + 1, claimToken: `token-${subscriptionId}-${String(records.length)}` };
    this.deliveries.push({ attempt, state: 'pending' }); return attempt;
  }
  async finishDelivery(attempt: DeliveryAttempt, state: DeliveryState) {
    const record = this.deliveries.find((d) => d.attempt === attempt && d.state === 'pending');
    if (!record) return false;
    record.state = state; this.targets?.set(attempt.subscriptionId, state === 'succeeded' ? 'delivered' : state === 'permanent_failure' ? 'failed' : 'pending'); return true;
  }
  async markSubscriptionSucceeded() { /* metadata */ }
  async disableSubscription(subscriptionId: string) { this.disabled.push(subscriptionId); }
  async finalizeNotification() {
    for (const id of this.disabled) if (this.targets?.get(id) !== 'delivered') this.targets?.set(id, 'suppressed');
    const values = [...(this.targets?.values() ?? [])];
    const counts = { deliveredCount: values.filter((v) => v === 'delivered').length, failedCount: values.filter((v) => v === 'failed').length, pendingCount: values.filter((v) => v === 'pending').length };
    const state = this.deliveries.some((d) => d.state === 'pending') ? 'delivering' : counts.pendingCount ? 'pending' : counts.failedCount ? 'failed' : counts.deliveredCount ? 'delivered' : 'suppressed';
    if (this.notification) this.notification = { ...this.notification, ...counts, state };
    return state;
  }
}

function twoDevices() { const store = new MemoryPersistence(); store.subscriptions.push({ id: 's2', endpoint: 'https://push.example/2', p256dh: 'key', auth: 'auth' }); return store; }
describe('notification worker', () => {
  it('retries only the failed device and waits for all recipients', async () => {
    const store = twoDevices(); const calls: string[] = [];
    const worker = new NotificationWorker(store, { async send(s) { calls.push(s.id); return s.id === 's2' && calls.filter((id) => id === 's2').length === 1 ? { ok: false, failure: { statusCode: 503 } } : { ok: true }; } });
    await worker.deliver(input);
    expect(store.notification).toMatchObject({ state: 'pending', deliveredCount: 1, pendingCount: 1 });
    store.subscriptions.push({ id: 'late', endpoint: 'late', p256dh: 'key', auth: 'auth' });
    await worker.deliver(input); await worker.deliver(input);
    expect(calls).toEqual(['s1', 's2', 's2']);
    expect(store.notification).toMatchObject({ state: 'delivered', deliveredCount: 2, pendingCount: 0 });
  });
  it('exposes terminal partial failure after three attempts without resending successes', async () => {
    const store = twoDevices(); const calls: string[] = [];
    const worker = new NotificationWorker(store, { async send(s) { calls.push(s.id); return s.id === 's1' ? { ok: true } : { ok: false, failure: { statusCode: 503 } }; } });
    for (let i = 0; i < 4; i++) await worker.deliver(input);
    expect(calls).toEqual(['s1', 's2', 's2', 's2']);
    expect(store.notification).toMatchObject({ state: 'failed', deliveredCount: 1, failedCount: 1, pendingCount: 0 });
  });
  it('suppresses zero devices permanently and suppresses subsequently disabled recipients', async () => {
    const empty = new MemoryPersistence(); empty.subscriptions.length = 0;
    const send = vi.fn<VapidPushTransport['send']>();
    await new NotificationWorker(empty, { send }).deliver(input);
    empty.subscriptions.push({ id: 'late', endpoint: 'late', p256dh: 'key', auth: 'auth' });
    await new NotificationWorker(empty, { send }).deliver(input);
    expect(send).not.toHaveBeenCalled(); expect(empty.notification?.state).toBe('suppressed');
    const store = twoDevices(); const worker = new NotificationWorker(store, { async send(s) { return s.id === 's1' ? { ok: true } : { ok: false, failure: { statusCode: 503 } }; } });
    await worker.deliver(input); await store.disableSubscription('s2'); await worker.deliver(input);
    expect(store.notification).toMatchObject({ state: 'delivered', deliveredCount: 1, pendingCount: 0 });
  });
  it.each([404, 410])('disables stale %i endpoints', async (statusCode) => {
    const store = new MemoryPersistence(); const worker = new NotificationWorker(store, { async send() { return { ok: false, failure: { statusCode } }; } });
    await worker.deliver(input); await worker.deliver(input);
    expect(store.disabled).toEqual(['s1']); expect(store.deliveries).toHaveLength(1); expect(store.notification?.state).toBe('suppressed');
  });
  it('bounds a hung transport to 30 seconds and records a retry', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryPersistence(); const worker = new NotificationWorker(store, { send: () => new Promise(() => {}) });
      const delivery = worker.deliver(input); await vi.advanceTimersByTimeAsync(30_000); await delivery;
      expect(store.deliveries[0]?.state).toBe('retryable'); expect(store.notification?.state).toBe('pending');
    } finally { vi.useRealTimers(); }
  });
  it('projects adversarial input without body or preview', async () => {
    const store = new MemoryPersistence(); const sent: unknown[] = [];
    const worker = new NotificationWorker(store, { async send(_s, payload) { sent.push(payload); return { ok: true }; } });
    await worker.deliver({ ...input, ...{ body: 'secret', preview: 'secret' } }); await worker.deliver(input);
    expect(sent).toEqual([{ notificationId: 'n1', activityId: 'a1', senderLabel: 'Alice', subject: 'Action needed', statusLabel: 'waiting' }]);
  });
});
