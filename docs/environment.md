# Environment contract

Schemas live in [`packages/contracts/src/env.ts`](../packages/contracts/src/env.ts); `.env.example` contains redacted shapes only. Deployment injects secrets through the platform secret store or `/run/secrets` files. Environment validation reports variable names, never values.

- Web receives auth, recovery recipient, Hypermail server credentials, VAPID keys, application origin, DB URL, a dedicated private attachment directory, attachment byte/age limits, and the private approved-send endpoint/token.
- Worker receives DB/Hypermail/model credentials and bounded polling, retention, and safety settings.
- Backup jobs receive only DB URL, target, retention, and two separate `/run/secrets` age identity paths (one database domain and one Hypermail-state domain), plus backup-only object-store and failure-alert secret files.
- Provider access/refresh tokens and IMAP passwords are entered during Hypermail account onboarding and remain only in its encrypted persistent state. OAuth application configuration (for example a hosted Gmail client ID/secret and redirect URI) is Hypermail service bootstrap configuration when required; it is not injected into web or worker containers.
- Local Compose builds Hypermail from the exact `hypermail-mcp` version in `apps/hypermail/package.json`; no local `HYPERMAIL_IMAGE` value is required. Production publishes and pins the image built from that same package version by digest.
- Production exposes only the proxy/web route. Database, worker, Hypermail, and the approved-send endpoint resolve only on the private network. The approved-send endpoint must durably deduplicate `Idempotency-Key`; direct Hypermail v0.7 MCP send is not an exactly-once substitute.
- The attachment directory must be a dedicated non-symlink directory inaccessible to other workloads (not `/tmp`) and shared with the component that materializes Hypermail attachment files. Startup must run owned-orphan cleanup before accepting downloads.
