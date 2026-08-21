/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from 'vitest';
import { DispatchRecovery, IngestionWorker, LeaseScheduler, type Account, type Arrival, type Clock, type DeliveryQueue, type IngestionStore, type MailMessage, type MailProvider, type SanitizedFailure } from '../src/ingestion.js';

class FakeClock implements Clock { value = new Date('2026-01-01T00:00:00.000Z'); sleeps: number[] = []; now(): Date { return new Date(this.value); } async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.value = new Date(this.value.valueOf() + ms); } }
class FakeStore implements IngestionStore {
  accounts: Account[]; messages = new Set<string>(); baselineMessages = new Set<string>(); activities = new Set<string>(); notifications = new Set<string>(); jobs = new Map<string, { key: string; queue?: string }>(); failures = new Map<string, number>(); lease?: { holder: string; expires: Date }; commits = 0; health: SanitizedFailure[] = []; abortBeforeCommit = false; abortBaselineCompletion = false;
  constructor(accounts: Account[]) { this.accounts = accounts; }
  async transaction<T>(operation: (store: IngestionStore) => Promise<T>): Promise<T> { if (this.abortBeforeCommit) { this.abortBeforeCommit = false; throw new Error('database crash before commit'); } const result = await operation(this); this.commits++; return result; }
  async readyAccounts(): Promise<readonly Account[]> { return this.accounts; }
  async recordBaseline(arrival: Arrival): Promise<void> { const key = `${arrival.accountId}:${arrival.message.id}`; this.messages.add(key); this.baselineMessages.add(key); }
  async markBaseline(id: string, at: Date): Promise<void> { if (this.abortBaselineCompletion) { this.abortBaselineCompletion = false; throw new Error('database crash before baseline completion'); } const a = this.accounts.find((x) => x.id === id); if (a) a.baselineCompletedAt = at; }
  async recordArrival(arrival: Arrival) { const key = `${arrival.accountId}:${arrival.message.id}`; if (this.baselineMessages.has(key)) return null; const created = !this.messages.has(key); this.messages.add(key); this.activities.add(key); this.notifications.add(key); const job = `job:${key}`; this.jobs.set(job, this.jobs.get(job) ?? { key: `agent:evaluate:${job}` }); return { jobId: job, idempotencyKey: `agent:evaluate:${job}`, created }; }
  async markPollSucceeded(id: string): Promise<void> { this.failures.set(id, 0); }
  async markPollFailed(id: string, _at: Date, failure: SanitizedFailure): Promise<number> { this.health.push(failure); const count = (this.failures.get(id) ?? 0) + 1; this.failures.set(id, count); return count; }
  async pendingDispatches() { return [...this.jobs].filter(([, job]) => !job.queue).map(([jobId, job]) => ({ jobId, userId: this.accounts.find((a) => a.id === jobId.split(':')[1])?.userId ?? 'tenant', idempotencyKey: job.key })); }
  async markDispatched(id: string, queue: string): Promise<void> { const job = this.jobs.get(id); if (job && !job.queue) job.queue = queue; }
  async acquireLease(_name: string, holder: string, now: Date, ttl: number): Promise<boolean> { if (this.lease && this.lease.expires > now && this.lease.holder !== holder) return false; this.lease = { holder, expires: new Date(now.valueOf() + ttl) }; return true; }
}
class FakeProvider implements MailProvider {
  baseline: string[] = []; polls = new Map<string, MailMessage[]>(); recent = new Map<string, MailMessage[]>(); fail = new Set<string>();
  async establishBaseline(_userId: string, account: string): Promise<void> { this.baseline.push(account); }
  async pollNewInbox(_userId: string, account: string): Promise<MailMessage[]> { if (this.fail.has(account)) throw new Error('network https://secret.example token-abcdefghijklmnopqrstuv'); return this.polls.get(account) ?? []; }
  async recentInbox(_userId: string, account: string): Promise<MailMessage[]> { return this.recent.get(account) ?? []; }
}
class FakeQueue implements DeliveryQueue { sends: string[] = []; fail = false; async send(_name: 'agent.evaluate', payload: { jobId: string; userId: string }, key: string): Promise<string> { if (this.fail) throw new Error('queue unavailable'); this.sends.push(`${payload.jobId}:${key}`); return `queue:${payload.jobId}`; } }
const account = (id: string, email = `${id}@example.test`, baseline = new Date('2025-12-31T00:00:00Z')): Account => ({ userId: '00000000-0000-4000-8000-000000000001', id, email, provider: 'gmail', baselineCompletedAt: baseline, consecutiveFailures: 0 });
const mail = (id: string, email: string): MailMessage => ({ id, account: email, subject: 'Hello', from: { address: 'sender@example.test' } });
const setup = (accounts = [account('a')]) => { const store = new FakeStore(accounts); const provider = new FakeProvider(); const clock = new FakeClock(); const queue = new FakeQueue(); return { store, provider, clock, queue, worker: new IngestionWorker(store, provider, new DispatchRecovery(store, queue), clock) }; };

