import type { DeliveryQueue } from './ingestion.js';

/** Minimal pg-boss surface; inject a real pg-boss instance at bootstrap. */
export interface PgBossLike { send(name: string, data: object, options: { singletonKey: string }): Promise<string | null>; }
export class PgBossDeliveryQueue implements DeliveryQueue {
  constructor(private readonly boss: PgBossLike) {}
  async send(name: 'agent.evaluate', payload: { jobId: string }, singletonKey: string): Promise<string> {
    const id = await this.boss.send(name, payload, { singletonKey });
    if (!id) throw new Error('pg-boss did not return a job id');
    return id;
  }
}
