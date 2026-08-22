# Deployment assets

- `Dockerfile.web` and `Dockerfile.worker` build the production pnpm workspace independently and run as UID 10001.
- `Dockerfile.dev`, `compose.dev.yaml`, and `dev.mjs` provide dependency-aware Compose Watch for local source changes without production image rebuilds.
- `compose.local.yaml` is loopback-only for the local proxy; database and Hypermail remain private.
- `compose.vps.yaml` is the generic-VPS topology: only Caddy publishes `80` and `443`.
- `dokploy/compose.yaml` relies on Dokploy's Traefik network; it publishes no host ports.
- `backup/Dockerfile` is the one-shot daily backup image. The opt-in `backup` compose profile is private, mounts Hypermail state read-only, and is intended for the platform scheduler (`docker compose --profile backup run --rm backup`), not a long-running service. See [`docs/runbooks/backup-restore.md`](../docs/runbooks/backup-restore.md).

Set `HYPERMAIL_IMAGE` to the approved, pinned Hypermail v0.7.26 image before rendering either compose file. Its state directory is intentionally mounted at `/var/lib/hypermail`; confirm that path against the selected image before first production deployment.

Run static checks without deploying:

```sh
node infra/verify-deployment.mjs
```

The application placeholders do not yet start an HTTP server. The web Dockerfile exposes port 3000 for the future web listener and both image health checks currently verify that PID 1 stays alive. Wire the `apps/*/src/health.ts` contracts to real endpoints before deployment.
