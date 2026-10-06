# Deployment assets

- `Dockerfile.web` and `Dockerfile.worker` build the production pnpm workspace independently and run as UID 10001.
- `Dockerfile.dev`, `compose.dev.yaml`, and `dev.mjs` provide dependency-aware Compose Watch for local source changes without production image rebuilds.
- `compose.local.yaml` is loopback-only for the local proxy; database, Hypermail, and pinned Hindsight 0.10.2 remain private. Copy `.env.hindsight.example` to `.env.hindsight` and configure its LLM provider before startup.
- `compose.vps.yaml` is the generic-VPS topology: only Caddy publishes `80` and `443`.
- `dokploy/compose.yaml` relies on Dokploy's Traefik network; it publishes no host ports.
- `backup/Dockerfile` is a one-shot encrypted DB+Hypermail+Hindsight snapshot job. Schedule the **host** `backup/bin/backup-quiesced -f infra/compose.vps.yaml` orchestrator, not a direct `compose run backup`: it enters maintenance, cleanly stops all writers, attests quiescence, invokes the read-only volume job with `--no-deps`, and resumes in reverse order. Manifest v2 records all three ciphertext checksums/sizes and the pinned Hindsight image. No backup container gets a Docker socket. See [`docs/runbooks/backup-restore.md`](../docs/runbooks/backup-restore.md).

Local Hindsight uses the exact full `ghcr.io/vectorize-io/hindsight:0.10.2` image; production requires `HINDSIGHT_IMAGE` pinned by approved digest. Its control plane is disabled, API ports are not published, the stable worker ID is `hypermail-hindsight-0`, and `hindsight-data` persists embedded pg0 at `/home/hindsight/.pg0`. `HINDSIGHT_ENV_FILE` is service-only LLM configuration; it must never be reused as a web or worker env file. Release deployment may add the approved image digest without changing the `0.10.2` compatibility contract.

Set `HYPERMAIL_IMAGE` to the approved, pinned Hypermail v0.7.26 image before rendering either compose file. Its state directory is intentionally mounted at `/var/lib/hypermail`; confirm that path against the selected image before first production deployment.

Run static checks without deploying:

```sh
node infra/verify-deployment.mjs
```

## Isolated full-runtime acceptance

`bash infra/acceptance/full-runtime.sh` runs the known controlled-model HTTP scenario. Opt in to real configured model usage with:

```sh
bash infra/acceptance/full-runtime.sh --native-model
```

The selector accepts only these two reviewed tests. Both ignore caller `DATABASE_URL`, create a unique disposable loopback PostgreSQL container, verify the isolation token before resetting schemas, and remove only the container they own. Build the workspace packages before running because their exports resolve to `dist`; Docker, installed dependencies and the authenticated `codex` CLI are prerequisites.

The native case uses production `codex-cli/default` decision/conversation models and native Mastra/Postgres source history with Observational Memory enabled. It exercises authenticated onboarding/activation, synthetic `example.test` mail, durable v2 proposals, individual approval, verified provider draft readback, an owner draft correction and the next mail's persisted correction evidence. It never injects model decisions or source history and never rewrites a generated confidence score; a model choosing no action or providing no reviewable draft fails that gate rather than being substituted. The owner threshold is set to `1` to request review for scores below `1`.

Mailbox/provider HTTP and SMTP remain controlled loopback fixtures. Hindsight alone uses the explicit `ControlledMemory` test port because native Hindsight API/provider credentials are not available to this harness. Passing this case does **not** prove native Hindsight recall/restore, OM summary quality or real-provider/device acceptance, and does not change release **NO-GO**. Only synthetic messages reach the actual configured model; no secret environment values or recovery links are printed by the harness.

To also restore the populated application SQL state produced by the controlled HTTP case:

```sh
FULL_ACCEPTANCE_BACKUP_DRILL=1 HINDSIGHT_DRILL_IMAGE="${HINDSIGHT_IMAGE:?set an approved 0.10.2 digest}" \
  bash infra/acceptance/full-runtime.sh
```

The hook cleanly stops web/worker, verifies the launcher's ownership label, snapshots the complete application database, then compares every restored `app`/`mastra` table against its quiesced source. It requires populated accounts, proposals, reviews, conversations/messages and the approved-send journal. The internal restore target cannot reach providers. Synthetic provider/Hindsight archive bytes are not native memory recall; the drill reports that distinction explicitly.

## Native image shutdown regression

```sh
HYPERMAIL_RUNTIME_SMOKE_IMAGE="${HYPERMAIL_IMAGE:?set the built immutable image}" \
  pnpm exec vitest run apps/worker/test/hypermail-image.test.ts
```

This explicit Docker case creates only a labeled container it owns, blocks provider egress, runs the real pinned Hypermail MCP host with an owned idle TCP peer, and requires clean SIGTERM exit. The Node `--import` shutdown extension uses public diagnostics/server/socket APIs, not a vendor source patch or MCP proxy. Unknown remaining resources fail shutdown rather than being declared clean. Passing an empty/synthetic-peer host does not prove real account state or Hindsight prior-memory restore.
