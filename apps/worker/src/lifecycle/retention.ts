export interface LifecycleClock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface LifecycleStore {
  /** Deletes cache rows only and writes an audit row in the same transaction. */
  purgeCachedBodies(cutoff: Date, at: Date, limit: number): Promise<number>;
  /** Disables expired push endpoints; it never removes subscriptions or delivery history. */
  disableExpiredPushSubscriptions(at: Date, limit: number): Promise<number>;
  acquireLease(name: string, holderId: string, now: Date, ttlMilliseconds: number): Promise<boolean>;
}

export interface LifecycleOptions {
  bodyRetentionDays: number;
  bodyBatchSize?: number;
  pushBatchSize?: number;
}

export interface LifecycleResult {
  bodiesPurged: number;
  expiredSubscriptionsDisabled: number;
}

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
};

/** A bounded, restart-safe lifecycle pass. The store makes each state change auditable. */
export class LifecycleWorker {
  readonly options: Required<LifecycleOptions>;

  constructor(private readonly store: LifecycleStore, private readonly clock: LifecycleClock, options: LifecycleOptions) {
    positiveInteger(options.bodyRetentionDays, 'bodyRetentionDays');
    this.options = {
      bodyRetentionDays: options.bodyRetentionDays,
      bodyBatchSize: options.bodyBatchSize ?? 100,
      pushBatchSize: options.pushBatchSize ?? 100,
    };
    positiveInteger(this.options.bodyBatchSize, 'bodyBatchSize');
    positiveInteger(this.options.pushBatchSize, 'pushBatchSize');
  }

  async runCycle(): Promise<LifecycleResult> {
    const at = this.clock.now();
    const cutoff = new Date(at.valueOf() - this.options.bodyRetentionDays * 24 * 60 * 60 * 1000);
    const [bodiesPurged, expiredSubscriptionsDisabled] = await Promise.all([
      this.store.purgeCachedBodies(cutoff, at, this.options.bodyBatchSize),
      this.store.disableExpiredPushSubscriptions(at, this.options.pushBatchSize),
    ]);
    return { bodiesPurged, expiredSubscriptionsDisabled };
  }
}

/** Singleton lifecycle scheduler; work remains safely replayable after a process restart. */
export class LifecycleScheduler {
  private stopped = false;

  constructor(
    private readonly worker: LifecycleWorker,
    private readonly store: LifecycleStore,
    private readonly clock: LifecycleClock,
    private readonly holderId: string,
    private readonly intervalMilliseconds: number,
  ) {
    if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 60_000) throw new RangeError('lifecycle interval must be at least one minute');
  }

  async tick(): Promise<LifecycleResult | null> {
    if (this.stopped) return null;
    const now = this.clock.now();
    if (!await this.store.acquireLease('lifecycle', this.holderId, now, this.intervalMilliseconds * 2)) return null;
    return this.worker.runCycle();
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await this.clock.sleep(this.intervalMilliseconds);
    }
  }

  stop(): void { this.stopped = true; }
}
