# Incident runbook

## First response

1. Preserve the correlation ID, timestamp, service, and fixed metric name/outcome. Do **not** copy request headers, cookies, email bodies/previews, attachment metadata, provider responses, URLs, or secrets into tickets/chat.
2. Confirm worker liveness, readiness, and degradation separately. Liveness means the process runs; readiness names only unavailable dependencies; degradation identifies polling, jobs, autonomous actions, push, backups, or safety pause.
3. Keep the worker and Hypermail private. Only the proxy/web service may be internet exposed. Rotate deployment-store secrets if exposure is suspected.

## Provider or polling failure

- Alert on sustained `poll_cycle:failure` or `unavailable` (three cycles), while successful accounts continue polling.
- Check provider status, deployment-secret presence/expiry, and private Hypermail connectivity; do not log credentials or provider URLs.
- Keep failed account arrivals visible and allow durable retries. After recovery, reconcile recent Inbox listings before declaring the incident resolved.

## Durable job / model failure

- Alert on `job:failure`/`retrying`, queue readiness failure, or sustained queue growth.
- Inspect bounded job counts and worker health, then restart only the affected worker after confirming the durable queue remains available.
- Model/provider failure must leave a failed/retrying activity and bounded retry job. Do not replay a raw payload from logs; use the durable job reference through the application.

## Compromised session or recovery loss

- Immediately revoke all sessions for the user, rotate session and application secrets in the deployment secret store, and review safe auth audit events by correlation ID.
- If the recovery mailbox is unavailable or compromised, disable recovery delivery, preserve the generic recovery response, rotate recovery/session secrets, and restore access through the documented deployment-owner procedure. Never send reset tokens in support channels or logs.

## Verification failure or safety pause

- A mailbox verification failure is not success: leave the activity unresolved and retain the mutation audit record.
- On `safety_pause` or autonomous error rate above 1%, keep autonomous mutations paused for the affected account; polling, persistence, activities, and notifications continue.
- Review verified outcomes and corrections, reverse recoverable mutations where possible, then require explicit operator resume. Record only decision/action identifiers in the audit trail, not content.

## Push delivery failure

- Alert on repeated `push:failure`; retain the persistent in-app badge/queue as the fallback.
- Check VAPID configuration and subscription health only in the secret store/application diagnostics. Do not put endpoint URLs or tokens in logs.

## Backup failure

- Treat `backup:failure` as critical. Confirm the encrypted backup job, destination availability, key access, and most recent successful restore verification.
- Do not disable backup encryption or copy backup keys into shell history. Fix the job, run a new backup, then execute the documented restore verification before closure.

## Closure

Document impact, start/end time, correlation IDs, fixed metric outcomes, remediation, and a follow-up owner. Verify readiness is ready, degradation is empty or accepted, durable retries have drained, and no secret-bearing artifacts entered logs or tickets.
