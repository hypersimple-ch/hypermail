#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

corepack pnpm vitest run \
  packages/auth/test/auth.test.ts \
  apps/web/test/server.test.ts \
  apps/web/test/attachments/attachments.test.ts \
  apps/web/test/drafts/drafts.test.ts \
  apps/web/test/agent/agent.test.ts \
  packages/agent/test/triage.test.ts \
  packages/policy/test/executor.test.ts \
  packages/observability/test/observability.test.ts \
  apps/worker/test/ingestion.test.ts

node infra/verify-deployment.mjs
corepack pnpm security:scan
for compose in infra/compose.local.yaml infra/compose.vps.yaml infra/dokploy/compose.yaml; do
  docker compose -f "$compose" config --no-interpolate -q
done

printf '%s\n' 'component security suite passed; authenticated black-box API and live network probes remain required'
