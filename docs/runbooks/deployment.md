# Deployment runbook

## Branch and promotion policy

`main` is for ongoing development; all deployments use `prod`. Merge reviewed
development into `main`, then promote a reviewed release with a PR from `main`
to `prod`. Build release images from that `prod` revision and record the source
SHA alongside immutable image digests. Do not deploy from feature branches or
`main`. Rollbacks must be represented on `prod` too.

The currently published **Hypermail — site vitrine** Dokploy application uses
`hypersimple-ch/hypermail`, branch `prod`, build path `/website`, Static build,
publish directory `.`, and no SPA fallback. Automatic deployments are disabled:
after promotion, explicitly deploy and verify HTTPS, FR/EN pages and assets at
<https://hypermail.hypersimple.ch/>. It must not expose MCP, OAuth callbacks,
the PWA, worker, database or repository files.

The application-service procedures below retain their release preconditions.
Creating `prod` or publishing the website does not clear the application's
NO-GO status or its dependency-security findings.

## Preconditions

1. Build and pin immutable `WEB_IMAGE`, `WORKER_IMAGE`, and `BACKUP_IMAGE` digests. Set `HINDSIGHT_IMAGE` to the approved full Hindsight 0.9.1 `ghcr.io/vectorize-io/hindsight@sha256:…` digest. Worker startup refuses unavailable/incompatible Hindsight before creating consumers or its health listener; it checks exact `/version`, `/health/ready`, required features and bounded OpenAPI methods. After that mandatory gate, private readiness still requires DB/queue/model/Hypermail/policy checks. Web liveness alone does not prove backend readiness or a production deployment.
2. Build the Hypermail image from the exact `hypermail-mcp` version in `apps/hypermail/package.json`, publish it, and pin its immutable digest in `HYPERMAIL_IMAGE` for production. `HYPERMAIL_IMAGE` is deployment metadata, never a local user setting. Prove its state path, protocol contract, and UID/GID 10001 behavior in the proposed deployment. Web and Hypermail share that identity only for the mode-0700 attachment volume.
3. Create root-readable secret/env files. Required web values are `DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET`, `OAUTH_TOKEN_HASH_KEY`, `HYPERMAIL_URL`, `HYPERMAIL_KEY`, `HYPERMAIL_PROTOCOL_VERSION`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `ATTACHMENT_TEMP_DIRECTORY`; Compose supplies the last value. Configure web-only recovery with paired `RECOVERY_SMTP_HOST`/`RECOVERY_FROM`, port/secure settings, and optional paired user/password. Production requires validated TLS on 465 or STARTTLS on 587; recipients come from stored owner identities, never a deployment recipient override. Unconfigured SMTP degrades recovery without disabling login. Required worker values are `DATABASE_URL`, `HYPERMAIL_URL`, `HYPERMAIL_KEY`, `HYPERMAIL_PROTOCOL_VERSION`, `HYPERMAIL_TENANT_ROUTES`, `HINDSIGHT_URL`, `HINDSIGHT_EXPECTED_VERSION=0.9.1`, `MODEL_PROVIDER`, `MODEL_NAME`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `AGENT_GLOBAL_CONSTRAINTS`. Configure the bounded Hindsight timeout/file and mailbox-memory retry/lease/scheduler settings documented in [environment.md](../environment.md); add `HINDSIGHT_API_KEY` only for an auth-enabled endpoint and `MODEL_API_KEY` for the selected hosted provider. Codex host-login authentication is local-development-only and must not be copied into deployment. Integrated approved sending uses the scoped Hypermail provider and durable application journal; no separate send endpoint/token exists. `NODE_ENV`, attachment limits, `HEALTH_PORT`, and poll/lifecycle/shutdown/retention/safety settings have defaults.
4. Create a distinct root-readable `HINDSIGHT_ENV_FILE` with `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_MODEL`, and its provider API key when required. Do not reuse a web, worker, or Hypermail env file. Confirm the service disables its control plane, uses stable worker ID `hypermail-hindsight-0`, mounts `hindsight-data` at `/home/hindsight/.pg0`, has CPU/memory/file bounds, and publishes no ports. The full image uses local embeddings and reranking.
5. Add provider accounts through Hypermail onboarding. Provider tokens and IMAP passwords persist only in Hypermail's encrypted state volume; never put them in web, worker, or deployment env files. Gmail is optional: when enabled, put only `HYPERMAIL_GMAIL_CLIENT_ID`, the issued optional `HYPERMAIL_GMAIL_CLIENT_SECRET`, and `HYPERMAIL_GMAIL_REDIRECT_URI` in `HYPERMAIL_ENV_FILE`. Register that URI with Google exactly as `<APP_ORIGIN>/oauth/gmail/callback` (same scheme, host, path, and no trailing slash); do not register an internal Hypermail URL. If those Gmail client fields are absent, deploy Gmail as unavailable; Outlook and IMAP need none of them. Keep `HYPERMAIL_ENV_FILE` Hypermail-only and configure DNS/firewall for TCP 80/443 only; never publish web 3000, worker health 3001, PostgreSQL, or Hypermail.
6. Treat the Gmail client secret as a secret. For a client/redirect change or secret rotation, update Google registration and the Hypermail-only secret/env file, redeploy/restart Hypermail, check sanitized readiness, and only then revoke the old secret. Do not expose the file, rendered environment, or secret values. A successful Compose render proves configuration wiring, not a live Google OAuth/onboarding callback; validate the provider flow separately before declaring Gmail available. Follow the [Google OAuth runbook](google-oauth.md) for Google Console operations, credential handling, isolated acceptance, and production requirements.

