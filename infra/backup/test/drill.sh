#!/usr/bin/env bash
# Disposable seeded backup/restore drill. It uses a local filesystem AWS CLI double; no remote credentials are needed.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
: "${HINDSIGHT_DRILL_IMAGE:?set HINDSIGHT_DRILL_IMAGE to the approved Hindsight 0.9.1 digest}"
[[ "$HINDSIGHT_DRILL_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || exit 1
network="backup-drill-$RANDOM"; source="${DRILL_APPLICATION_SOURCE_CONTAINER:-backup-source-$RANDOM}"; target="backup-target-$RANDOM"; memory="backup-memory-$RANDOM"
owns_source=1; source_database=hypermail; source_user=hypermail; source_password=drill-password
source_url="postgresql://hypermail:drill-password@$source/hypermail"
if [ -n "${DRILL_APPLICATION_SOURCE_CONTAINER:-}" ]; then
  owns_source=0
  : "${DRILL_APPLICATION_SOURCE_DATABASE:?provide the isolated acceptance database name}"
  : "${DRILL_APPLICATION_SOURCE_URL:?provide the isolated container-network database URL}"
  [ "${DRILL_APPLICATION_QUIESCED:-}" = 1 ] || { printf 'application fixture must be quiesced\n' >&2; exit 1; }
  [[ "$DRILL_APPLICATION_SOURCE_DATABASE" =~ ^hypermail_acceptance_[a-f0-9]{32}$ ]] \
    && [ "$source" = "${DRILL_APPLICATION_SOURCE_DATABASE//_/-}" ] \
    && [ "$(docker inspect --format '{{ index .Config.Labels "hypermail.acceptance.resource" }}' "$source")" = "$DRILL_APPLICATION_SOURCE_DATABASE" ] \
    || { printf 'refuse database not owned by the isolated acceptance launcher\n' >&2; exit 1; }
  source_database=$DRILL_APPLICATION_SOURCE_DATABASE; source_user=acceptance; source_url=$DRILL_APPLICATION_SOURCE_URL
  source_password=$(python3 - "$source_url" "$source" "$source_database" <<'PY'
import sys
from urllib.parse import urlparse, unquote
url = urlparse(sys.argv[1])
if url.scheme != 'postgresql' or url.hostname != sys.argv[2] or url.port != 5432 or url.path != '/' + sys.argv[3] or url.username != 'acceptance' or not url.password:
    raise SystemExit('invalid isolated application database URL')
print(unquote(url.password))
PY
  )
fi
tmp=$(mktemp -d)
cleanup() {
  [ "$owns_source" = 0 ] || docker rm -f "$source" >/dev/null 2>&1 || true
  [ "$owns_source" = 1 ] || docker network disconnect "$network" "$source" >/dev/null 2>&1 || true
  docker rm -f "$target" "$memory" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker run --rm -v "$tmp:/work" alpine rm -rf /work/* >/dev/null 2>&1 || true
  rmdir "$tmp" 2>/dev/null || true
}
trap cleanup EXIT
docker build -q -f "$root/infra/backup/Dockerfile" -t hypermail-backup-drill "$root" >/dev/null
docker network create --internal "$network" >/dev/null
if [ "$owns_source" = 1 ]; then
  docker run -d --name "$source" --network "$network" -e POSTGRES_DB=hypermail -e POSTGRES_USER=hypermail -e POSTGRES_PASSWORD=drill-password postgres:16.10-alpine >/dev/null
else
  docker network connect "$network" "$source"
fi
docker run -d --name "$target" --network "$network" -e POSTGRES_DB=hypermail_restore -e POSTGRES_USER=hypermail -e POSTGRES_PASSWORD=drill-password postgres:16.10-alpine >/dev/null
# The image's temporary bootstrap server accepts Unix-socket connections before
# POSTGRES_DB exists. Probe the final TCP server and execute in the exact database.
# pg_isready alone neither validates the database nor excludes that init server.
wait_for_database() {
  local container=$1 database=$2 user=${3:-hypermail} password=${4:-drill-password} attempt
  for attempt in $(seq 1 60); do
    if [ "$(timeout 5s docker exec -e PGPASSWORD="$password" -e PGCONNECT_TIMEOUT=2 "$container" \
      psql -X -w -h 127.0.0.1 -U "$user" -d "$database" -v ON_ERROR_STOP=1 -tAc 'select current_database()' 2>/dev/null)" = "$database" ]; then
      return 0
    fi
    [ "$attempt" -eq 60 ] || sleep 1
  done
  printf 'drill failed: database %s in %s did not become ready within the bounded bootstrap wait\n' "$database" "$container" >&2
  return 1
}
wait_for_database "$source" "$source_database" "$source_user" "$source_password"
wait_for_database "$target" hypermail_restore
capture_application_database() {
  docker exec -i "$1" psql -X -qAt -U "$3" -d "$2" -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(
  'SELECT %L,count(*),md5(coalesce(string_agg(row_digest, %L ORDER BY row_digest), %L)) FROM (SELECT md5(to_jsonb(t)::text) row_digest FROM %I.%I t) data',
  schemaname || '.' || tablename, '', '', schemaname, tablename)
FROM pg_tables WHERE schemaname IN ('app','mastra') ORDER BY schemaname,tablename
\gexec
SQL
}
if [ "$owns_source" = 1 ]; then
  docker exec "$source" psql -U hypermail -d hypermail -c "create table drill_seed (id integer primary key, note text not null); insert into drill_seed values (7, 'seeded backup drill');" >/dev/null
else
  capture_application_database "$source" "$source_database" "$source_user" > "$tmp/source.snapshot"
  python3 - "$tmp/source.snapshot" <<'PY'
import sys
rows = {table: int(count) for table, count, digest in (line.rstrip('\n').split('|') for line in open(sys.argv[1]))}
required = ('accounts', 'agent_action_proposals', 'agent_action_reviews', 'agent_conversations', 'agent_conversation_messages', 'approved_send_submissions')
if any(rows.get('app.' + table, 0) == 0 for table in required):
    raise SystemExit('application restore requires a populated full acceptance fixture')
PY
fi
mkdir -p "$tmp/secrets" "$tmp/state" "$tmp/hindsight" "$tmp/mock-bin" "$tmp/s3" "$tmp/restore-state" "$tmp/restore-hindsight"
chmod 777 "$tmp/s3" "$tmp/restore-state" "$tmp/restore-hindsight"
if [ -n "${HINDSIGHT_DRILL_SOURCE_DIRECTORY:-}" ]; then
  [ "${HINDSIGHT_DRILL_SOURCE_ISOLATED:-}" = 1 ] && [ "${HINDSIGHT_DRILL_SOURCE_STOPPED:-}" = 1 ] || { printf 'require isolated, cleanly stopped Hindsight fixture\\n' >&2; exit 1; }
  : "${HINDSIGHT_DRILL_BANK:?provide the fixture bank ID}"
  : "${HINDSIGHT_DRILL_QUERY:?provide the prior memory recall query}"
  : "${HINDSIGHT_DRILL_EXPECTED:?provide text of the previously retained memory}"
  cp -a "$HINDSIGHT_DRILL_SOURCE_DIRECTORY/." "$tmp/hindsight/"
else
  printf 'synthetic Hindsight state fixture\\n' > "$tmp/hindsight/offline-fixture"
fi
age-keygen -o "$tmp/secrets/backup-database-key" >/dev/null 2>&1
age-keygen -o "$tmp/secrets/backup-state-key" >/dev/null 2>&1
printf '%s' 'postgresql://hypermail:drill-password@'"$target"'/hypermail_restore' > "$tmp/secrets/restore-db-url"
chmod 600 "$tmp/secrets"/*
printf 'synthetic hypermail state fixture\n' > "$tmp/state/account-state.json"
chmod 644 "$tmp/secrets/backup-database-key"
if docker run --rm --user 0 -v "$tmp/secrets:/run/secrets:ro" -v "$tmp/restore-state:/restore-state" --entrypoint /usr/local/bin/restore-run \
  -e BACKUP_TARGET=s3://drill-bucket/hypermail -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key \
  -e BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key -e RESTORE_ISOLATED=1 -e RESTORE_HINDSIGHT_IMAGE="$HINDSIGHT_DRILL_IMAGE" hypermail-backup-drill \
  --generation 1700000000-aaaaaaaaaaaa --target-db-url-file /run/secrets/restore-db-url --state-directory /restore-state --hindsight-directory /restore-hindsight >"$tmp/insecure-key.out" 2>&1; then
  printf '%s\n' 'drill failed: restore accepted a broadly readable key' >&2; exit 1
fi
grep -F '"event":"restore.failed"' "$tmp/insecure-key.out" >/dev/null
chmod 600 "$tmp/secrets/backup-database-key"
cat > "$tmp/mock-bin/aws" <<'AWS'
#!/usr/bin/env sh
set -eu
root=/mock-s3
[ "${1:-}" = s3 ] && { shift; [ "${1:-}" = cp ] && { shift; [ "${1:-}" = --only-show-errors ] && shift; src=$1; dst=$2; case "$src:$dst" in s3://*:* ) cp "$root/${src#s3://}" "$dst";; *:s3://* ) mkdir -p "$root/$(dirname "${dst#s3://}")"; cp "$src" "$root/${dst#s3://}";; esac; exit; }; [ "${1:-}" = rm ] && { shift; [ "${1:-}" = --only-show-errors ] && shift; rm -f "$root/${1#s3://}"; exit; }; }
[ "$1" = s3api ] && [ "$2" = list-objects-v2 ] || exit 2
shift 2; bucket=; prefix=
while [ $# -gt 0 ]; do case "$1" in --bucket) bucket=$2; shift 2;; --prefix) prefix=$2; shift 2;; *) shift;; esac; done
find "$root/$bucket/$prefix" -type f -printf "%P\n" 2>/dev/null | sed "s|^|$prefix|"
AWS
chmod +x "$tmp/mock-bin/aws"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker run --rm --user 0 --network "$network" -v "$tmp/secrets:/run/secrets:ro" -v "$tmp/state:/var/lib/hypermail:ro" -v "$tmp/hindsight:/var/lib/hindsight:ro" -v "$tmp/s3:/mock-s3" -v "$tmp/mock-bin/aws:/usr/local/bin/aws:ro" -e DATABASE_URL="$source_url" -e BACKUP_TARGET=s3://drill-bucket/hypermail -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key -e BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key -e BACKUP_RETENTION_DAYS=30 -e HYPERMAIL_STATE_DIRECTORY=/var/lib/hypermail -e HINDSIGHT_STATE_DIRECTORY=/var/lib/hindsight -e BACKUP_HINDSIGHT_IMAGE="$HINDSIGHT_DRILL_IMAGE" -e BACKUP_QUIESCENCE_AT="$(date -u +%s)" hypermail-backup-drill > "$tmp/backup.out"
generation=$(sed -n 's/.*"generation":"\([^"]*\)".*/\1/p' "$tmp/backup.out")
[[ "$generation" =~ ^[0-9]{10}-[0-9a-f]{12}$ ]] || { printf '%s\n' 'drill failed: backup returned no valid generation' >&2; exit 1; }
restore_generation() {
  docker run --rm --user 0 --network "$network" -v "$tmp/secrets:/run/secrets:ro" -v "$tmp/s3:/mock-s3" -v "$tmp/restore-state:/restore-state" -v "$tmp/restore-hindsight:/restore-hindsight" -v "$tmp/mock-bin/aws:/usr/local/bin/aws:ro" --entrypoint /usr/local/bin/restore-run -e BACKUP_TARGET=s3://drill-bucket/hypermail -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key -e BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key -e RESTORE_ISOLATED=1 -e RESTORE_HINDSIGHT_IMAGE="$HINDSIGHT_DRILL_IMAGE" hypermail-backup-drill --generation "$generation" --target-db-url-file /run/secrets/restore-db-url --state-directory /restore-state --hindsight-directory /restore-hindsight
}
# Corruption in the LAST artifact must prevent even the first database/state write.
artifact="drill-bucket/hypermail/generations/$generation/hindsight.tar.age"
docker run --rm -v "$tmp/s3:/s3" alpine sh -c 'cp "/s3/$1" "/s3/$1.saved"; printf x >> "/s3/$1"' sh "$artifact"
if restore_generation > "$tmp/corrupt.out" 2>&1; then
  printf 'drill failed: corrupt Hindsight archive accepted\\n' >&2; exit 1
fi
[ "$(docker exec "$target" psql -U hypermail -d hypermail_restore -tAc "select count(*) from pg_tables where schemaname in ('app','mastra') or (schemaname='public' and tablename='drill_seed')")" = 0 ]
[ -z "$(find "$tmp/restore-state" "$tmp/restore-hindsight" -mindepth 1 -print -quit)" ]
docker run --rm -v "$tmp/s3:/s3" alpine sh -c 'mv "/s3/$1.saved" "/s3/$1"' sh "$artifact"
restore_generation > "$tmp/restore.out"
application_state=not_exercised
if [ "$owns_source" = 1 ]; then
  docker exec "$target" psql -U hypermail -d hypermail_restore -tAc "select note from drill_seed where id = 7" | grep -Fx 'seeded backup drill' >/dev/null
else
  capture_application_database "$target" hypermail_restore hypermail > "$tmp/restored.snapshot"
  cmp "$tmp/source.snapshot" "$tmp/restored.snapshot"
  application_state=verified
fi
docker run --rm -v "$tmp/restore-state:/restore-state" alpine chmod -R a+rX /restore-state >/dev/null
cmp "$tmp/state/account-state.json" "$tmp/restore-state/account-state.json"
recall=not_exercised
if [ -n "${HINDSIGHT_DRILL_SOURCE_DIRECTORY:-}" ]; then
  # This restored runtime has no provider egress or published ports. Only offline/local
  # model configurations can satisfy this recall gate; do not silently enable egress.
  : "${HINDSIGHT_DRILL_ENV_FILE:?provide the isolated offline Hindsight env file}"
  docker run --rm --user 0:0 -v "$tmp/restore-hindsight:/restore-hindsight" alpine chown -R 1000:1000 /restore-hindsight
  docker run -d --name "$memory" --network "$network" --env-file "$HINDSIGHT_DRILL_ENV_FILE" -e HINDSIGHT_ENABLE_CP=false -v "$tmp/restore-hindsight:/home/hindsight/.pg0" "$HINDSIGHT_DRILL_IMAGE" >/dev/null
  for attempt in $(seq 1 90); do
    docker exec "$memory" curl --fail --silent --max-time 5 http://127.0.0.1:8888/health >/dev/null && break
    [ "$attempt" -lt 90 ] || { printf 'restored Hindsight health failed\\n' >&2; exit 1; }
    sleep 2
  done
  [[ "$HINDSIGHT_DRILL_BANK" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 1
  python3 - "$HINDSIGHT_DRILL_QUERY" > "$tmp/recall-request.json" <<'PY'
import json, sys
print(json.dumps({'query': sys.argv[1], 'budget': 'low', 'max_tokens': 1024}))
PY
  docker exec -i "$memory" curl --fail --silent --max-time 120 -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:8888/v1/default/banks/$HINDSIGHT_DRILL_BANK/memories/recall" < "$tmp/recall-request.json" > "$tmp/recall-result.json"
  python3 - "$tmp/recall-result.json" "$HINDSIGHT_DRILL_EXPECTED" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
if not any(sys.argv[2] in item.get('text', '') for item in result.get('results', [])):
    raise SystemExit('restored Hindsight did not recall the prior memory')
PY
  recall=verified
else
  docker run --rm -v "$tmp/restore-hindsight:/restore-hindsight" alpine chmod -R a+rX /restore-hindsight >/dev/null
  cmp "$tmp/hindsight/offline-fixture" "$tmp/restore-hindsight/offline-fixture"
  printf 'Hindsight recall NOT EXERCISED: supply stopped isolated seeded runtime fixture; release gate remains NO-GO\\n' >&2
fi
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker run --rm -v "$tmp/s3:/s3" alpine chmod -R a+rX /s3 >/dev/null
printf 'drill passed generation=%s started=%s finished=%s encrypted_bytes=%s application_state=%s memory_recall=%s\n' "$generation" "$started" "$finished" "$(du -sb "$tmp/s3" | awk '{print $1}')" "$application_state" "$recall"
