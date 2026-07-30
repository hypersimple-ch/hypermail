/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import { LifecycleScheduler, LifecycleWorker, type LifecycleClock, type LifecycleStore } from '../../src/lifecycle/retention.js';

class FakeClock implements LifecycleClock {
  value = new Date('2026-04-01T00:00:00.000Z');
  now(): Date { return new Date(this.value); }
  async sleep(milliseconds: number): Promise<void> { this.value = new Date(this.value.valueOf() + milliseconds); }
}

class FakeStore implements LifecycleStore {
  readonly bodies = new Map<string, Date>();
  readonly subscriptions = new Map<string, { expiresAt: Date | null; disabledAt: Date | null }>();
  readonly audits: Array<{ event: string; id: string }> = [];
  lease?: { holder: string; expires: Date };

  async purgeCachedBodies(cutoff: Date, _at: Date, limit: number): Promise<number> {
    let count = 0;
    for (const [id, cachedAt] of this.bodies) {
      if (count === limit || cachedAt > cutoff) continue;
      this.bodies.delete(id); this.audits.push({ event: 'message_body_purged', id }); count++;
    }
    return count;
  }
  async disableExpiredPushSubscriptions(at: Date, limit: number): Promise<number> {
    let count = 0;
    for (const [id, subscription] of this.subscriptions) {
      if (count === limit || subscription.disabledAt || !subscription.expiresAt || subscription.expiresAt > at) continue;
      subscription.disabledAt = new Date(at); this.audits.push({ event: 'push_subscription_expired', id }); count++;
    }
    return count;
  }
  async acquireLease(_name: string, holderId: string, now: Date, ttlMilliseconds: number): Promise<boolean> {
    if (this.lease && this.lease.expires > now && this.lease.holder !== holderId) return false;
    this.lease = { holder: holderId, expires: new Date(now.valueOf() + ttlMilliseconds) };
    return true;
  }
}

const setup = () => {
  const clock = new FakeClock(); const store = new FakeStore();
  const worker = new LifecycleWorker(store, clock, { bodyRetentionDays: 90, bodyBatchSize: 2, pushBatchSize: 2 });
  return { clock, store, worker };
};

describe('lifecycle retention worker', () => {
  it('purges only body cache at the exact retention boundary and preserves metadata/history', async () => {
    const { clock, store, worker } = setup();
    store.bodies.set('at-boundary', new Date(clock.value.valueOf() - 90 * 86_400_000));
    store.bodies.set('one-millisecond-newer', new Date(clock.value.valueOf() - 90 * 86_400_000 + 1));
    await worker.runCycle();
    expect(store.bodies.has('at-boundary')).toBe(false);
    expect(store.bodies.has('one-millisecond-newer')).toBe(true);
    expect(store.audits).toContainEqual({ event: 'message_body_purged', id: 'at-boundary' });
  });

  it('is bounded and idempotent after a restart', async () => {
    const { clock, store, worker } = setup();
    for (const id of ['one', 'two', 'three']) store.bodies.set(id, new Date(clock.value.valueOf() - 91 * 86_400_000));
    expect((await worker.runCycle()).bodiesPurged).toBe(2);
    expect((await new LifecycleWorker(store, clock, { bodyRetentionDays: 90, bodyBatchSize: 2 }).runCycle()).bodiesPurged).toBe(1);
    expect((await worker.runCycle()).bodiesPurged).toBe(0);
    expect(store.audits.filter((audit) => audit.event === 'message_body_purged')).toHaveLength(3);
  });

  it('disables expired push endpoints at the exact boundary without deleting subscription history', async () => {
    const { clock, store, worker } = setup();
    store.subscriptions.set('expired', { expiresAt: new Date(clock.value), disabledAt: null });
    store.subscriptions.set('valid', { expiresAt: new Date(clock.value.valueOf() + 1), disabledAt: null });
    expect((await worker.runCycle()).expiredSubscriptionsDisabled).toBe(1);
    expect(store.subscriptions.get('expired')).toEqual({ expiresAt: clock.value, disabledAt: clock.value });
    expect(store.subscriptions.has('expired')).toBe(true);
    expect((await worker.runCycle()).expiredSubscriptionsDisabled).toBe(0);
  });

  it('uses a singleton lease so only one scheduler performs a pass', async () => {
    const { clock, store, worker } = setup();
    const first = new LifecycleScheduler(worker, store, clock, 'one', 60_000);
    const second = new LifecycleScheduler(worker, store, clock, 'two', 60_000);
    expect(await first.tick()).not.toBeNull();
    expect(await second.tick()).toBeNull();
  });
});
