# Hypermail connector for Hermes Agent

This directory is a third-party Hermes **platform plugin**, using the supported
`plugin.yaml` + `register(ctx)` + `BasePlatformAdapter` interface. It opens no
listener: Hermes makes an outbound HTTPS long-poll to Hypermail.

## Install

1. Install Hermes Agent and ensure its Python environment contains
   `cryptography`.
2. Copy or symlink `hermes_hypermail/` to
   `~/.hermes/plugins/platforms/hypermail/`.
3. Complete Hypermail's pairing ceremony. Store the issued refresh token and
   the generated P-256 private profile JWK in the active Hermes profile's secret
   environment. Never reuse that key for a second Hermes profile.
4. Set every variable listed in `plugin.yaml`, enable `hypermail` under
   `plugins.enabled`, and enable `gateway.platforms.hypermail`.
5. Run `hermes gateway`.

The connector rejects HTTP URLs, bearer-only OAuth tokens, non-P-256 keys,
private/public JWK mismatches, and pairing responses that do not echo the exact
connection/profile/key-thumbprint tuple. Each API call has a fresh RFC 9449
DPoP proof, including `ath` on resource requests and nonce retry support.

## Public server contract consumed

The connector intentionally imports no Hypermail worker/database code. Its only
integration is the external durable-task HTTPS contract:

- `POST /v1/agent-connector/pairing/verify`
- `POST /v1/agent-connector/tasks:claim?wait=1..30`
- `POST /v1/agent-connector/tasks/{taskId}:heartbeat`
- `POST /v1/agent-connector/tasks/{taskId}:complete`
- `POST /v1/agent-connector/tasks/{taskId}:fail`

Claims carry the public `{ task, runId, leaseToken }` fenced envelope plus the
work input needed by the manager. Reports carry connection ID, task ID, lease
generation/token, request ID/digest, and a structured result/failure. The
connector never reads a task table or outbox.

Assistant response text is display-only and is explicitly ignored as a durable
completion signal. A run completes only through one of the registered
`hypermail_task_*` tools. Questions and actions reference IDs produced by
Hypermail's structured public tools; the connector never scrapes or invents
IDs from prose.

## Tests

```sh
pnpm --filter @hypermail/hermes-connector test
```

Tests use a local in-memory fake security endpoint to verify ES256 signatures,
OAuth DPoP nonce handling, access-token hash binding, proof non-replay, pairing
key pinning, idempotency digests, and explicit structured completion. Live
pairing acceptance is skipped unless `HYPERMAIL_HERMES_LIVE_ACCEPTANCE=1` and
all seven required variables are present.

## Current live blockers

- This checkout does not mount the `ExternalAgentTaskProtocol` on the public
  HTTPS routes above, nor expose an OAuth authorization/token service that
  issues DPoP-bound tokens and verifies pairing proofs.
- The current `ClaimedAgentTask` public application value contains task metadata,
  run ID, and lease token but no work input/body for Hermes to process.
- Hermes Agent is not installed in this development environment, so plugin
  discovery and a real gateway turn cannot be executed locally.

The skipped live acceptance test remains the release gate until those pieces
exist in a deployed environment.
