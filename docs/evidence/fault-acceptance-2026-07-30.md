# Fault acceptance record

Status: **PARTIAL / NO-GO**

Root check passed **176 tests, 11 skipped** without a live environment. Migrated disposable-PostgreSQL serial integration passed, including web draft foreign keys, worker lifecycle, pg-boss consumers, replay, account isolation, pause/verification, health, and shutdown.

## Proven runtime behavior

- Arrival/outbox replay preserves message, Activity, logical-notification, and job identity; reconciliation covers the checkpoint/commit gap.
- Worker queue creation is serialized (parallel pg-boss creation previously deadlocked); consumers and lifecycle scheduler run and recover through the disposable PostgreSQL path.
- Account failures isolate, model failures remain safe, question resume is durable, and pause/verification outcomes remain visible.
- Acceptance fixes covered PostgreSQL optional values, mandatory serial queue creation, and unauthenticated mailbox fanout.

## Remaining release blockers

No production-shaped Compose deployment or approved Hypermail image/protocol acceptance has exercised worker/DB restarts, live mailbox arrival, provider mutation interruption, model/push outage, or public/private network boundaries. The Hypermail draft create/edit response contract remains unverified, so policy readiness is correctly `not_ready`. No approved durable exactly-once send service exists.
