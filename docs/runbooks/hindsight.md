# Private Hindsight operations

## Deployment contract

Deploy production only with `HINDSIGHT_IMAGE=ghcr.io/vectorize-io/hindsight@sha256:…` using the approved 0.9.1 digest; local development may use the exact `:0.9.1` tag. The Compose service disables the control plane with `HINDSIGHT_ENABLE_CP=false`, publishes no ports, and never joins the edge/proxy network. Port 8888 is reachable only by private application services. The separate egress network is for the configured LLM provider. The full image provides local embeddings and reranking; `HINDSIGHT_ENV_FILE` contains only its LLM provider/model/key and is never mounted in web or worker.

The embedded pg0 directory is the named `hindsight-data` volume at `/home/hindsight/.pg0`. `HINDSIGHT_API_WORKER_ID=hypermail-hindsight-0` is stable across replacements. Do not change that ID or mount path during a routine deploy. Allow the configured 45-second stop grace period so pg0 can shut down cleanly.

## Readiness and compatibility

1. Confirm Compose reports `hindsight` healthy. Its container health check calls private `GET /health`.
2. Worker compatibility first calls the 0.9.1 client endpoints `GET /health/ready` and `GET /version`. It requires ready status, exact `api_version: 0.9.1`, and the required feature flags. Do not log either response.
3. Only after those checks pass, the worker reads private `GET /openapi.json`. It caps the body at 2 MiB, accepts OpenAPI 3.0/3.1 with at most 2,000 path entries, and verifies this exact client surface without executing it:

   | Adapter operation | Required route |
   |---|---|
   | configure/create bank | `PUT /v1/default/banks/{bank_id}` |
   | retain | `POST /v1/default/banks/{bank_id}/memories` |
   | recall | `POST /v1/default/banks/{bank_id}/memories/recall` |
   | upload file | `POST /v1/default/banks/{bank_id}/files/retain` |
   | operation status | `GET /v1/default/banks/{bank_id}/operations/{operation_id}` |
   | delete bank | `DELETE /v1/default/banks/{bank_id}` |

4. Compatibility probing is read-only. It must never configure or create a bank, retain content, upload a file, invoke recall or another LLM-backed route, delete a bank, or access email. Missing methods, malformed/oversized documents, timeouts, and version/feature mismatches fail closed.
5. Startup accepts and caches the result in the shared memory gate before any consumer or scheduler starts. The 30-second refresh repeats the same check; failure closes both readiness and memory work until a later successful refresh.
6. Never route `/health`, `/health/ready`, `/version`, `/docs`, `/openapi.json`, `/v1`, `/mcp`, port 8888, or control-plane port 9999 through Caddy/Traefik.

## File-operation retry limitation

Hindsight 0.9.1 file upload returns a server operation UUID but does not accept a caller-supplied operation UUID. Hypermail supplies a deterministic document ID and shares one in-process retention promise, so normal automatic/outbox races converge. A process crash after server acceptance but before the operation UUID is persisted can still repeat file conversion on retry; the stable document ID preserves the final document identity but cannot prevent duplicate provider work. Text and event retains do use deterministic caller operation UUIDs.

## Disconnect versus permanent deletion

Disconnect preserves the Mailbox bank. It only prevents new work for that Mailbox. A body-cache purge also preserves the bank. Permanent deletion requires an explicit confirmed owner/operator request.

1. Stop the worker and verify no replacement worker is running.
2. Run the worker image's authenticated operator command on the private network. Pass verified User and Mailbox UUIDs; never accept a bank ID from the requester.
3. The command locks the owned Mailbox, changes it to `disabled`, terminally cancels its pending/processing memory events and removes their replay payloads while leaving completed events unchanged, writes a pre-delete audit, derives the exact opaque bank ID, deletes the bank idempotently, then writes a completion audit.
4. Keep the Mailbox disabled. A later explicit reconnect may create a new empty bank from new forward-only events.

```sh
MEMORY_DELETE_WORKER_STOPPED=1 docker compose run --rm --no-deps \
  --entrypoint node worker dist/delete-mailbox-memory.js \
  '<User UUID>' '<Mailbox UUID>'
```

The command fails closed on wrong ownership, an unstopped-worker acknowledgement, Hindsight failure, or audit/database failure. It emits identifiers and status only, never memory content or provider responses. Do not use raw curl or delete the whole Hindsight volume for one Mailbox.

## Failure response

If Hindsight is unhealthy, preserve the volume and keep memory-dependent worker readiness closed. Check fixed health/version status, disk space, file ownership, provider availability, and bounded operation status. Do not print provider keys, memory content, bank payloads, URLs with credentials, or rendered container environments. Do not tar or restore the live embedded database. Development banks may be reset; production requires a separately accepted quiesced or logical Hindsight backup procedure.
