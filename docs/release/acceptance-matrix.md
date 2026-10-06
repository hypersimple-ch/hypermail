# Release acceptance matrix

Decision: **NO-GO**  
Evidence date: 2026-10-06

`PASS` is exercised at its required boundary. `PARTIAL` has runtime/disposable integration proof but lacks a required live or production-shaped boundary. `BLOCKED` has no required-boundary evidence.

A bounded Gmail External/Testing onboarding proof passed on 2026-08-01. It is not a release-boundary pass: the test authorization expires after seven days and no Gmail arrival, read, mutation, send, timing, or production OAuth behavior was exercised.

| # | Idea success criterion | Status | Passing evidence | Release blocker |
|---:|---|---|---|---|
| 1 | No arrival, unresolved question, action failure, or polling failure is hidden | PARTIAL | Migrated serial PostgreSQL worker lifecycle, consumers, replay/isolation, health and shutdown | No live arrival/worker/deployed flow |
| 2 | Detect normal new Inbox mail within one minute | PARTIAL | 30–60s scheduler, lease/backoff, composed worker runtime | No isolated live provider timing run |
| 3 | Arrival is durable before agent work and creates one Activity/push | PARTIAL | PostgreSQL arrival/replay identity and pg-boss consumers | No live provider or push |
| 4 | Denied/unavailable push retains in-app pending state | PARTIAL | Notification contracts and browser/PWA shell | No Android denied-permission/live-push run |
| 5 | Model failures create unresolved items and durable bounded retries | PARTIAL | Queue failure/retry paths plus actual configured `codex-cli/default` synthetic-mail acceptance | Vendor/data-retention terms, region, cost controls and owner approval |
| 6 | Incorrect mutation rate pauses account and alerts | PARTIAL | Rolling 1/100 safety boundary, concurrency/replay exclusion, final pause fences and activation SQL integration | No live provider verification/alert delivery |
| 7 | Questions/corrections feed account-specific memory | PARTIAL | Scoped conversation SQL/native Mastra source history, actual-model correction evidence and suspend/resume | No native Hindsight recall/restore or deployed question flow |
| 8 | Sending requires explicit authenticated review | PARTIAL | Actual authenticated HTTP + PostgreSQL single-submission journal, concurrent approvals, ambiguity/restart/manual review and read-only reconciliation | Authorized live provider acceptance; no exactly-once promise |
| 9 | Provider mutations are verified and failures never appear successful | PARTIAL | Policy failed/unverifiable/ambiguous paths, runtime composition | No approved Hypermail mutation/protocol acceptance |
| 10 | PWA install and push verified on Android | BLOCKED | Manifest/SW/local browser checks | No Android/device or live push |
| 11 | 360px/responsive/accessibility guarantees | PARTIAL | Automated 360/700/1024/1440/1800px no-overflow/control checks and real UI behavior tests | No visual review, Android or full authenticated accessibility audit |
| 12 | Daily separately encrypted backups have tested restore | PARTIAL | Disposable restore drill and integrity evidence | No off-host production-shaped restore/scheduler |

## Cross-cutting evidence

- `docs/evidence/gmail-oauth-acceptance-2026-08-01.md`
- `docs/evidence/runtime-acceptance-2026-07-30.md`
- `docs/evidence/fault-acceptance-2026-07-30.md`
- `docs/evidence/security-acceptance-2026-07-30.md`
- `docs/evidence/ui-pwa-acceptance-2026-07-30.md`
- `docs/evidence/backup-restore-drill-2026-07-30.md`
- `docs/evidence/security-scan-2026-07-30.md`

## Release blockers

1. Android/device acceptance.
2. Isolated live Outlook and IMAP remain untested. Gmail passed onboarding only in the seven-day External/Testing tier; live Gmail arrival/read/mutation/timing and approved deployed Hypermail/protocol validation remain outstanding.
3. Authorized live acceptance of the integrated approved-send journal, ambiguous outcomes and read-only Sent reconciliation; provider submission cannot guarantee exactly-once delivery.
4. Live provider validation of Hypermail draft create/edit and post-mutation verification; runtime schema readiness alone is not provider acceptance.
5. Production-shaped Compose deployment, public-network probe, and off-host restore.
6. Model vendor/data-retention terms, region, cost controls, and named owner.

## Isolated full-runtime scenario

Run `bash infra/acceptance/full-runtime.sh` from a checkout whose workspace packages have been built by the normal verification flow. Dependencies: the repository's Node/Corepack/pnpm toolchain, installed workspace dependencies, Docker, and `postgres:16.10-alpine` (Docker may pull it). No SMTP credentials, model key, live mailbox or user-provided `DATABASE_URL` is required or accepted by the controlled case.

The launcher creates a uniquely named, labeled PostgreSQL container with a randomly mapped loopback port and a run-specific database/password. Its trap removes only the matching owned container and anonymous volumes, including on failure or interruption. The scenario independently rejects a database URL outside that run's loopback/name contract before calling the schema-reset harness.

The scenario starts the actual web HTTP adapter and worker composition, PostgreSQL/pg-boss consumers, durable decisions/proposals/reviews, policy mutations and provider readback. Hypermail is a controlled **network HTTP MCP endpoint**, recovery uses a controlled **network SMTP server**, and the deterministic model/source-history/mailbox-memory seams live only under `apps/worker/test/`. Authentication, mailbox onboarding and assistant activation use HTTP; no grants are seeded by SQL. It exercises mixed 0.60/0.5999 actions, correction without replaying the independent draft, individual approve/reject and replay, scoped/contextual and explicit-global chat including future-mailbox backfill, failed-turn retry over worker restart, scoped correction recall changing subsequent verified mutations, concurrent approved send with unknown reconciliation without resubmission, web restart, and one-use SMTP password recovery/session revocation. The received SMTP body is then injected into the connected owner mailbox after token use: it must remain readable through HTTP while its real arrival job and memory outbox complete without sending its token/body to the model or memory.

The controlled scenario **passed on 2026-10-05**, including its optional quiesced application-state backup/restore hook. The restore compared every `app`/`mastra` table's row count and sorted-row digest, including populated accounts, proposals, reviews, conversations and approved-send submissions. Provider/Hindsight state was synthetic; `memory_recall=not_exercised`. This is not native Hindsight recall/restore, live provider delivery/Sent behavior, production TLS/proxy deployment, visual UI review or Android acceptance. The separate `--native-model` case requires authenticated `codex-cli/default` and native Mastra/Postgres source history; see [runtime evidence](../evidence/runtime-acceptance-2026-07-30.md) for its independently observed result. Controlled memory is not a production fallback and does not make the release GO.

## Owner visual/device review

Visual review was not performed. On an explicitly authorized isolated profile, review Settings activation → new Inbox arrival → individual proposals/approve/reject/correction in Questions → mailbox-scoped and explicit-global Chat → full Reader/reply draft → send confirmation/reauthentication/unknown reconciliation → recovery/reset/sign-in.

Then exercise an actual Android installation: push allowed/denied, partial device delivery, offline/reconnect and session return. These manual/device checks, native Hindsight prior-memory restore and authorized live-provider behavior remain release gates; automated responsive/UI tests do not replace them.
