# Deployment assets

- `Dockerfile.web` and `Dockerfile.worker` build the production pnpm workspace independently and run as UID 10001.
- `Dockerfile.dev`, `compose.dev.yaml`, and `dev.mjs` provide dependency-aware Compose Watch for local source changes without production image rebuilds.
- `compose.local.yaml` is loopback-only for the local proxy; database, Hypermail, and pinned Hindsight 0.9.1 remain private. Copy `.env.hindsight.example` to `.env.hindsight` and configure its LLM provider before startup.
- `compose.vps.yaml` is the generic-VPS topology: only Caddy publishes `80` and `443`.
- `dokploy/compose.yaml` relies on Dokploy's Traefik network; it publishes no host ports.
- `backup/Dockerfile` is the one-shot daily backup image. The opt-in `backup` compose profile is private, mounts Hypermail state read-only, and is intended for the platform scheduler (`docker compose --profile backup run --rm backup`), not a long-running service. See [`docs/runbooks/backup-restore.md`](../docs/runbooks/backup-restore.md).

Local Hindsight uses the exact full `ghcr.io/vectorize-io/hindsight:0.9.1` image; production requires `HINDSIGHT_IMAGE` pinned by approved digest. Its control plane is disabled, API ports are not published, the stable worker ID is `hypermail-hindsight-0`, and `hindsight-data` persists embedded pg0 at `/home/hindsight/.pg0`. `HINDSIGHT_ENV_FILE` is service-only LLM configuration; it must never be reused as a web or worker env file. Release deployment may add the approved image digest without changing the `0.9.1` compatibility contract.

Set `HYPERMAIL_IMAGE` to the approved, pinned Hypermail v0.7.26 image before rendering either compose file. Its state directory is intentionally mounted at `/var/lib/hypermail`; confirm that path against the selected image before first production deployment.

Run static checks without deploying:

```sh
node infra/verify-deployment.mjs
```
