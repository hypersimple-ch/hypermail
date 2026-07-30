# Security acceptance record

Status: **PARTIAL / NO-GO**

Root check passed **176 tests, 11 skipped** without a live environment. Runtime web/worker image builds and relevant security contracts passed. Dependency/container scan reports **one low and one moderate finding; no high or critical findings**.

## Proven controls

- Web runtime enforces its production environment, liveness, request/response protections, and graceful shutdown.
- Worker runtime composes private PostgreSQL/pg-boss, Hypermail, model, notification, policy, scheduler, health, replay/isolation, and shutdown paths.
- Auth/CSRF/account scope, attachment isolation, prompt/tool boundaries, restricted policy capabilities, redaction, and proxy-only Compose topology remain covered by tests.

## Remaining release blockers

There is no approved deployed Hypermail/provider validation, production-shaped Compose deployment, public-network/off-host restore probe, or approved private durable exactly-once send service. Android and live provider acceptance remain unrun. Dedicated secret/SAST/IaC scanning and model-vendor terms/controls still need release-owner approval.
