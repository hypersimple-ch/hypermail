#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Accept only the two reviewed cases; never interpolate a caller-supplied test path.
case "${1:-}" in
  "") test_file=apps/worker/test/full-acceptance.test.ts; native_model=0 ;;
  --native-model) test_file=apps/worker/test/native-model-acceptance.test.ts; native_model=1 ;;
  *) printf '%s\n' 'Usage: infra/acceptance/full-runtime.sh [--native-model]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { printf '%s\n' 'Only one acceptance selector is allowed' >&2; exit 2; }

# No caller DATABASE_URL is accepted or propagated. Every run owns exactly one container.
resource="hypermail_acceptance_$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replaceAll("-", ""))')"
container="${resource//_/-}"
password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  # Ownership is checked before deletion; never remove containers selected by a user-supplied name.
  if [[ "$(docker inspect --format '{{ index .Config.Labels "hypermail.acceptance.resource" }}' "$container" 2>/dev/null || true)" == "$resource" ]]; then
    docker rm -f -v "$container" >/dev/null
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run --detach --name "$container" \
  --label "hypermail.acceptance.resource=$resource" \
  --publish 127.0.0.1::5432 \
  --env "POSTGRES_DB=$resource" --env POSTGRES_USER=acceptance --env "POSTGRES_PASSWORD=$password" \
  --health-cmd 'pg_isready -U acceptance' --health-interval 1s --health-timeout 3s --health-retries 30 \
  postgres:16.10-alpine >/dev/null
for ((attempt=0; attempt<45; attempt++)); do
  state="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy ]] && { printf '%s\n' 'Disposable PostgreSQL failed readiness' >&2; exit 1; }
  sleep 1
done
[[ "$state" == healthy ]] || { printf '%s\n' 'Disposable PostgreSQL readiness deadline exceeded' >&2; exit 1; }
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")"
if [[ "$native_model" == 1 ]]; then
  printf '%s\n' 'Running isolated native codex-cli/default + Mastra/Postgres acceptance; only synthetic mail reaches the configured model. Hindsight is a test port, not native acceptance.'
else
  printf '%s\n' 'Running isolated actual web/worker HTTP acceptance (no live mailbox or provider credentials).'
fi
env -u DATABASE_URL \
  FULL_ACCEPTANCE_ISOLATED="$resource" \
  FULL_ACCEPTANCE_DATABASE_CONTAINER="$container" \
  FULL_ACCEPTANCE_NATIVE_MODEL="$native_model" \
  FULL_ACCEPTANCE_DATABASE_URL="postgresql://acceptance:$password@127.0.0.1:$port/$resource" \
  corepack pnpm vitest run "$test_file"
