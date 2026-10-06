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
- `website` — standalone bilingual public website, separate from the PWA and its services

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
cp .env.hindsight.example .env.hindsight
# Set a supported Hindsight LLM provider/model/key in .env.hindsight.
pnpm dev
```

Open <http://localhost:8080>. Local Compose applies migrations automatically and seeds a separate `codex-home` volume from the host's Codex login. Mastra can use that host login, but Hindsight requires its separately configured supported LLM provider in `.env.hindsight`; those credentials never reach web or worker. Press Ctrl-C to stop the containers. Never commit either env file or use the fixed development secrets in deployment.

`pnpm dev` uses Compose Watch. It keeps healthy containers running, synchronizes source changes, recompiles TypeScript and browser assets, and restarts only the changed web or worker process. It rebuilds the development images only when dependency manifests, the lockfile, or the development Dockerfile changes. Use `pnpm dev:rebuild` only to force that image rebuild while troubleshooting.

Locally, Compose builds the pinned Hypermail service from `apps/hypermail`; do not set an image name. In the app, open **More → Settings** to see projected mailboxes and start owner-driven Gmail, Outlook, or IMAP onboarding. Provider tokens and IMAP passwords stay in Hypermail's encrypted persistent state, not application environment files; the web app sends IMAP credentials only to its private owner-only API and never stores, logs, or echoes them.

Gmail and Outlook flows require deployment OAuth/device-code configuration and isolated provider accounts before they can be accepted as live integrations. The pinned local service and fixture proof do not establish that acceptance. Production secrets belong in deployment secret storage.

## Public website

`website/` contains the static Hypermail and Hypermail MCP website: French at
`index.html`, English at `en/index.html`, with privacy, terms and Gmail OAuth
setup pages in both languages. It requires no frontend build, JavaScript,
external fonts, analytics or cookies.

Preview from this repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
```

The visual foundations follow [`docs/design/system.md`](docs/design/system.md):
off-white `#F6F6F5`, white surfaces, charcoal `#252525`, thin `#E2E2E0`
borders, system typography, 8px controls and 12px cards. Green indicates product
availability, not branding. The inbox preview is conceptual. Composition
references are recorded in this
[private Lazyweb collection](https://www.lazyweb.com/agentic-search/7e65437f-7831-4322-8e05-e507bd0e1f0e);
competitor privacy claims and branding are not reused.

Dokploy publishes only `/website` from `feat/public-website` in
`hypersimple-ch/hypermail`, using the Static build type, publish directory `.`,
and SPA fallback disabled. Automatic deployments are disabled. The application
is **Hypermail — site vitrine**, in the **Hypermail** project of **Hypersimple**.
HTTPS routing is configured in the application's Traefik configuration for
<https://hypermail.hypersimple.ch/>; the temporary
<https://hypermail-website.46.225.4.162.nip.io/> address is also retained.

This deployment does not build or expose the PWA, worker, database, MCP server,
or OAuth callback. Use the public homepage, `/privacy.html` and `/terms.html`
URLs in Google Cloud branding; domain ownership and restricted-scope approval
remain separate Google requirements. Review the layout at 375px and 1440px
before changing the visual design.
