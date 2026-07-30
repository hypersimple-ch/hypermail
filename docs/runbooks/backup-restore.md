# Backup and isolated restore runbook

## Daily job

`infra/backup/Dockerfile` is a one-shot Alpine job containing pinned-distribution `pg_dump`/`pg_restore`, `age`, `tar`, and AWS CLI. Build and publish it as the immutable `BACKUP_IMAGE`. Schedule `docker compose --profile backup run --rm backup` once daily (or the equivalent Dokploy scheduled job), on the private application network. Do not turn it into a public service.

The backup job requires a backup-only env file with `DATABASE_URL`, `BACKUP_TARGET` (`s3://bucket/prefix`), `BACKUP_RETENTION_DAYS`, `BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key`, and `BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key`. It also requires `HYPERMAIL_STATE_DIRECTORY=/var/lib/hypermail`, AWS credentials with access only to that bucket prefix, and `BACKUP_ALERT_WEBHOOK_FILE=/run/secrets/backup-alert-webhook`. The webhook receives only service, status, and timestamp.

Create two independent age identity files: one database key and one Hypermail-state key. They must be in separate secret-store entries/access domains and must never be copied to application env files or the database. The job rejects missing, broad-permission, or equal keys; it encrypts `pg_dump` and the state tar with their respective recipients. It uploads a generation only to object storage, never a local backup directory. The encrypted manifest carries ciphertext sizes and SHA-256 values. A failure exits non-zero and sends the sanitized failure alert.

Pause Hypermail writes or place it in its documented maintenance mode before the scheduled state snapshot; resume after the job succeeds. Inspect the sanitized structured `backup.succeeded` record and backup freshness. Retention removes only the three known files from generations whose own epoch-prefixed IDs exceed the configured age; it never recursively deletes a bucket or prefix.

## Restore preconditions

1. Select the generation from the object-store incident record. Stop the production worker before any recovery decision; do not restore into production as an exploratory step.
2. Provision a new private network, a new PostgreSQL instance/database named `restore` or `hypermail_restore`, and a **new empty** state directory/volume. Its connection URL must be explicitly supplied; the script accepts no default source URL.
3. Mount the same two age identity secrets and a dedicated isolated-target database URL file read-only at `/run/secrets`, and ensure AWS read access to the chosen prefix. Install/use the backup image so its required tools match the job.
4. Set `RESTORE_ISOLATED=1`. This is an explicit acknowledgement that the target is isolated. The restore script rejects other database names and a nonempty state directory.

## Isolated restore and verification

```sh
RESTORE_ISOLATED=1 restore-run \
  --generation 1700000000-0123456789ab \
  --target-db-url-file /run/secrets/isolated-restore-db-url \
  --state-directory /restore/hypermail-state
```

The script downloads the three exact artifacts, decrypts the encrypted manifest with the database key, verifies both encrypted artifact hashes and sizes before decrypting, restores the PostgreSQL custom dump, then extracts state into the empty target. It fails closed on unavailable tools, keys, S3 objects, manifest/decryption/integrity errors, or unsafe targets. It does not call Docker volume commands and cannot implicitly overwrite production.

Verify the expected schema/table counts and a sampled application record in the isolated database, then start an isolated Hypermail instance against the restored state and complete its health/read-only account check. Record generation, UTC start/end, encrypted byte count, hash/integrity result, and database/state checks in `docs/evidence/`; never record URLs, credentials, recipients, provider tokens, state contents, or key fingerprints. Only after an approved incident decision should a separately reviewed production migration/restore procedure be executed.

## Rotation and drills

Rotate database and state keys independently: create a new secret-store entry, run and verify a backup with the new pair, retain the old relevant key until every retained generation is expired or deliberately retired, then revoke it. Do not overwrite key files in place. Restore requires the key version that encrypted its generation.

Run `infra/backup/test/drill.sh` before deployment changes and at least quarterly. It starts disposable PostgreSQL containers, seeds a record and synthetic state fixture, uses a local AWS CLI double, restores into a separate database and empty directory, and checks both values. It does not contact object storage or use production secrets.
