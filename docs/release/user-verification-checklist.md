# User verification checklist — release-v1

Working document for the `work/release-v1` review. Items are ordered by
who must do them: this machine did everything automatable; the rest
needs your accounts, devices, or VPS.

## Already verified on this machine

- Full `pnpm check` green: build, responsive layout (360–1800px), lint,
  typecheck, 494 tests, deployment static verification.
- OpenRouter integration: worker model and Hindsight LLM both reach
  `stealth/ox-alpha` through `MODEL_BASE_URL`; Hindsight retain/recall
  proven against the running service.
- Live IMAP end-to-end: local Dovecot onboarded through the app's own
  API; worker polling, arrival transaction, activity creation, agent
  claim, and fail-closed authority checks all exercised with real data.
- UI walkthrough at 360px and 1440px with seeded data (screenshots in
  `artifacts/ui-audit/`).

## You: OpenRouter

1. `stealth/ox-alpha` sits behind a shared upstream pool that returns
   429s regularly. Decisions fail safely and retry, but throughput
   depends on that pool. Options: add credits/own provider key, or use
   OpenRouter provider routing to a paid upstream.
2. The key lives only in gitignored `.env` / `.env.hindsight`. Rotate it
   if it was shared anywhere else.

## You: Gmail OAuth (Console-only steps)

1. The OAuth client (`155279310125…`, project `hypersimple-hypermail-*`)
   only has `http://localhost:8080/oauth/gmail/callback` registered.
   This audit ran the stack on 8081 because another project's proxy
   occupies 8080. Either add
   `http://localhost:8081/oauth/gmail/callback` in Google Auth
   Platform → Clients, or free port 8080 and set `LOCAL_HTTP_PORT=8080`.
2. Complete one authorized onboarding with an isolated test Gmail
   account (see `docs/runbooks/google-oauth.md`). Testing-tier grants
   expire after 7 days; the current Gmail projection is `degraded`
   because its test authorization expired.
3. Production later needs its own project, verified domain, and the
   restricted-scope verification process.

## You: Outlook and real IMAP

1. Outlook uses the pinned Hypermail public client — run one device-code
   onboarding from Settings and confirm arrival within a minute.
2. Repeat the IMAP flow against a real provider (the local Dovecot proof
   covers mechanics, not provider quirks like IDLE or odd folder names).

## You: Android device

1. Install the PWA from the deployed origin, confirm the install prompt,
   offline shell, and no horizontal scroll at 360px.
2. Grant notification permission; verify push delivery and the denied-
   permission in-app badge path.
3. Run through Inbox → message → reply draft → Activity → Settings on
   the device.

## You: VPS via Dokploy

1. Follow `docs/runbooks/deployment.md` with
   `infra/dokploy/compose.yaml`: build and pin WEB/WORKER/BACKUP/HYPERMAIL
   image digests, mount env/secret files, set `APP_HOST` and the Dokploy
   network.
2. Worker env must include `MODEL_PROVIDER=openai`, `MODEL_NAME`,
   `MODEL_API_KEY`, `MODEL_BASE_URL=https://openrouter.ai/api/v1`, and
   `MODEL_TIMEOUT_MS` (reasoning models: 120000–240000 worked locally).
   Hindsight env needs `HINDSIGHT_API_LLM_PROVIDER=openai`, the model
   slug, key, and `HINDSIGHT_API_LLM_BASE_URL`.
3. First deployment keeps worker readiness `not_ready` until the
   Hypermail draft create/edit contract is verified live — expected.
4. Configure the backup profile and run one off-host restore drill
   (`docs/runbooks/backup-restore.md`).

## Known issues found during this audit

- The pinned `hypermail-mcp` v0.7.26 image crashes on IMAP connection
  failures (unhandled imapflow error) and caches stale IMAP pools after
  the IMAP server restarts; Compose restarts it, but the fix belongs
  upstream. Avoid restarting your IMAP provider mid-poll.
- The rich-text-editor test was intermittently flaky under full-suite
  parallel load; its async waits now use 10s timeouts and three
  consecutive full runs passed.
