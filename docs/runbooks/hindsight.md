# Private Hindsight operations

## Deployment contract

Deploy production only with `HINDSIGHT_IMAGE=ghcr.io/vectorize-io/hindsight@sha256:…` using the approved 0.10.2 digest; local development may use the exact `:0.10.2` tag. The Compose service disables the control plane with `HINDSIGHT_ENABLE_CP=false`, publishes no ports, and never joins the edge/proxy network. Port 8888 is reachable only by private application services. The separate egress network is for the configured LLM provider. The full image provides local embeddings and reranking; `HINDSIGHT_ENV_FILE` contains only its LLM provider/model/key and is never mounted in web or worker.

The local 0.10.2 pull resolved on 2026-10-06 to `ghcr.io/vectorize-io/hindsight@sha256:d1840062a5b79940ab7a9f4809ceb90fc776d4ad737cd9329e9b5836cc64ab70`. This is an immutable candidate for the isolated proof, not evidence of production deployment approval or a successful migration. Production must use the separately verified/approved digest; never substitute `latest` or an unverified tag.

The embedded pg0 directory is the named `hindsight-data` volume at `/home/hindsight/.pg0`. `HINDSIGHT_API_WORKER_ID=hypermail-hindsight-0` is stable across replacements. Do not change that ID or mount path during a routine deploy. Allow the configured 45-second stop grace period so pg0 can shut down cleanly.

## Readiness and compatibility

1. Confirm Compose reports `hindsight` healthy. Its container health check uses the image's Python standard library to call private `GET /health/ready`, requiring HTTP 200, JSON `status=healthy` and `database=connected`. The 0.10.2 image does not provide curl.
2. Worker compatibility first calls the 0.10.2 client endpoints `GET /health/ready` and `GET /version`. It requires ready status, exact `api_version: 0.10.2`, and the required feature flags. Do not log either response.
3. Only after those checks pass, the worker reads private `GET /openapi.json`. It caps the body at 2 MiB, accepts OpenAPI 3.0/3.1 with at most 2,000 path entries, and verifies this exact client surface without executing it:

   | Adapter operation | Required route |
   |---|---|
   | configure/create bank | `PUT /v1/default/banks/{bank_id}` |
   | retain | `POST /v1/default/banks/{bank_id}/memories` |
   | recall | `POST /v1/default/banks/{bank_id}/memories/recall` |
   | upload file | `POST /v1/default/banks/{bank_id}/files/retain` |
   | operation status | `GET /v1/default/banks/{bank_id}/operations/{operation_id}` |
   | discover post-conversion retain | `GET /v1/default/banks/{bank_id}/operations` |
   | delete bank | `DELETE /v1/default/banks/{bank_id}` |

4. Compatibility probing is read-only. It must never configure or create a bank, retain content, upload a file, invoke recall or another LLM-backed route, delete a bank, or access email. Missing methods, malformed/oversized documents, timeouts, and version/feature mismatches fail closed.
5. Startup accepts and caches the result in the shared memory gate before any consumer or scheduler starts. The 30-second refresh repeats the same check; failure closes both readiness and memory work until a later successful refresh.
6. Never route `/health`, `/health/ready`, `/version`, `/docs`, `/openapi.json`, `/v1`, `/mcp`, port 8888, or control-plane port 9999 through Caddy/Traefik.

## Protected local 0.9.1 → 0.10.2 cutover

1. Start 0.10.2 in an owned disposable Compose project with a fresh volume and the dedicated local provider credentials. Exercise `HindsightMailboxMemory.readiness`, text/file retain completion and actual recall with source provenance; container health alone is insufficient. A placeholder or rejected LLM key blocks this gate.
2. Stop all producers, then cleanly stop the existing Hindsight server. Make a cold, restricted/encrypted backup of its volume. Never use `down -v` on the user's stack.
3. Restore the cold snapshot into an isolated copy and start that copy with the archived 0.9.1 image. Retain and recall a unique synthetic sentinel there. Preserve the derived mailbox bank ID.
4. Cleanly stop the copy, snapshot it, then start only the copy with the verified 0.10.2 digest. Recall the sentinel and its source/file evidence under the unchanged bank ID. Exercise isolated restore manifests for both archived versions. On failure, leave the original volume and `.env` untouched; never reopen a migrated volume with the older server.
5. Only after the isolated gates pass, migrate the protected original and update the non-secret `HINDSIGHT_EXPECTED_VERSION` value in `.env` to 0.10.2, then start `pnpm dev` and verify the synthetic path with an isolated test identity. No real mailbox mutations or Dokploy deployment belong to this procedure.

`pnpm dev` compares the rendered local worker version with the pinned Hindsight image before inspecting/building development images or starting containers. A mismatch refuses startup, preventing an unacknowledged upgrade of the original volume. Do not bypass this guard with a manual Compose `up` or change the version merely to suppress the error.

For explicitly disposable pre-production local data, an owner-approved reset replaces steps 2–5: stop producers and Hindsight, remove only the identified local Hindsight container and volume, set the matching worker version, and start a fresh 0.10.2 volume. No migration or historical-data preservation is required in that case. Do not delete PostgreSQL, provider state, credentials, or other volumes as part of this memory reset.

## File-operation retry limitation

Hindsight 0.10.2 file upload returns a server operation UUID but does not accept a caller-supplied operation UUID. Hypermail supplies a deterministic document ID and shares one in-process retention promise, so normal automatic/outbox races converge. A process crash after server acceptance but before the operation UUID is persisted can still repeat file conversion on retry; the stable document ID preserves the final document identity but cannot prevent duplicate provider work. Text and event retains do use deterministic caller operation UUIDs.

In 0.10.2, the returned file operation tracks conversion only: it completes when a separate retain operation is queued. Hypermail discovers that retain through the paginated operations API, matches its payload to the exact deterministic file document and conversion creation time, and waits for completion within the same deadline before allowing recall. Conversion completion alone is not retention proof.

Recall's chunk token budget can omit source chunks for otherwise valid returned facts. Hypermail accepts those facts without inventing source text, while still validating every included chunk's identity and content.

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
