# Environment contract

Schemas live in [`packages/contracts/src/env.ts`](../packages/contracts/src/env.ts). `.env.example` is a copy-ready **local-only** configuration with fixed, loudly non-production secrets; deployment injects distinct secrets through the platform secret store or `/run/secrets` files. Environment validation reports variable names, never values.

- Local development uses `MODEL_PROVIDER=codex-cli` and `MODEL_NAME=default`, with no `MODEL_API_KEY`. Run `codex login` on the host first when needed. Local Compose bind-mounts that host auth file read-only only to seed its isolated `codex-home` volume; the worker uses the isolated volume afterward. Do not place host Codex credentials in `.env` or deployment secrets.
- A hosted model provider instead needs its provider-specific API key in deployment secret storage. It must not reuse Codex host-login credentials.
- Local Compose runs its migration service automatically before web and worker start. Production migrations remain a reviewed, manual, one-at-a-time operation; see [`docs/runbooks/migration-rollback.md`](runbooks/migration-rollback.md).

- Web receives auth, recovery recipient, Hypermail server credentials, VAPID keys, application origin, DB URL, a dedicated private attachment directory, attachment byte/age limits, and the private approved-send endpoint/token.
- Worker receives DB/Hypermail/model credentials and bounded polling, retention, and safety settings.
- Backup jobs receive only DB URL, target, retention, and two separate `/run/secrets` age identity paths (one database domain and one Hypermail-state domain), plus backup-only object-store and failure-alert secret files.
- Provider access/refresh tokens and IMAP passwords are entered during Hypermail account onboarding and remain only in its encrypted persistent state. OAuth application configuration (for example a hosted Gmail client ID/secret and redirect URI) is Hypermail service bootstrap configuration when required; it is not injected into web or worker containers.
- Local Compose builds Hypermail from the exact `hypermail-mcp` version in `apps/hypermail/package.json`; no local `HYPERMAIL_IMAGE` value is required. Production publishes and pins the image built from that same package version by digest.
- Production exposes only the proxy/web route. Database, worker, Hypermail, and the approved-send endpoint resolve only on the private network. The approved-send endpoint must durably deduplicate `Idempotency-Key`; direct Hypermail v0.7 MCP send is not an exactly-once substitute.
- `HYPERMAIL_PROTOCOL_VERSION=2025-11-25` is verified for local initialization against the pinned v0.7.26 image. This does not prove provider tools or the production contract; keep those release blockers until the full live matrix passes. See [`docs/contracts/hypermail.md`](contracts/hypermail.md).
- The attachment directory must be a dedicated non-symlink directory inaccessible to other workloads (not `/tmp`) and shared with the component that materializes Hypermail attachment files. Startup must run owned-orphan cleanup before accepting downloads.
