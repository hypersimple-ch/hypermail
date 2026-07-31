# Hypermail PWA

Private, single-user, Android-first email PWA with a public web/API service, private Mastra worker, private Hypermail MCP service, and PostgreSQL.

> **Release status: NO-GO.** Domain libraries, migrations, fixture/component tests, deployment definitions, and the minimal install/connectivity shell exist, but the authenticated product APIs/UI and operational worker are not composed in the running entrypoints. Live provider, Android, approved-send, and production-shaped restore acceptance remain blocked. See [`docs/release/acceptance-matrix.md`](docs/release/acceptance-matrix.md).

## Requirements

- Node.js 22.18.0 (see `.nvmrc`)
- pnpm 11.11.0 through Corepack
- PostgreSQL 16+ for migrations and integration work

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

Locally, Compose builds the pinned Hypermail service from `apps/hypermail`; do not set an image name. Add mailbox accounts through Hypermail onboarding: provider tokens and IMAP passwords remain in Hypermail's encrypted persistent state, not application environment files. Production secrets belong in deployment secret storage.
