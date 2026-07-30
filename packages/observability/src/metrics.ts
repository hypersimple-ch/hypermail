export type MetricName = 'poll_cycle' | 'job' | 'autonomous_action' | 'push' | 'backup' | 'safety_pause';
export type MetricOutcome = 'success' | 'failure' | 'retrying' | 'paused' | 'unavailable';
export type MetricPoint = Readonly<{ name: MetricName; outcome: MetricOutcome; value: number }>;

const NAMES = new Set<MetricName>(['poll_cycle', 'job', 'autonomous_action', 'push', 'backup', 'safety_pause']);
const OUTCOMES = new Set<MetricOutcome>(['success', 'failure', 'retrying', 'paused', 'unavailable']);

/** Fixed metric dimensions prevent account, message, provider, and token cardinality leaks. */
export class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  increment(name: MetricName, outcome: MetricOutcome, value = 1): void {
    if (!NAMES.has(name) || !OUTCOMES.has(outcome) || !Number.isFinite(value) || value < 0) return;
    const key = `${name}:${outcome}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }
  snapshot(): readonly MetricPoint[] {
    return [...this.counters].map(([key, value]) => {
      const [name, outcome] = key.split(':') as [MetricName, MetricOutcome];
      return { name, outcome, value };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.outcome.localeCompare(b.outcome));
  }
}

export type OperationalSignal = Readonly<{ name: MetricName; failed: number; total: number }>;
export type OperationalAlert = Readonly<{ name: MetricName; severity: 'warning' | 'critical'; action: string }>;

/** Produces finite, operator-facing alerts without including tenant or message context. */
export function actionableAlerts(signals: readonly OperationalSignal[], safetyPaused: boolean): readonly OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const signal of signals) {
    if (!NAMES.has(signal.name) || signal.failed <= 0) continue;
    const severity = signal.name === 'backup' || signal.name === 'safety_pause' || signal.failed >= 3 || (signal.name === 'autonomous_action' && signal.failed / Math.max(signal.total, 1) > 0.01) ? 'critical' : 'warning';
    const action = ({ poll_cycle: 'Check provider credentials and connectivity; keep polling other accounts.', job: 'Inspect durable queue depth and retry workers.', autonomous_action: 'Review verification failures and pause the affected account when safety policy requires.', push: 'Check push subscription delivery and retain the in-app notification queue.', backup: 'Check encrypted backup job and perform the documented restore verification.', safety_pause: 'Keep autonomous mutations paused, review the safety rate, and require explicit operator resume.' } as const)[signal.name];
    alerts.push({ name: signal.name, severity, action });
  }
  if (safetyPaused && !alerts.some((alert) => alert.name === 'safety_pause')) alerts.push({ name: 'safety_pause', severity: 'critical', action: 'Keep autonomous mutations paused, review the safety rate, and require explicit operator resume.' });
  return alerts;
}
