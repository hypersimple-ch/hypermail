export type DependencyName = 'database' | 'queue' | 'hypermail' | 'scheduler';
export type DependencyHealth = Readonly<Record<DependencyName, boolean>>;
export type SystemHealth = Readonly<{ liveness: 'ok'; readiness: 'ready' | 'not_ready'; degradation: readonly ('polling' | 'jobs' | 'autonomous_actions' | 'push' | 'backups' | 'safety_pause')[] }>;

/** Safe private health projection: no exception text, endpoint, or secret is returned. */
export function systemHealth(dependencies: DependencyHealth, degradation: SystemHealth['degradation'] = []): SystemHealth {
  const readiness = Object.values(dependencies).every(Boolean) ? 'ready' : 'not_ready';
  return { liveness: 'ok', readiness, degradation: [...new Set(degradation)].sort() };
}
