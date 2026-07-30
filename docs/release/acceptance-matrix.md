# Release acceptance matrix

Decision: **NO-GO**  
Evidence date: 2026-07-30

`PASS` is exercised at its required boundary. `PARTIAL` has runtime/disposable integration proof but lacks a required live or production-shaped boundary. `BLOCKED` has no required-boundary evidence.

| # | Idea success criterion | Status | Passing evidence | Release blocker |
|---:|---|---|---|---|
| 1 | No arrival, unresolved question, action failure, or polling failure is hidden | PARTIAL | Migrated serial PostgreSQL worker lifecycle, consumers, replay/isolation, health and shutdown | No live provider/deployed flow |
| 2 | Detect normal new Inbox mail within one minute | PARTIAL | 30–60s scheduler, lease/backoff, composed worker runtime | No isolated live provider timing run |
| 3 | Arrival is durable before agent work and creates one Activity/push | PARTIAL | PostgreSQL arrival/replay identity and pg-boss consumers | No live provider or push |
| 4 | Denied/unavailable push retains in-app pending state | PARTIAL | Notification contracts and browser/PWA shell | No Android denied-permission/live-push run |
| 5 | Model failures create unresolved items and durable bounded retries | PARTIAL | Composed queue/model failure paths | No approved model vendor/live run |
| 6 | Incorrect mutation rate pauses account and alerts | PARTIAL | Pause/verification and serial PostgreSQL integration | No live provider verification/alert delivery |
| 7 | Questions/corrections feed account-specific memory | PARTIAL | PostgreSQL isolation and suspend/resume | Opaque memory; no deployed question flow |
| 8 | Sending requires explicit authenticated review | PARTIAL | Draft FK, approval/replay contracts, runtime web routes | No approved private durable exactly-once send service |
| 9 | Provider mutations are verified and failures never appear successful | PARTIAL | Policy failed/unverifiable/ambiguous paths, runtime composition | No approved Hypermail mutation/protocol acceptance |
| 10 | PWA install and push verified on Android | BLOCKED | Manifest/SW/local browser checks | No Android/device or live push |
| 11 | 360px/responsive/accessibility guarantees | PARTIAL | 360/768/1440 no-overflow, 44px targets, focus, PWA browser acceptance | No Android/full authenticated UI accessibility audit |
| 12 | Daily separately encrypted backups have tested restore | PARTIAL | Disposable restore drill and integrity evidence | No off-host production-shaped restore/scheduler |

## Cross-cutting evidence

- `docs/evidence/runtime-acceptance-2026-07-30.md`
- `docs/evidence/fault-acceptance-2026-07-30.md`
- `docs/evidence/security-acceptance-2026-07-30.md`
- `docs/evidence/ui-pwa-acceptance-2026-07-30.md`
- `docs/evidence/backup-restore-drill-2026-07-30.md`
- `docs/evidence/security-scan-2026-07-30.md`

## Release blockers

1. Android/device acceptance.
2. Isolated live Outlook, Gmail, and IMAP plus approved deployed Hypermail/protocol validation.
3. Approved private durable exactly-once send service.
4. Verified Hypermail draft create/edit provider response contract; policy readiness remains `not_ready` until then.
5. Production-shaped Compose deployment, public-network probe, and off-host restore.
6. Model vendor/data-retention terms, region, cost controls, and named owner.