describe('ingestion worker', () => {
  it('projects existing Inbox mail as baseline, never activity, and later records new mail', async () => {
    const s = setup([account('a', 'a@example.test', null)]);
    const existing = mail('existing', 'a@example.test');
    const later = mail('later', 'a@example.test');
    s.provider.recent.set('a@example.test', [existing]);
    await s.worker.runCycle();
    expect(s.store.baselineMessages).toEqual(new Set(['a:existing']));
    expect(s.store.activities.size).toBe(0);
    expect(s.store.notifications.size).toBe(0);
    expect(s.store.jobs.size).toBe(0);
    s.provider.polls.set('a@example.test', [later]);
    await s.worker.runCycle();
    expect(s.store.activities).toEqual(new Set(['a:later']));
    expect(s.store.notifications).toEqual(new Set(['a:later']));
    expect(s.store.jobs.size).toBe(1);
  });
  it('repeats baseline projection safely after checkpoint, projection, and completion crashes', async () => {
    const s = setup([account('a', 'a@example.test', null)]);
    const existing = mail('existing', 'a@example.test');
    s.provider.recent.set('a@example.test', [existing]);
    s.store.abortBeforeCommit = true;
    await s.worker.runCycle(); // provider checkpoint advanced, projection did not commit
    s.store.abortBaselineCompletion = true;
    await s.worker.runCycle(); // projection committed, completion did not
    await s.worker.runCycle(); // repeated projection completes the baseline
    expect(s.provider.baseline).toHaveLength(3);
    expect(s.store.baselineMessages).toEqual(new Set(['a:existing']));
    expect(s.store.activities.size).toBe(0);
    expect(s.store.notifications.size).toBe(0);
    expect(s.store.jobs.size).toBe(0);
    await s.worker.runCycle(); // reconciliation sees the same Inbox content
    expect(s.store.activities.size).toBe(0);
    expect(s.store.notifications.size).toBe(0);
    expect(s.store.jobs.size).toBe(0);
  });
  it('is idempotent for duplicate polls and persists then delivers one deterministic job', async () => { const s = setup(); s.provider.polls.set('a@example.test', [mail('1', 'a@example.test'), mail('1', 'a@example.test')]); await s.worker.runCycle(); await s.worker.runCycle(); expect(s.store.messages.size).toBe(1); expect(s.store.jobs.size).toBe(1); expect(s.queue.sends).toHaveLength(1); });
  it('replays committed work after queue failure or process restart', async () => { const s = setup(); s.queue.fail = true; s.provider.polls.set('a@example.test', [mail('1', 'a@example.test')]); await s.worker.runCycle(); expect(s.store.jobs.size).toBe(1); s.queue.fail = false; await new DispatchRecovery(s.store, s.queue).dispatch(); expect(s.queue.sends).toHaveLength(1); });
  it('recovers a provider checkpoint crash gap after a database crash before commit', async () => { const s = setup(); const lost = mail('lost-after-provider-checkpoint', 'a@example.test'); s.store.abortBeforeCommit = true; s.provider.polls.set('a@example.test', [lost]); await s.worker.runCycle(); expect(s.store.messages.size).toBe(0); s.provider.polls.set('a@example.test', []); s.provider.recent.set('a@example.test', [lost]); await s.worker.runCycle(); expect(s.store.messages.has('a:lost-after-provider-checkpoint')).toBe(true); });
  it('isolates account failures and sanitizes health details without blocking other accounts', async () => { const s = setup([account('a'), account('b')]); s.provider.fail.add('a@example.test'); s.provider.polls.set('b@example.test', [mail('ok', 'b@example.test')]); await s.worker.runCycle(); expect(s.store.messages.has('b:ok')).toBe(true); expect(s.store.health[0]).toEqual({ code: 'provider_unavailable', detail: expect.not.stringContaining('secret.example') }); expect(s.clock.sleeps).toEqual([]); });
  it('hands the singleton lease to a new holder only after expiry', async () => { const s = setup(); const first = new LeaseScheduler(s.worker, s.store, s.clock, 'one', 30_000); const second = new LeaseScheduler(s.worker, s.store, s.clock, 'two', 30_000); await first.tick(); expect(s.provider.polls.size).toBe(0); await second.tick(); expect(s.store.lease?.holder).toBe('one'); s.clock.value = new Date(s.clock.value.valueOf() + 60_001); await second.tick(); expect(s.store.lease?.holder).toBe('two'); });
});
