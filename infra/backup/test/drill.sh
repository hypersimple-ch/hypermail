#!/usr/bin/env bash
# Disposable seeded backup/restore drill. It uses a local filesystem AWS CLI double; no remote credentials are needed.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
tmp=$(mktemp -d); network="backup-drill-$RANDOM"; source="backup-source-$RANDOM"; target="backup-target-$RANDOM"
cleanup() { docker rm -f "$source" "$target" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; docker run --rm -v "$tmp:/work" alpine rm -rf /work/* >/dev/null 2>&1 || true; rmdir "$tmp" 2>/dev/null || true; }
trap cleanup EXIT
docker build -q -f "$root/infra/backup/Dockerfile" -t hypermail-backup-drill "$root" >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$source" --network "$network" -e POSTGRES_DB=hypermail -e POSTGRES_USER=hypermail -e POSTGRES_PASSWORD=drill-password postgres:16.10-alpine >/dev/null
docker run -d --name "$target" --network "$network" -e POSTGRES_DB=hypermail_restore -e POSTGRES_USER=hypermail -e POSTGRES_PASSWORD=drill-password postgres:16.10-alpine >/dev/null
until docker exec "$source" pg_isready -U hypermail -d hypermail >/dev/null && docker exec "$target" pg_isready -U hypermail -d hypermail_restore >/dev/null; do sleep 1; done
docker exec "$source" psql -U hypermail -d hypermail -c "create table drill_seed (id integer primary key, note text not null); insert into drill_seed values (7, 'seeded backup drill');" >/dev/null
mkdir -p "$tmp/secrets" "$tmp/state" "$tmp/mock-bin" "$tmp/s3" "$tmp/restore-state"
chmod 777 "$tmp/s3" "$tmp/restore-state"
age-keygen -o "$tmp/secrets/backup-database-key" >/dev/null 2>&1
age-keygen -o "$tmp/secrets/backup-state-key" >/dev/null 2>&1
printf '%s' 'postgresql://hypermail:drill-password@'"$target"'/hypermail_restore' > "$tmp/secrets/restore-db-url"
chmod 600 "$tmp/secrets"/*
printf 'synthetic hypermail state fixture\n' > "$tmp/state/account-state.json"
chmod 644 "$tmp/secrets/backup-database-key"
if docker run --rm --user 0 -v "$tmp/secrets:/run/secrets:ro" -v "$tmp/restore-state:/restore-state" --entrypoint /usr/local/bin/restore-run \
  -e BACKUP_TARGET=s3://drill-bucket/hypermail -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key \
  -e BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key -e RESTORE_ISOLATED=1 hypermail-backup-drill \
  --generation 1700000000-aaaaaaaaaaaa --target-db-url-file /run/secrets/restore-db-url --state-directory /restore-state >"$tmp/insecure-key.out" 2>&1; then
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
docker run --rm --user 0 --network "$network" -v "$tmp/secrets:/run/secrets:ro" -v "$tmp/state:/var/lib/hypermail:ro" -v "$tmp/s3:/mock-s3" -v "$tmp/mock-bin/aws:/usr/local/bin/aws:ro" -e DATABASE_URL='postgresql://hypermail:drill-password@'"$source"'/hypermail' -e BACKUP_TARGET=s3://drill-bucket/hypermail -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key -e BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key -e BACKUP_RETENTION_DAYS=30 -e HYPERMAIL_STATE_DIRECTORY=/var/lib/hypermail hypermail-backup-drill > "$tmp/backup.out"
generation=$(sed -n 's/.*"generation":"\([^"]*\)".*/\1/p' "$tmp/backup.out")
[[ "$generation" =~ ^[0-9]{10}-[0-9a-f]{12}$ ]] || { printf '%s\n' 'drill failed: backup returned no valid generation' >&2; exit 1; }
RESTORE_ISOLATED=1 docker run --rm --user 0 --network "$network" -v "$tmp/secrets:/run/secrets:ro" -v "$tmp/s3:/mock-s3" -v "$tmp/restore-state:/restore-state" -v "$tmp/mock-bin/aws:/usr/local/bin/aws:ro" --entrypoint /usr/local/bin/restore-run -e BACKUP_TARGET=s3://drill-bucket/hypermail -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key -e BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key -e RESTORE_ISOLATED=1 hypermail-backup-drill --generation "$generation" --target-db-url-file /run/secrets/restore-db-url --state-directory /restore-state > "$tmp/restore.out"
docker exec "$target" psql -U hypermail -d hypermail_restore -tAc "select note from drill_seed where id = 7" | grep -Fx 'seeded backup drill' >/dev/null
docker run --rm -v "$tmp/restore-state:/restore-state" alpine chmod -R a+rX /restore-state >/dev/null
cmp "$tmp/state/account-state.json" "$tmp/restore-state/account-state.json"
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker run --rm -v "$tmp/s3:/s3" alpine chmod -R a+rX /s3 >/dev/null
printf 'drill passed generation=%s started=%s finished=%s encrypted_bytes=%s\n' "$generation" "$started" "$finished" "$(du -sb "$tmp/s3" | awk '{print $1}')"
