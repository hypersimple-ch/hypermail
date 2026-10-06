# Backup and isolated restore runbook

## Daily quiesced job

Build and publish `infra/backup/Dockerfile` as the immutable `BACKUP_IMAGE`. Schedule the **host** command below from the repository root, with the same Compose env and files as the running deployment:

```sh
infra/backup/bin/backup-quiesced --env-file /secure/deployment.env -f infra/compose.vps.yaml
```

The host requires Docker Compose with `start --wait`, `flock`, and permission to operate this stack. The script holds an exclusive host lock (default `/run/lock/hypermail-backup.lock`), verifies the complete running stack and a digest-pinned Hindsight image, then enters maintenance by stopping the public proxy. Clients see an unavailable service during this maintenance window, not an application 503 page. It stops web, worker, Hypermail, then Hindsight with a 45-second timeout per service; every service must report `exited 0`. A timeout/forced kill is **not** an acceptable PostgreSQL snapshot.

Only after clean shutdown does it invoke `backup` with `--no-deps`, a fresh quiescence timestamp and the running Hindsight image digest. PostgreSQL application storage remains running for a logical `pg_dump`. The backup container mounts Hypermail and Hindsight volumes **read-only**, never a Docker socket. Do not tar a running Hindsight PostgreSQL directory. Direct scheduled `compose run backup` is no longer supported: the job refuses a missing/stale host attestation. Do not persist the attestation in an env file.

The Compose backup job runs as container UID 0 with all capabilities dropped except `DAC_OVERRIDE`, and `no-new-privileges`, solely to read the differently owned mode-0700 state volumes/secrets. State mounts remain read-only. Do not weaken production state directory permissions to accommodate the backup user.

The EXIT/signal trap restarts in reverse order: Hindsight, Hypermail, worker, web, proxy, waiting for each service. A failed restart stops that sequence and exits nonzero, leaving the public route closed for operator intervention. Upload failures still trigger restart. Do not run concurrent deploy/restart operations while the host backup lock is held. Dokploy has an external proxy rather than the VPS `proxy` service: arrange an explicitly reviewed host maintenance procedure that removes its public route and attests clean shutdown of all four writers; the VPS orchestrator fails closed on that topology rather than pretending it controlled the external proxy.

Required backup-only environment: `DATABASE_URL`, `BACKUP_TARGET=s3://bucket/prefix`, `BACKUP_RETENTION_DAYS`, `BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup-database-key`, `BACKUP_STATE_ENCRYPTION_KEY_FILE=/run/secrets/backup-state-key`, `HYPERMAIL_STATE_DIRECTORY=/var/lib/hypermail`, `HINDSIGHT_STATE_DIRECTORY=/var/lib/hindsight`, restricted AWS credentials and `BACKUP_ALERT_WEBHOOK_FILE=/run/secrets/backup-alert-webhook`. Compose supplies the volume paths. Host-only runtime values are `BACKUP_QUIESCENCE_AT` and `BACKUP_HINDSIGHT_IMAGE`.

Use two independent age identities in separate secret-store access domains: database/manifest and state (Hypermail + Hindsight). Missing, broadly readable or equal keys are refused. Both state archives contain secrets and require the same restricted treatment as mailbox credentials. Manifest `schemaVersion:2` records ciphertext SHA-256 and byte size for `database.dump.age`, `state.tar.age`, and `hindsight.tar.age`, plus Hindsight version `0.10.2`, exact image digest and clean-shutdown snapshot method. `manifest.age` is uploaded **last**; only then is `backup.succeeded` emitted. Incomplete generations without a final manifest are not valid backups. Retention deletes only the four exact known filenames from expired generations, never an entire bucket/prefix. Fa…

## Isolated restore preconditions

1. Select the generation from the incident record; do not restore into production as an exploratory step.
2. Provision a new internal Docker network (no provider egress), isolated PostgreSQL database named `restore` or `hypermail_restore`, and **two new empty, disjoint directories/volumes** for Hypermail and Hindsight. Keep restored web/worker stopped until separately approved isolated checks; restored queues must never reach real providers.
3. Mount the original database/state age identities and an explicit isolated-target DB URL file read-only under `/run/secrets`. Use AWS read access limited to the backup prefix. Set `RESTORE_HINDSIGHT_IMAGE` to the exact image digest in this generation's manifest.
4. Set `RESTORE_ISOLATED=1`. The guard is an operator acknowledgement, not a network sandbox: enforce actual egress isolation on the host/network. Never publish restored backend ports or grant access to the production volumes.

```sh
RESTORE_ISOLATED=1 RESTORE_HINDSIGHT_IMAGE=registry/hindsight@sha256:... restore-run \
  --generation 1700000000-0123456789ab \
  --target-db-url-file /run/secrets/isolated-restore-db-url \
  --state-directory /restore/hypermail-state \
  --hindsight-directory /restore/hindsight-state
```

