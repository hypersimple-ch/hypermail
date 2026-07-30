# Health contracts

Liveness is dependency-free: `{ "status": "ok" }`. It answers only whether the process can continue running and must not call dependencies.

Readiness reports only aggregate state and unavailable dependency names; it never exposes errors, URLs, credentials, queue data, or provider responses. Web readiness checks `database` and `hypermail`. Worker readiness checks `database`, `queue`, `hypermail`, `scheduler`, `model`, `notifications`, and `policy`. Example: `{ "status": "not_ready", "dependencies": ["policy"] }`.

Worker health is private on `HEALTH_PORT` (default `3001`). Expose at most the proxy's minimal web liveness route. Alert on sustained readiness failure and use access-controlled internal logs for diagnosis. Current worker readiness is expected to be `not_ready` until the Hypermail draft create/edit provider-response contract is verified.
