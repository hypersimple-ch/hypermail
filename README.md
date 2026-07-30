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

Copy `.env.example` only as a variable-name reference. Inject real secrets through deployment secret storage and never commit them.
