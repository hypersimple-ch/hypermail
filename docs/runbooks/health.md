# Health contracts

Liveness is dependency-free: `{ "status": "ok" }`. It answers only whether the process can continue running and must not call dependencies.

Readiness reports only aggregate state and unavailable dependency names; it never exposes errors, URLs, credentials, queue data, or provider responses. Web readiness checks `database` and `hypermail`. Worker readiness checks `database`, `queue`, `hypermail`, `hindsight`, `scheduler`, `model`, `notifications`, and `policy`. Hindsight readiness requires private read-only `GET /health/ready`, exact `GET /version` API version `0.9.1` and feature flags, then a bounded `GET /openapi.json` proving the bank configure/create, retain, recall, file-upload, operation-status, and bank-delete methods used by the pinned client. Example: `{ "status": "not_ready", "dependencies": ["policy"] }`.

Worker health is private on `HEALTH_PORT` (default `3001`). Expose at most the proxy's minimal web liveness route. Alert on sustained readiness failure and use access-controlled internal logs for diagnosis. Worker policy readiness validates the pinned Hypermail restricted mutation and draft schemas through `tools/list`; this is not evidence that any live provider mutation succeeded.

Hindsight's container health check calls `http://127.0.0.1:8888/health` inside its own network namespace. It is a startup-order signal, not full compatibility acceptance. The worker probe is read-only and runs before consumers or schedulers; its 30-second refresh closes the shared memory gate on failure. Do not publish that endpoint or control-plane port 9999. Worker readiness is the fail-closed compatibility gate and must report only `hindsight`, never its URL, version response, bank identifiers, provider details, or errors.
