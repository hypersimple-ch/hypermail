# Deployment runbook

## Preconditions

1. Build and pin immutable `WEB_IMAGE`, `WORKER_IMAGE`, and `BACKUP_IMAGE` digests. Worker `dist/main.js` container smoke and web liveness/environment/graceful-shutdown checks pass; worker readiness is expected to remain `not_ready` until the Hypermail draft create/edit response contract is verified.
2. Build the Hypermail image from the exact `hypermail-mcp` version in `apps/hypermail/package.json`, publish it, and pin its immutable digest in `HYPERMAIL_IMAGE` for production. `HYPERMAIL_IMAGE` is deployment metadata, never a local user setting. Prove its state path, protocol contract, and UID/GID 10001 behavior in the proposed deployment. Web and Hypermail share that identity only for the mode-0700 attachment volume.
3. Create root-readable secret/env files. Required web values are `DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET`, `RECOVERY_RECIPIENT`, `HYPERMAIL_URL`, `HYPERMAIL_KEY`, `HYPERMAIL_PROTOCOL_VERSION`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `ATTACHMENT_TEMP_DIRECTORY`; Compose supplies the last value. Required worker values are `DATABASE_URL`, `HYPERMAIL_URL`, `HYPERMAIL_KEY`, `HYPERMAIL_PROTOCOL_VERSION`, `MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_API_KEY`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `AGENT_GLOBAL_CONSTRAINTS`. `NODE_ENV`, attachment limits, `HEALTH_PORT`, and poll/lifecycle/shutdown/retention/safety settings have defaults. Set `APPROVED_SEND_URL` and `APPROVED_SEND_TOKEN` together or omit both.
4. Add provider accounts through Hypermail onboarding. Provider tokens and IMAP passwords persist only in Hypermail's encrypted state volume; never put them in web, worker, or deployment env files. If the selected provider requires OAuth application bootstrap configuration, supply it only to Hypermail through `HYPERMAIL_ENV_FILE`. Configure DNS/firewall for TCP 80/443 only; never publish web 3000, worker health 3001, PostgreSQL, or Hypermail.

## Generic VPS

Validate without starting containers:

```sh
node infra/verify-deployment.mjs
POSTGRES_PASSWORD_FILE=/secure/postgres-password \
WEB_ENV_FILE=/secure/hypermail-web.env WORKER_ENV_FILE=/secure/hypermail-worker.env \
HYPERMAIL_ENV_FILE=/secure/hypermail-hypermail.env WEB_IMAGE=registry/web@sha256:... \
WORKER_IMAGE=registry/worker@sha256:... HYPERMAIL_IMAGE=registry/hypermail@sha256:... \
APP_HOST=mail.example.com docker compose -f infra/compose.vps.yaml config -q
```

After a reviewed backup, run `DATABASE_URL=... corepack pnpm db:migrate` from the pinned release against the private database, record the migration result, then deploy with the same variables using `docker compose -f infra/compose.vps.yaml up -d`. Verify HTTPS and sanitized readiness dependency names only. Worker health is private; do not paste env files or `docker inspect` output into tickets.

## Dokploy

Create a Compose application from `infra/dokploy/compose.yaml`, attach Dokploy's proxy network, mount the same env/secret files, and set `APP_HOST`. Render config first; confirm PostgreSQL, worker, and Hypermail have no ports. Dokploy/Traefik is the only public route.

## Release limitation

This runbook does not authorize rollout. Required remaining evidence includes an approved deployed Hypermail/protocol contract, isolated Outlook/Gmail/IMAP acceptance, Android acceptance, private durable exactly-once send, production-shaped public-network probing, off-host restore, and model-vendor terms.
