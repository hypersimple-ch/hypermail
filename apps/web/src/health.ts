export type WebDependency = 'database' | 'hypermail';

export type DependencyState = Readonly<Record<WebDependency, boolean>>;

export type Liveness = {
  readonly status: 'ok';
};

export type Readiness =
  | { readonly status: 'ready'; readonly dependencies: readonly [] }
  | { readonly status: 'not_ready'; readonly dependencies: readonly WebDependency[] };

/** A liveness response never probes dependencies and is always safe to expose. */
export function liveness(): Liveness {
  return { status: 'ok' };
}

/**
 * Convert completed dependency probes into a response body suitable for an
 * authenticated service health endpoint. Dependency names are intentional;
 * errors, URLs, credentials, and provider responses are never returned.
 */
export function readiness(dependencies: DependencyState): Readiness {
  const unavailable = (Object.keys(dependencies) as WebDependency[]).filter(
    (dependency) => !dependencies[dependency],
  );

  return unavailable.length === 0
    ? { status: 'ready', dependencies: [] }
    : { status: 'not_ready', dependencies: unavailable };
}
