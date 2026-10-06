#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# No caller-supplied test paths or runtime service identities are accepted.
native_hindsight=0
native_stage=all
case "${1:-}" in
  "") test_file=apps/worker/test/full-acceptance.test.ts; native_model=0 ;;
  --native-model) test_file=apps/worker/test/native-model-acceptance.test.ts; native_model=1 ;;
  --native-hindsight) test_file=apps/worker/test/native-model-acceptance.test.ts; native_model=1; native_hindsight=1 ;;
  --native-hindsight-drafts) test_file=apps/worker/test/native-model-acceptance.test.ts; native_model=1; native_hindsight=1; native_stage=drafts ;;
  --native-hindsight-mailbox) test_file=apps/worker/test/native-model-acceptance.test.ts; native_model=1; native_hindsight=1; native_stage=mailbox ;;
  *) printf '%s\n' 'Usage: infra/acceptance/full-runtime.sh [--native-model|--native-hindsight|--native-hindsight-drafts|--native-hindsight-mailbox]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { printf '%s\n' 'Only one acceptance selector is allowed' >&2; exit 2; }

# No caller DATABASE_URL is accepted or propagated. Every run owns exactly one container.
resource="hypermail_acceptance_$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replaceAll("-", ""))')"
container="${resource//_/-}"
password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
peer="$container-hindsight"
volume="$peer-data"
hindsight_url=""
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  # Ownership is checked before deletion; never remove containers selected by a user-supplied name.
  if [[ "$(docker inspect --format '{{ index .Config.Labels "hypermail.acceptance.resource" }}' "$container" 2>/dev/null || true)" == "$resource" ]]; then
    docker rm -f -v "$container" >/dev/null
  fi
  if [[ "$(docker inspect --format '{{ index .Config.Labels "hypermail.acceptance.resource" }}' "$peer" 2>/dev/null || true)" == "$resource" ]]; then
    docker unpause "$peer" >/dev/null 2>&1 || true
    docker rm -f "$peer" >/dev/null
  fi
  if [[ "$(docker volume inspect --format '{{ index .Labels "hypermail.acceptance.resource" }}' "$volume" 2>/dev/null || true)" == "$resource" ]]; then
    docker volume rm "$volume" >/dev/null
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
if [[ "$native_hindsight" == 1 ]]; then
  secrets="${HINDSIGHT_ENV_FILE:-.env.hindsight}"
  [[ -f "$secrets" ]] || { printf '%s\n' 'Dedicated Hindsight provider env file required' >&2; exit 1; }
  docker volume create --label "hypermail.acceptance.resource=$resource" "$volume" >/dev/null
  docker run --detach --name "$peer" --label "hypermail.acceptance.resource=$resource" \
    --env-file "$secrets" --env HINDSIGHT_ENABLE_API=true --env HINDSIGHT_ENABLE_CP=false \
    --env HINDSIGHT_API_HOST=0.0.0.0 --env HINDSIGHT_API_PORT=8888 \
    --env "HINDSIGHT_API_WORKER_ID=$peer" --publish 127.0.0.1::8888 \
    --mount "type=volume,source=$volume,target=/home/hindsight/.pg0" \
    --health-cmd 'python -c "import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:8888/health/ready\", timeout=4).read()"' \
    --health-interval 5s --health-timeout 5s --health-start-period 60s --health-retries 36 \
    ghcr.io/vectorize-io/hindsight:0.10.2 >/dev/null
  for ((attempt=0; attempt<240; attempt++)); do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$peer")"
    [[ "$state" == healthy ]] && break
    [[ "$state" == unhealthy ]] && { printf '%s\n' 'Disposable Hindsight failed readiness' >&2; exit 1; }
    sleep 1
  done
  [[ "$state" == healthy ]] || { printf '%s\n' 'Disposable Hindsight readiness deadline exceeded' >&2; exit 1; }
  hindsight_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8888/tcp") 0).HostPort}}' "$peer")"
  hindsight_url="http://127.0.0.1:$hindsight_port"
fi
if [[ "$native_model" == 1 ]]; then
  printf '%s\n' 'Running native codex-cli/default + Mastra/Postgres acceptance with synthetic mail; native Hindsight selected only by --native-hindsight.'
else
  printf '%s\n' 'Running isolated actual web/worker HTTP acceptance (no live mailbox or provider credentials).'
fi
env -u DATABASE_URL \
  FULL_ACCEPTANCE_ISOLATED="$resource" \
  FULL_ACCEPTANCE_DATABASE_CONTAINER="$container" \
  FULL_ACCEPTANCE_NATIVE_MODEL="$native_model" \
  FULL_ACCEPTANCE_NATIVE_HINDSIGHT="$native_hindsight" \
  FULL_ACCEPTANCE_NATIVE_STAGE="$native_stage" \
  FULL_ACCEPTANCE_HINDSIGHT_CONTAINER="$peer" \
  FULL_ACCEPTANCE_HINDSIGHT_URL="$hindsight_url" \
  FULL_ACCEPTANCE_DATABASE_URL="postgresql://acceptance:$password@127.0.0.1:$port/$resource" \
  corepack pnpm vitest run "$test_file"
