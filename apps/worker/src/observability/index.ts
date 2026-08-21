import { actionableAlerts, createStructuredLogger, OperationalMetrics, systemHealth, type DependencyHealth, type LogSink, type MetricName, type MetricOutcome, type OperationalAlert } from '@hypermail/observability';

/** Worker-only bridge: callers record fixed operational outcomes, never mailbox payloads. */
export class WorkerObservability {
  readonly metrics = new OperationalMetrics();
  private readonly logger: ReturnType<typeof createStructuredLogger>;
  constructor(sink: LogSink = (record) => { process.stdout.write(`${JSON.stringify(record)}\n`); }) {
    this.logger = createStructuredLogger(sink);
  }
  record(name: MetricName, outcome: MetricOutcome, correlationId?: string): void {
    this.metrics.increment(name, outcome);
    this.logger.log(outcome === 'failure' || outcome === 'unavailable' ? 'warn' : 'info', `worker.${name}.${outcome}`, { outcome }, correlationId);
  }
  health(dependencies: DependencyHealth, degradation: Parameters<typeof systemHealth>[1] = []) {
    return systemHealth(dependencies, degradation);
  }
  alerts(safetyPaused = false): readonly OperationalAlert[] {
    const points = this.metrics.snapshot();
    const names: readonly MetricName[] = ['poll_cycle', 'job', 'autonomous_action', 'push', 'backup', 'safety_pause', 'queue_age', 'oauth_reuse', 'connection_health', 'provider_error', 'authorization_denial', 'quota_denial'];
    return actionableAlerts(names.map((name) => ({ name, failed: points.find((point) => point.name === name && point.outcome === 'failure')?.value ?? 0, total: points.filter((point) => point.name === name).reduce((total, point) => total + point.value, 0) })), safetyPaused);
  }
}
