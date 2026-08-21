# Hypermail PWA

Private, single-user, Android-first email PWA with a public web/API service, private Mastra worker, private Hypermail MCP service, and PostgreSQL.

> **Release status: NO-GO.** The authenticated Settings and Account surfaces are composed, but live provider, Android, approved-send, and production-shaped restore acceptance remain blocked. See [`docs/release/acceptance-matrix.md`](docs/release/acceptance-matrix.md).

## Requirements

- Node.js 22.23.2 (see `.nvmrc`)
- pnpm 11.11.0 through Corepack
- PostgreSQL 16+ for migrations and integration work
- Google Chrome or Chromium for the responsive UI checks in `pnpm check` (`CHROME_BIN` can point to a non-standard installation)

## Workspace

- `apps/web` — public web/API service
- `apps/worker` — private polling/agent worker
- `apps/hypermail` — pinned `hypermail-mcp` runtime used by the local private service
- `packages/contracts` — strict Zod environment/domain contracts and transition reducers
- `packages/db` — Drizzle schema and migrations
- `packages/{auth,hypermail,policy,agent,notifications}` — bounded production packages
- `infra` — deployment assets added in phase 3
- `docs` — architecture, data model, design, contracts, and decisions
- `spikes` — evidence only; excluded from the production pnpm workspace

## Commands

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
DATABASE_URL=postgresql://... corepack pnpm db:migrate
```

## Local development

Log in to Codex on the host if needed, then copy the fixed local-only configuration and start Compose:

```sh
# Run `codex login` first if you are not already logged in.
cp .env.example .env
pnpm dev
```

Open <http://localhost:8080>. Local Compose applies migrations automatically and seeds a separate `codex-home` volume from the host's Codex login; it does not use a model API key. Press Ctrl-C to stop the containers. Never commit `.env` or use its fixed development secrets in deployment.

Locally, Compose builds the pinned Hypermail service from `apps/hypermail`; do not set an image name. In the app, open **More → Settings** to see projected mailboxes and start owner-driven Gmail, Outlook, or IMAP onboarding. Provider tokens and IMAP passwords stay in Hypermail's encrypted persistent state, not application environment files; the web app sends IMAP credentials only to its private owner-only API and never stores, logs, or echoes them.

Gmail and Outlook flows require deployment OAuth/device-code configuration and isolated provider accounts before they can be accepted as live integrations. The pinned local service and fixture proof do not establish that acceptance. Production secrets belong in deployment secret storage.
