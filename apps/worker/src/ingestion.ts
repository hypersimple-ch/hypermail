export type Provider = 'microsoft' | 'gmail' | 'imap';

export interface Clock { now(): Date; sleep(milliseconds: number): Promise<void>; }
export interface Account { id: string; email: string; provider: Provider; baselineCompletedAt: Date | null; consecutiveFailures: number; }
export interface MailAddress { address: string; name?: string; }
export interface MailMessage { id: string; account: string; subject?: string; from?: MailAddress; to?: MailAddress[]; cc?: MailAddress[]; receivedAt?: string; isRead?: boolean; attachments?: ReadonlyArray<{ id: string; name: string; contentType?: string; size?: number }>; }
export interface MailProvider {
  establishBaseline(account: string): Promise<void>;
  pollNewInbox(account: string, limit: number): Promise<MailMessage[]>;
  recentInbox(account: string, limit: number): Promise<MailMessage[]>;
}
export interface Arrival { accountId: string; message: MailMessage; observedAt: Date; }
export interface ArrivalResult { jobId: string; idempotencyKey: string; created: boolean; }
export interface IngestionStore {
  transaction<T>(operation: (store: IngestionStore) => Promise<T>): Promise<T>;
  readyAccounts(): Promise<ReadonlyArray<Account>>;
  recordBaseline(arrival: Arrival): Promise<void>;
  markBaseline(accountId: string, at: Date): Promise<void>;
  recordArrival(arrival: Arrival): Promise<ArrivalResult | null>;
  markPollSucceeded(accountId: string, at: Date, reconciled: boolean): Promise<void>;
  markPollFailed(accountId: string, at: Date, failure: SanitizedFailure): Promise<number>;
  pendingDispatches(limit: number): Promise<ReadonlyArray<{ jobId: string; idempotencyKey: string }>>;
  markDispatched(jobId: string, queueJobId: string): Promise<void>;
  acquireLease(name: string, holderId: string, now: Date, ttlMilliseconds: number): Promise<boolean>;
}
export interface DeliveryQueue { send(name: 'agent.evaluate', payload: { jobId: string }, singletonKey: string): Promise<string>; }
export interface SanitizedFailure { code: string; detail: string; }

const safeDetail = (value: unknown): string => {
  const message = value instanceof Error ? value.message : 'provider request failed';
  return message.replace(/https?:\/\/[^\s]+/g, '[url]').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').slice(0, 200);
};
export function sanitizeFailure(error: unknown): SanitizedFailure {
  const message = error instanceof Error ? error.message : '';
  if (/rate|429/i.test(message)) return { code: 'provider_rate_limited', detail: safeDetail(error) };
  if (/auth|401|403/i.test(message)) return { code: 'provider_auth_failed', detail: safeDetail(error) };
  if (/timeout|network|fetch|5\d\d/i.test(message)) return { code: 'provider_unavailable', detail: safeDetail(error) };
  return { code: 'provider_poll_failed', detail: safeDetail(error) };
}

/** The database row is truth. Queue delivery is deliberately a separate, replayable step. */
export class DispatchRecovery {
  constructor(private readonly store: IngestionStore, private readonly queue: DeliveryQueue) {}
  async dispatch(limit = 100): Promise<void> {
    for (const job of await this.store.pendingDispatches(limit)) {
      try {
        const queueJobId = await this.queue.send('agent.evaluate', { jobId: job.jobId }, job.idempotencyKey);
        await this.store.markDispatched(job.jobId, queueJobId);
      } catch {
        // The durable pending job is retried on the next dispatcher pass.
      }
    }
  }
}

export interface IngestionObserver { record(name: 'poll_cycle' | 'job', outcome: 'success' | 'failure' | 'retrying' | 'paused' | 'unavailable'): void; }
export interface IngestionOptions { pollLimit?: number; recentLimit?: number; observer?: IngestionObserver; }
export class IngestionWorker {
  readonly options: Readonly<{ pollLimit: number; recentLimit: number; observer?: IngestionObserver }>;
  constructor(private readonly store: IngestionStore, private readonly provider: MailProvider, private readonly dispatcher: DispatchRecovery, private readonly clock: Clock, options: IngestionOptions = {}) {
    this.options = { pollLimit: options.pollLimit ?? 25, recentLimit: options.recentLimit ?? 100, ...(options.observer ? { observer: options.observer } : {}) };
  }
  async runCycle(): Promise<void> {
    for (const account of await this.store.readyAccounts()) await this.pollAccount(account);
    await this.dispatcher.dispatch();
  }
  private async pollAccount(account: Account): Promise<void> {
    try {
      if (!account.baselineCompletedAt) {
        await this.provider.establishBaseline(account.email);
        // Project identities before completing the baseline. Repeating this after a
        // provider or database crash is safe, and keeps reconciliation from turning
        // pre-existing Inbox content into arrivals.
        await this.persistBaseline(account, await this.provider.recentInbox(account.email, this.options.recentLimit));
        await this.store.markBaseline(account.id, this.clock.now());
        this.options.observer?.record('poll_cycle', 'success');
        return; // Baseline content never creates activities or jobs.
      }
      // Reconciliation closes the external checkpoint -> DB commit crash window.
      await this.persistAll(account, await this.provider.recentInbox(account.email, this.options.recentLimit));
      await this.persistAll(account, await this.provider.pollNewInbox(account.email, this.options.pollLimit));
      await this.store.markPollSucceeded(account.id, this.clock.now(), true);
      this.options.observer?.record('poll_cycle', 'success');
    } catch (error) {
      // The store records bounded exponential backoff; later accounts are never blocked.
      await this.store.markPollFailed(account.id, this.clock.now(), sanitizeFailure(error));
      this.options.observer?.record('poll_cycle', 'failure');
    }
  }
  private async persistBaseline(account: Account, messages: ReadonlyArray<MailMessage>): Promise<void> {
    for (const message of messages) {
      if (message.account !== account.email) throw new Error('provider account isolation violation');
      await this.store.transaction((store) => store.recordBaseline({ accountId: account.id, message, observedAt: this.clock.now() }));
    }
  }
  private async persistAll(account: Account, messages: ReadonlyArray<MailMessage>): Promise<void> {
    for (const message of messages) {
      if (message.account !== account.email) throw new Error('provider account isolation violation');
      await this.store.transaction((store) => store.recordArrival({ accountId: account.id, message, observedAt: this.clock.now() }));
    }
  }
}

export class LeaseScheduler {
  private stopped = false;
  constructor(private readonly worker: IngestionWorker, private readonly store: IngestionStore, private readonly clock: Clock, private readonly holderId: string, private readonly intervalMilliseconds: number) {
    if (intervalMilliseconds < 30_000 || intervalMilliseconds > 60_000) throw new RangeError('poll interval must be 30–60 seconds');
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (await this.store.acquireLease('ingestion', this.holderId, this.clock.now(), this.intervalMilliseconds * 2)) await this.worker.runCycle();
  }
  async start(): Promise<void> { while (!this.stopped) { await this.tick(); await this.clock.sleep(this.intervalMilliseconds); } }
  stop(): void { this.stopped = true; }
}
