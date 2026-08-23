# Deployment runbook

## Preconditions

1. Build and pin immutable `WEB_IMAGE`, `WORKER_IMAGE`, and `BACKUP_IMAGE` digests. Set `HINDSIGHT_IMAGE` to the approved full Hindsight 0.9.1 `ghcr.io/vectorize-io/hindsight@sha256:…` digest; the worker separately enforces API version `0.9.1`. Worker `dist/main.js` container smoke and web liveness/environment/graceful-shutdown checks pass; worker readiness is expected to remain `not_ready` until the Hypermail draft create/edit response contract is verified.
2. Build the Hypermail image from the exact `hypermail-mcp` version in `apps/hypermail/package.json`, publish it, and pin its immutable digest in `HYPERMAIL_IMAGE` for production. `HYPERMAIL_IMAGE` is deployment metadata, never a local user setting. Prove its state path, protocol contract, and UID/GID 10001 behavior in the proposed deployment. Web and Hypermail share that identity only for the mode-0700 attachment volume.
3. Create root-readable secret/env files. Required web values are `DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET`, `RECOVERY_RECIPIENT`, `HYPERMAIL_URL`, `HYPERMAIL_KEY`, `HYPERMAIL_PROTOCOL_VERSION`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `ATTACHMENT_TEMP_DIRECTORY`; Compose supplies the last value. Required worker values are `DATABASE_URL`, `HYPERMAIL_URL`, `HYPERMAIL_KEY`, `HYPERMAIL_PROTOCOL_VERSION`, `HYPERMAIL_TENANT_ROUTES`, `HINDSIGHT_URL`, `HINDSIGHT_EXPECTED_VERSION=0.9.1`, `MODEL_PROVIDER`, `MODEL_NAME`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `AGENT_GLOBAL_CONSTRAINTS`; set bounded Hindsight timeout/retry/file settings and add optional `HINDSIGHT_API_KEY` only to the worker env when an auth-enabled endpoint requires it; add a provider-specific `MODEL_API_KEY` only when using a hosted model provider. Codex host-login authentication is local-development-only and must not be copied into deployment. `NODE_ENV`, attachment limits, `HEALTH_PORT`, and poll/lifecycle/shutdown/retention/safety settings have defaults. Set `APPROVED_SEND_URL` and `APPROVED_SEND_TOKEN` together or omit both.
4. Create a distinct root-readable `HINDSIGHT_ENV_FILE` with `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_MODEL`, and its provider API key when required. Do not reuse a web, worker, or Hypermail env file. Confirm the service disables its control plane, uses stable worker ID `hypermail-hindsight-0`, mounts `hindsight-data` at `/home/hindsight/.pg0`, has CPU/memory/file bounds, and publishes no ports. The full image uses local embeddings and reranking.
5. Add provider accounts through Hypermail onboarding. Provider tokens and IMAP passwords persist only in Hypermail's encrypted state volume; never put them in web, worker, or deployment env files. Gmail is optional: when enabled, put only `HYPERMAIL_GMAIL_CLIENT_ID`, the issued optional `HYPERMAIL_GMAIL_CLIENT_SECRET`, and `HYPERMAIL_GMAIL_REDIRECT_URI` in `HYPERMAIL_ENV_FILE`. Register that URI with Google exactly as `<APP_ORIGIN>/oauth/gmail/callback` (same scheme, host, path, and no trailing slash); do not register an internal Hypermail URL. If those Gmail client fields are absent, deploy Gmail as unavailable; Outlook and IMAP need none of them. Keep `HYPERMAIL_ENV_FILE` Hypermail-only and configure DNS/firewall for TCP 80/443 only; never publish web 3000, worker health 3001, PostgreSQL, or Hypermail.
6. Treat the Gmail client secret as a secret. For a client/redirect change or secret rotation, update Google registration and the Hypermail-only secret/env file, redeploy/restart Hypermail, check sanitized readiness, and only then revoke the old secret. Do not expose the file, rendered environment, or secret values. A successful Compose render proves configuration wiring, not a live Google OAuth/onboarding callback; validate the provider flow separately before declaring Gmail available. Follow the [Google OAuth runbook](google-oauth.md) for Google Console operations, credential handling, isolated acceptance, and production requirements.

## Generic VPS

Validate without starting containers:

```sh
node infra/verify-deployment.mjs
POSTGRES_PASSWORD_FILE=/secure/postgres-password \
WEB_ENV_FILE=/secure/hypermail-web.env WORKER_ENV_FILE=/secure/hypermail-worker.env \
HYPERMAIL_ENV_FILE=/secure/hypermail-hypermail.env HINDSIGHT_ENV_FILE=/secure/hypermail-hindsight.env \
WEB_IMAGE=registry/web@sha256:... WORKER_IMAGE=registry/worker@sha256:... HYPERMAIL_IMAGE=registry/hypermail@sha256:... \
APP_HOST=mail.example.com docker compose -f infra/compose.vps.yaml config -q
```

After a reviewed backup, run `DATABASE_URL=... corepack pnpm db:migrate` manually and once from the pinned release against the private database, record the migration result, then deploy with the same variables using `docker compose -f infra/compose.vps.yaml up -d`. Unlike local Compose, production does not migrate automatically. Verify HTTPS and sanitized readiness dependency names only. Worker health is private; do not paste env files or `docker inspect` output into tickets.

## Dokploy

Create a Compose application from `infra/dokploy/compose.yaml`, attach Dokploy's proxy network, mount the same env/secret files, and set `APP_HOST`. Render config first; confirm PostgreSQL, worker, Hypermail, and Hindsight have no ports, Hindsight has no Dokploy edge labels/network, and the web receives no Hindsight env/state. Dokploy/Traefik is the only public route.

## Release limitation

This runbook does not authorize rollout. Required remaining evidence includes an approved deployed Hypermail/protocol contract, isolated Outlook/Gmail/IMAP acceptance, Android acceptance, private durable exactly-once send, production-shaped public-network probing, a supported quiesced/logical Hindsight backup and off-host recall restore drill, Hindsight live compatibility, and model-vendor terms.
