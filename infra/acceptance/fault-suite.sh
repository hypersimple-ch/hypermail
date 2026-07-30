#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

corepack pnpm vitest run \
  apps/worker/test/ingestion.test.ts \
  packages/agent/test/triage.test.ts \
  packages/policy/test/executor.test.ts \
  packages/notifications/test/worker.test.ts \
  apps/web/test/agent/postgres-repository.test.ts \
  apps/worker/test/lifecycle/retention.test.ts

if [[ -n "${DATABASE_URL:-}" ]]; then
  # These suites reset shared schemas, so execute them serially.
  DATABASE_URL="$DATABASE_URL" corepack pnpm vitest run apps/worker/test/lifecycle/postgres-store.test.ts
  DATABASE_URL="$DATABASE_URL" corepack pnpm vitest run apps/web/test/drafts/postgres-repository.test.ts
  DATABASE_URL="$DATABASE_URL" corepack pnpm vitest run packages/agent/test/triage.test.ts
else
  printf '%s\n' 'fault suite note: PostgreSQL restart/integration cases require DATABASE_URL' >&2
fi

printf '%s\n' 'component fault suite passed; deployed process/DB/queue/provider fault drill remains required'
