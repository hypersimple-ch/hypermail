#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

env -u DATABASE_URL corepack pnpm vitest run \
  apps/worker/test/ingestion.test.ts \
  packages/agent/test/triage.test.ts \
  packages/policy/test/executor.test.ts \
  packages/notifications/test/worker.test.ts \
  apps/web/test/agent/postgres-repository.test.ts \
  apps/worker/test/lifecycle/retention.test.ts

if [[ -n "${DATABASE_URL:-}" ]]; then
  # Resetting migrated schemas is part of each SQL case's bounded I/O budget.
  # One serial invocation avoids repeated module startup and shared-schema races.
  DATABASE_URL="$DATABASE_URL" corepack pnpm vitest run --fileParallelism=false --testTimeout=30000 \
    apps/worker/test/lifecycle/postgres-store.test.ts \
    apps/web/test/drafts/postgres-repository.test.ts \
    packages/agent/test/triage.test.ts \
    packages/db/test/migration.test.ts \
    apps/web/test/agent/postgres-repository.test.ts \
    apps/web/test/activity/canonical-postgres.test.ts \
    apps/worker/test/canonical-policy-postgres.test.ts \
    apps/worker/test/postgres-runtime.test.ts \
    apps/worker/test/question-continuation-postgres.test.ts \
    packages/db/test/conversation-postgres.test.ts \
    packages/auth/test/recovery-postgres.test.ts \
    apps/worker/test/notification-delivery-postgres.test.ts \
    apps/web/test/agent-connections/postgres.test.ts \
    apps/worker/test/mailbox-memory-arrival-postgres.test.ts \
    apps/web/test/send-requests/postgres.test.ts
else
  printf '%s\n' 'fault suite note: PostgreSQL restart/integration cases require DATABASE_URL' >&2
fi

printf '%s\n' 'component fault suite passed; deployed process/DB/queue/provider fault drill remains required'