## Generic VPS

Validate without starting containers:
Choose a non-overlapping private IPv4 `EDGE_PROXY_SUBNET` and reserve `EDGE_PROXY_IP` inside it before rendering VPS Compose. Compose gives Caddy that fixed IP and web trusts only its `/32`; do not publish backend ports. The Caddy templates overwrite client-supplied `X-Forwarded-For` with the immediate remote address and remove `Forwarded`, so an Internet client cannot supply a fake trusted chain. A CDN/load-balancer in front of Caddy needs its own explicitly reviewed origin/chain configuration; do not enable blanket forwarding trust.


```sh
node infra/verify-deployment.mjs
POSTGRES_PASSWORD_FILE=/secure/postgres-password \
WEB_ENV_FILE=/secure/hypermail-web.env WORKER_ENV_FILE=/secure/hypermail-worker.env \
HYPERMAIL_ENV_FILE=/secure/hypermail-hypermail.env HINDSIGHT_ENV_FILE=/secure/hypermail-hindsight.env \
WEB_IMAGE=registry/web@sha256:... WORKER_IMAGE=registry/worker@sha256:... HYPERMAIL_IMAGE=registry/hypermail@sha256:... \
APP_HOST=mail.example.com docker compose -f infra/compose.vps.yaml config -q
```

Before schema cutover, create a complete quiesced backup with `infra/backup/bin/backup-quiesced --env-file /secure/deployment.env -f infra/compose.vps.yaml` and confirm the final uploaded manifest (see [backup/restore](backup-restore.md)). Stop web/worker again before applying migrations; the backup orchestrator resumes services, so its completion is not a migration maintenance window. Run `DATABASE_URL=... corepack pnpm db:migrate` manually and once from the pinned release against the private database, record the result, then start the pinned private dependencies followed by web/worker and proxy. Production does not migrate automatically. Verify HTTPS and sanitized readiness dependency names only; never paste secret/env files or `docker inspect` output into tickets.

## Dokploy

Create a Compose application from `infra/dokploy/compose.yaml`, attach Dokploy's proxy network, mount the same env/secret files, and set `APP_HOST`. Render config first; confirm PostgreSQL, worker, Hypermail, and Hindsight have no ports, Hindsight has no Dokploy edge labels/network, and the web receives no Hindsight env/state. Dokploy/Traefik is the only public route.
Set web `TRUSTED_PROXY_CIDRS` to the actual isolated Traefik proxy address(es) only and configure Traefik to discard untrusted forwarded headers (do not enable forwardedHeaders.insecure). Default empty trust is deliberately fail-closed, but would aggregate proxied clients under the socket IP until correctly configured. Validate two client addresses obtain separate quota buckets and a forged chain cannot evade throttling before rollout.

## Outbound network policy

Production web joins `egress` for recovery SMTP and push; Hypermail joins it for provider APIs and IMAP/SMTP. Worker and Hindsight retain private ingress and join `egress` for their configured model providers, including authenticated Codex CLI calls. Backup joins it only for object storage/failure alerts while application PostgreSQL stays private. These Docker networks provide connectivity, **not** destination ACLs: enforce host/firewall egress allowlists for the configured SMTP host/port, provider APIs/IMAP/SMTP, model endpoints and object storage. Do not publish web, worker, Hypermail, PostgreSQL or Hindsight backend ports. SMTP secrets belong only to web; model secrets never belong to web/Hypermail. Restores use a different internal network without provider egress, not this production topology.

VPS host quiescence orchestration owns the public Caddy proxy. Dokploy's externally managed proxy needs separately reviewed route maintenance; do not claim the VPS script controls that external proxy. Neither backup nor restore containers receive a Docker socket.

The web CLI owns SIGTERM/SIGINT: it stops accepting HTTP, closes existing connections, drains recovery/provider work, and exits zero only after runtime cleanup. Shutdown is idempotent. Recovery stops claiming additional deliveries while its current claim finishes. A 35-second database-drain deadline followed by bounded 5-second pool closure prevents an unavailable PostgreSQL connection from hanging the 45-second host quiescence window. A database interrupted during provider acknowledgement leaves durable pending/ambiguous state for its existing recovery path; shutdown must not invent a successful provider outcome.

The pinned Hypermail CLI has no native signal handler. Its image loads `infra/hypermail-shutdown.mjs` through Node's public `--import` mechanism and [Diagnostics Channel API](https://nodejs.org/docs/latest-v22.x/api/diagnostics_channel.html#http). No vendor source is patched. The extension stops observed HTTP servers, waits for active requests, then ends idle provider transport sockets. It never forces exit zero: pending filesystem work drains naturally, while unknown listeners/background resources fail a 40-second deadline with exit one. Quiescence requires a previously healthy HTTP probe so the native server is observed. Empty-account/native idle-socket lifecycle passed; real authenticated provider connection/state quiescence remains part of the authorized live-provider gate.


## Release limitation

This runbook does not authorize rollout. Required remaining evidence includes an approved deployed Hypermail/protocol contract, isolated Outlook/Gmail/IMAP acceptance, authorized SMTP delivery, Android acceptance, journaled single-submission send with visible ambiguity (not an exactly-once guarantee), production-shaped public-network probing, complete quiesced backup and off-host **actual prior-memory recall** restore drill, Hindsight live compatibility, and model-vendor terms. A synthetic archive round-trip does not satisfy memory recall acceptance; keep NO-GO until those gates are exercised.
