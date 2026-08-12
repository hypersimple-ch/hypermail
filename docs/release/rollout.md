# Production rollout and rollback record

Release candidate: unreleased `0.1.0` workspace state, 2026-07-30  
Decision: **NO-GO**

No production rollout is authorized. Runtime composition is proven in disposable PostgreSQL and image smoke checks, but live-provider, Android, send-service, and operational blockers remain.

## Pre-rollout gates

All boxes require immutable evidence from the exact proposed image digests and production-shaped configuration.

- [x] Web runtime image builds and passes liveness, environment, graceful-shutdown, and localhost PWA-shell checks; full Android/authenticated-product acceptance remains required.
- [x] Worker runtime image builds; `dist/main.js` smoke and migrated disposable-PostgreSQL lifecycle, pg-boss consumer/replay/isolation, pause/verification, health, and shutdown checks pass. Runtime readiness validates the pinned Hypermail restricted mutation schemas; live provider mutation acceptance remains required.
- [ ] Concrete Hypermail mutation transport implements only the policy allowlist and verifies provider outcomes.
- [ ] Private approved-send service is deployed, authorized, network-private, and durably deduplicates the approval key.
- [ ] Approved Hypermail v0.7.26 digest runs as UID/GID 10001, persists only its state volume, passes health, and writes attachment files through the shared mode-0700 `TMPDIR`.
- [ ] Outlook/M365, Gmail, and IMAP live matrices pass in isolated acceptance accounts, including controlled arrival/checkpoint/reconciliation and reversible mutations.
- [ ] Deployed fault drill passes worker/DB restarts, live-provider queue replay/consumption, model/push failures, question resume, verification ambiguity, pause race, exact safety threshold, and lifecycle restart. Disposable PostgreSQL coverage is not deployment evidence.
- [ ] Black-box security suite passes sessions/CSRF/isolation/attachments/log redaction and public/edge network probes.
- [ ] Real Android Chrome run passes install, standalone navigation, update, push/deep link, denied-push badge fallback, 360px layout, accessibility, and reduced motion.
- [x] Migrated disposable PostgreSQL serial integration passes, including web draft foreign keys and worker runtime behavior.
- [ ] PostgreSQL migration passes against a production snapshot clone; rollback compatibility is rehearsed.
- [ ] Real off-host backup upload, freshness alert, independent key recovery, and isolated restore pass. Never restore into production as a drill.
- [ ] Trivy and dependency scans report no high/critical finding; lower findings have release-owner acceptance.
- [ ] Model vendor/model, provider data-retention terms, regional processing, monthly cost ceiling, per-day token/request ceiling, and kill-switch owner are recorded below.
- [ ] DNS/TLS, proxy-only exposure, secret-store references, volume ownership, scheduler ownership, alert delivery, and operator contacts are verified.

## Model, retention, and cost decision

**BLOCKED — deployment owner decision required.** The code allows OpenAI, Anthropic, or Google and an arbitrary model name, but no vendor/model has been selected. No data-processing/retention agreement, zero-retention setting, region, monthly budget, token/request ceiling, or cost alert exists. Cached application bodies purge after 90 days; permanent metadata/audits and opaque email-derived observational summaries remain indefinitely. This asymmetry must be explicitly accepted before mail is sent to a cloud model.

Record the final vendor, model/version, retention/zero-retention terms, region, monthly currency ceiling, daily request/token ceiling, alert thresholds, and named operator in the release ticket; secrets remain only in the deployment secret store.

## Rollout sequence after every gate passes

1. Freeze source and pin web, worker, backup, PostgreSQL, proxy, and Hypermail image digests. Archive CI and acceptance evidence.
2. Confirm a fresh encrypted off-host backup and its manifest; test keys from the recovery path without printing them.
3. Put Hypermail in maintenance mode as required, run forward-only database migrations, then start private dependencies and verify readiness.
4. Start the worker while no accounts are connected and with global autonomy paused. Verify queue consumers, lifecycle scheduler, metrics, alerts, and health without mailbox mutations.
5. Start web behind HTTPS proxy; run login/session/CSRF and Android smoke checks. Keep all non-web services unreachable publicly.
6. Remove the deployment safety pause before connecting accounts. Connect each intended account through Hypermail, establish and record its baseline, and confirm existing Inbox mail creates no Activity.
7. Per product decision, autonomy begins immediately after each account baseline—there is no shadow/calibration mode. Closely monitor the first verified mutations and the 1% automatic pause.
8. Inject one controlled arrival per provider and verify one durable Activity, one logical push, model outcome, acknowledgement blocking, and history.
9. Keep rollback owner and incident channel active through the initial observation window defined in the release ticket.

## Rollback

1. Immediately set global autonomy pause. Polling, persistence, Activity, push, and health remain active.
2. If provider mutation correctness is uncertain, do not replay. Verify current provider state; surface `unverifiable`; manually reverse only recoverable actions.
3. Stop the new worker, preserve queue/domain rows, and redeploy the last known-good worker digest. Reconciliation must run because Hypermail checkpoints cannot be transactionally rewound.
4. Redeploy the previous web digest. Do not clear browser data or service-worker caches containing only the generic shell; activate the prior worker through the explicit update path.
5. Roll back application schema only through `docs/runbooks/migration-rollback.md` compatibility guidance. Never improvise destructive down migrations.
6. For data loss, follow `docs/runbooks/backup-restore.md` into explicit isolated targets, verify, then perform a separately approved recovery cutover. Never point `restore-run` at production.
7. Preserve safe correlation IDs, audits, image digests, timestamps, and fixed metrics. Rotate secrets if exposure is suspected.

## Current residual risks

- Password-only public access can expose every connected mailbox if compromised.
- Immediate autonomy has no calibrated evidence gate; one early error can exceed 1%.
- Observational Memory is experimental, opaque, and indefinitely retains derived sensitive facts.
- Hypermail checkpoint advancement is external; Inbox reconciliation reduces but cannot eliminate the crash gap.
- Per-email Activity/push volume may create alert fatigue.
- Recovery depends on a mailbox that may itself be compromised.
- Approved-send exactly-once behavior is external to Hypermail and currently undeployed.
- Production backup scheduling/off-host storage and real restore have not been exercised.
- Current lower-severity dependency findings and absent secret/SAST/IaC scans require explicit owner acceptance.
