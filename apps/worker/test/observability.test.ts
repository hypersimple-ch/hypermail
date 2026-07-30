import { describe, expect, it } from 'vitest';
import { WorkerObservability } from '../src/observability/index.js';

describe('worker observability bridge', () => {
  it('records only fixed metric dimensions and emits a redacted event', () => {
    const records: unknown[] = [];
    const observer = new WorkerObservability((record) => records.push(record));
    observer.record('poll_cycle', 'failure');
    expect(observer.metrics.snapshot()).toEqual([{ name: 'poll_cycle', outcome: 'failure', value: 1 }]);
    expect(records).toEqual([expect.objectContaining({ event: 'worker.poll_cycle.failure', fields: { outcome: 'failure' } })]);
  });

  it('reports safe health and actionable safety alerts', () => {
    const observer = new WorkerObservability();
    expect(observer.health({ database: true, queue: true, hypermail: true, scheduler: true }, ['backups'])).toEqual({ liveness: 'ok', readiness: 'ready', degradation: ['backups'] });
    expect(observer.alerts(true)).toEqual([expect.objectContaining({ name: 'safety_pause', severity: 'critical' })]);
  });
});
