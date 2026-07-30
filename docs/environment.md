# Environment contract

Schemas live in [`packages/contracts/src/env.ts`](../packages/contracts/src/env.ts); `.env.example` contains redacted shapes only. Deployment injects secrets through the platform secret store or `/run/secrets` files. Environment validation reports variable names, never values.

- Web receives auth, recovery recipient, Hypermail server credentials, VAPID keys, application origin, DB URL, a dedicated private attachment directory, attachment byte/age limits, and the private approved-send endpoint/token.
- Worker receives DB/Hypermail/model credentials and bounded polling, retention, and safety settings.
- Backup jobs receive only DB URL, target, retention, and two separate `/run/secrets` age identity paths (one database domain and one Hypermail-state domain), plus backup-only object-store and failure-alert secret files.
- OAuth client secrets, provider access/refresh tokens, and IMAP passwords are not application environment variables; Hypermail owns them.
- Production exposes only the proxy/web route. Database, worker, Hypermail, and the approved-send endpoint resolve only on the private network. The approved-send endpoint must durably deduplicate `Idempotency-Key`; direct Hypermail v0.7 MCP send is not an exactly-once substitute.
- The attachment directory must be a dedicated non-symlink directory inaccessible to other workloads (not `/tmp`) and shared with the component that materializes Hypermail attachment files. Startup must run owned-orphan cleanup before accepting downloads.
