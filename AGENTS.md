# Hypermail agent guide

Use this as a routing index, not as a replacement for the project documentation. Read only the documents relevant to the task; do not load all of `docs/` by default.

## Start here

- Product scope, setup, and current release status: [`README.md`](README.md)
- System boundaries, safety rules, and failure handling: [`docs/architecture.md`](docs/architecture.md)

## Task-specific references

- Database schema, ownership, retention, and invariants: [`docs/data-model.md`](docs/data-model.md) and [`docs/retention.md`](docs/retention.md)
- Hypermail MCP integration and supported tool payloads: [`docs/contracts/hypermail.md`](docs/contracts/hypermail.md)
- Mastra memory constraints and the supported proof: [`docs/decisions/mastra-proof.md`](docs/decisions/mastra-proof.md)
- UI work: [`docs/design/system.md`](docs/design/system.md) and [`docs/design/screens.md`](docs/design/screens.md)
- Environment variables: [`docs/environment.md`](docs/environment.md) and [`.env.example`](.env.example)
- Deployment, health, migration, backup, secrets, or incidents: [`docs/runbooks/`](docs/runbooks/)
- Release readiness or rollout: [`docs/release/acceptance-matrix.md`](docs/release/acceptance-matrix.md) and [`docs/release/rollout.md`](docs/release/rollout.md)

## Documentation rules

- Treat code, migrations, tests, and deployment configuration as authoritative for current behavior; update relevant docs when a deliberate behavior or operational contract changes.
- `docs/evidence/` is dated acceptance evidence, not a current requirement or proof that later changes still work.
- Do not copy documentation into instructions. Keep this file short and add task-specific links only when they are durable and broadly useful.
