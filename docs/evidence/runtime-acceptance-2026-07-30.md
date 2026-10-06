# Runtime acceptance record

Status: **PARTIAL / NO-GO**

Historical 2026-07-30 check: **176 tests, 11 skipped**, without a live environment. Migrated disposable-PostgreSQL serial integration passed: web draft FK behavior; worker lifecycle; pg-boss consumers, replay and isolation; pause/verification; health; and shutdown. Web and worker runtime images built; `dist/main.js` passed container smoke. Web liveness, environment validation, and graceful shutdown passed.

At that historical checkpoint, worker readiness remained `not_ready` because the Hypermail draft create/edit response contract was not verified. This was not live-provider, deployed-Compose, Android or exactly-once-send evidence.

Artifacts: `artifacts/acceptance/phase3-*`.

## 2026-10-05 implementation acceptance

- `FULL_ACCEPTANCE_BACKUP_DRILL=1 HINDSIGHT_DRILL_IMAGE=<approved 0.9.1 digest> bash infra/acceptance/full-runtime.sh`: **passed**, one end-to-end case, 178.16 seconds. Actual web HTTP adapter, PostgreSQL/pg-boss worker, proposal/review authorization, verified provider readback, scoped/global conversations and future-mailbox backfill, retry/restart, ordinary/public approved-send ambiguity, SMTP reset/session revocation, and exclusion of delivered recovery mail from model/memory.
- `bash infra/acceptance/full-runtime.sh --native-model`: **passed**, one end-to-end case, 109.87 seconds. Actual authenticated `codex-cli/default`, native Mastra/Postgres source history with OM enabled, native owner conversation, three synthetic mail decisions, generated v2 proposals/scores, individual draft approval/readback, owner correction and subsequent model correction evidence. No injected decisions/source history or confidence rewriting. Hypermail/SMTP and Hindsight remain explicitly controlled test ports.
- Native-provider failure was reproduced: generated JSON Schema `oneOf` and email regex lookaround are rejected by the configured provider. The Mastra adapter now uses its public Standard Schema API to preserve a provider-compatible envelope; exclusive literal-tag unions use `anyOf`, email uses `format=email`, and canonical Zod validation still fences the extracted v2 decision.
- Recovery/send SQL suites: **14 passed**; subsequent serial runtime/question/conversation/recovery/notification/activation/arrival/send set: **22 passed across 8 files**.
- Browser Inbox/onboarding/real lazy editor regressions: **7 passed across 3 files**. Test roots and late imports now have owned cleanup; functional assertions remain.
- Application-state backup/restore passed; see [restore evidence](backup-restore-drill-2026-07-30.md). Native Hindsight prior-memory recall, native OM summary quality, real provider/device acceptance, off-host storage and model-vendor terms remain unproven. No production rollout or mailbox mutation was performed.

## 2026-10-06 final integration gate

- `pnpm check`: **passed**, 524 tests passed / 55 skipped, 83 files passed / 24 skipped. This includes workspace build, five responsive widths, ESLint, TypeScript, behavioral tests and deployment preflight. PostgreSQL/native-image cases have separate explicit runs; skipped cases are not counted as passing.
- `DATABASE_URL=<owned disposable database> bash infra/acceptance/fault-suite.sh`: **passed**, initial component phase 71 passed / 2 skipped, then 81 passed across 15 serialized SQL files. All schema resets used the dedicated disposable database, never a shared/user database.
- Full controlled HTTP + quiesced application-state backup/restore repeated successfully after shutdown integration: one case passed, 177.45 seconds. Generation `1791246364-8a4b8c4459c0`, UTC 00:26:03–00:26:12, 455,751 encrypted bytes; `application_state=verified`, `memory_recall=not_exercised`.
- Web CLI regression now lives in the existing `apps/web/test/startup.test.ts` suite. An owned loopback PostgreSQL wire fixture accepts startup but never answers queries; actual compiled CLI exits zero and closes sockets within its host stop deadline. The final image's no-egress liveness probe returned 200 and SIGTERM exited zero; the previous image was force-killed with 137.
- Native Hypermail lifecycle: `HYPERMAIL_RUNTIME_SMOKE_IMAGE=<built image> pnpm exec vitest run apps/worker/test/hypermail-image.test.ts` **passed**, including an owned idle TCP peer. The pre-socket-drain image failed the same case with exit 1; current runtime exits zero after HTTP/transport resources drain. Original unextended vendor CLI timed out and exited 137. The isolated Node preload extension modifies no vendor source and never forces success.
- Post-review regression hardening preserves the image's configured `NODE_OPTIONS` and appends only the owned peer fixture; the test no longer injects a missing production shutdown preload. The native image case, ESLint, TypeScript and deployment preflight passed again. No additional source-text wiring assertion was substituted for the runtime behavior check.
- The worker image with no reachable Hindsight **refused startup with exit 1 / HINDSIGHT_UNAVAILABLE**, as required; this is mandatory-gate proof, not a healthy deployed-worker claim. Actual worker/queue behavior was exercised by the full HTTP scenario.
- All three images built; VPS and Dokploy `docker compose … config -q` both passed using empty synthetic secret files and non-secret configuration. Nothing was deployed or published.
- Built image IDs: web `8cd9c85488b12ed23be276b8740b1a8f20b1cf3a2bfbdc97bbccc827cf9abbea`; worker `a6ccd51da4f820d927c42e7ab44898cac66d490b5fce56faca95d77a02e6c4cd`; Hypermail `91760a49be52905779ee1397f210c9b495b7fd48df2c7700aece933327bdebe3`. These local IDs are not published registry digests.

Release remains **NO-GO**: no authorized live provider/send/push/Android run, native Hindsight compatibility or prior-memory recall restore, off-host production-shaped backup/deployment, model-vendor governance or visual review. Required missing prerequisites are the authorized test accounts/devices, dedicated configured Hindsight/offline retained-memory fixture, deployment/storage credentials and vendor approval.
