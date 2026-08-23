export type WorkerDependency = 'database' | 'queue' | 'hypermail' | 'hindsight' | 'scheduler' | 'model' | 'notifications' | 'policy';

export type DependencyState = Readonly<Record<WorkerDependency, boolean>>;

export type Liveness = {
  readonly status: 'ok';
};

export type Readiness =
  | { readonly status: 'ready'; readonly dependencies: readonly [] }
  | { readonly status: 'not_ready'; readonly dependencies: readonly WorkerDependency[] };

/** A liveness response never probes dependencies and is always safe to expose. */
export function liveness(): Liveness {
  return { status: 'ok' };
}

/**
 * Convert completed dependency probes into a response body suitable for a
 * private worker health endpoint. It deliberately omits error details, URLs,
 * queue payloads, and credentials.
 */
export function readiness(dependencies: DependencyState): Readiness {
  const unavailable = (Object.keys(dependencies) as WorkerDependency[]).filter(
    (dependency) => !dependencies[dependency],
  );

  return unavailable.length === 0
    ? { status: 'ready', dependencies: [] }
    : { status: 'not_ready', dependencies: unavailable };
}