The script validates manifest version, generation, exact Hindsight image/version and all three ciphertext hashes/sizes, decrypts **all** artifacts, validates both tar archives (relative paths, regular files/directories only), checks target separation and verifies the custom dump is readable **before any restore target writes**. It then restores DB and both offline state archives. Extraction uses no original ownership/permissions: set the required restored container UID/GID and private state permissions before startup. No Docker operations or service restart happen inside `restore-run`. Restore remains non-atomic across artifacts; after a write failure discard all isolated targets and repeat into fresh empty targets, rather than reusing partial state.

Legacy manifests without `schemaVersion:2` are explicitly refused as **incomplete memory backups**. Historical DB+Hypermail backups may support a separately reviewed partial incident recovery, but cannot prove complete assistant memory restoration. A purged outbox cannot recreate a deleted Hindsight bank.

## Verification and drills

Record generation, UTC start/end, ciphertext byte count, integrity checks, image version/digest and sampled application records (accounts, action/review state, conversations and approved-send journal). Do not record secrets, message contents, tokens, keys or recipients. Start restored Hypermail only on a provider-egress-blocked network and perform read-only health checks. Start restored Hindsight with the recorded image on that network and prove recall of a specific memory retained **before** backup; row counts or archive-byte comparison do not prove recall. Restored ambiguous sends must remain ambiguous without resubmission.

`python3 infra/backup/test/orchestration.py` runs behavioral host orchestration regressions using a simulated Docker CLI; no daemon/network/real state is touched. `HINDSIGHT_DRILL_IMAGE=<approved digest> infra/backup/test/drill.sh` builds the backup image, starts disposable PostgreSQL on an internal network, round-trips a seeded DB row and synthetic state archives via a local AWS CLI double, and reports `memory_recall=not_exercised` unless a real memory fixture is supplied. That result is **not** the Hindsight restore acceptance gate.

Select `HINDSIGHT_DRILL_VERSION=0.10.2` (default) or `HINDSIGHT_DRILL_VERSION=0.9.1` and provide `HINDSIGHT_DRILL_IMAGE` as the exact immutable digest for that version. Run the drill separately for both versions with corresponding cleanly stopped isolated data fixtures; do not reopen a migrated fixture with 0.9.1. The drill re-encrypts only its disposable manifest to model a historical 0.9.1 archive; the production backup writer always announces 0.10.2. It rejects unsupported versions and mismatched archived image digests before any target write, then restores the selected compatible generation. When a runtime fixture is supplied, its `/version` must match the archived version before real recall is exercised. Historical 0.9.1 backups remain readable only with their recorded image; this does not relax the normal worker's strict 0.10.2 readiness contract.

The complete application-state option runs after the controlled full HTTP acceptance case:

```sh
FULL_ACCEPTANCE_BACKUP_DRILL=1 HINDSIGHT_DRILL_IMAGE="${HINDSIGHT_IMAGE:?set an approved 0.10.2 digest}" \
  bash infra/acceptance/full-runtime.sh
```

It stops its owned web/worker, validates the disposable database name/container label and explicit quiescence, then restores to a fresh internal-network target. All `app`/`mastra` table rows are compared with the source via sorted-row digests/counts; populated account/proposal/review/conversation/send-journal tables are mandatory. Corruption must leave every target empty before a valid generation is accepted. The command passed on 2026-10-05, but provider/Hindsight state remains an offline synthetic fixture and native Mastra OM restoration is not exercised by this case.


For actual recall, additionally provide `HINDSIGHT_DRILL_SOURCE_DIRECTORY` (a test-only pre-seeded full Hindsight data directory), `HINDSIGHT_DRILL_SOURCE_ISOLATED=1`, `HINDSIGHT_DRILL_SOURCE_STOPPED=1` after clean shutdown, `HINDSIGHT_DRILL_ENV_FILE` with a genuinely offline/local model configuration, `HINDSIGHT_DRILL_BANK`, `HINDSIGHT_DRILL_QUERY`, and `HINDSIGHT_DRILL_EXPECTED` (a unique previously retained text). The drill starts the **restored** image with no published ports and no provider egress, calls actual recall, and requires that prior text in returned memory results. An unavailable image/model/fixture is an unexercised NO-GO gate, not permission to substitute mock recall or open egress. No production storage/SMTP/mailbox mutation is authorized by this runbook.

Run isolated drills before deployment changes and at least quarterly. Rotate database and state keys independently: verify a complete generation with new secret-store entries and retain old keys until their generations expire. Do not overwrite key versions in place.
