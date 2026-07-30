# Deployed end-to-end fault drill

Status: **CREATED, EXECUTION BLOCKED**

Run only in isolated acceptance accounts and infrastructure. Use the exact proposed image digests. Never inject these faults into personal/production mailboxes. Test-only proxies/fakes must be outside production images and must emit no message content or identities.

## Preconditions

- Web, worker, PostgreSQL, pg-boss, approved Hypermail image, private approved-send endpoint, model stub, push stub, and TLS proxy are running with production network boundaries.
- One isolated account per Outlook/M365, Gmail, and IMAP is baselined.
- Toxiproxy (or equivalent) can interrupt worker→PostgreSQL, worker→Hypermail, worker→model, and worker→push paths without exposing them publicly.
- A read-only acceptance SQL role can inspect counts/states by opaque test correlation IDs.
- Global autonomy starts paused; individual mutation tests explicitly unpause only their isolated account.

## Drills and assertions

### 1. Duplicate arrival and checkpoint gap

1. Inject one uniquely correlated Inbox message.
2. Allow Hypermail `get_new_emails` to advance, then cut worker→PostgreSQL before the arrival transaction commits; kill the worker.
3. Restore PostgreSQL connectivity and restart worker. Allow recent-Inbox reconciliation and two poll cycles.
4. Assert exactly one `messages` row by provider identity, one Activity, one logical notification, one domain agent job, and no baseline flag. Assert agent processing starts only after those rows commit.

### 2. Queue dispatch and consumer replay

1. Inject an arrival; stop pg-boss delivery after domain commit but before `queue_job_id` is recorded.
2. Restart worker twice and restore queue delivery.
3. Assert one deterministic queue singleton, one canonical decision/question, and no duplicate Activity/notification.
4. Kill worker after consumer claim and before completion; restart and assert safe replay/resume rather than duplicate model/provider mutation.

### 3. PostgreSQL restart

1. Restart PostgreSQL during an arrival transaction and during question-answer persistence in separate runs.
2. Assert readiness becomes unavailable without process secrecy leaks, then recovers.
3. Assert transaction rollback/retry preserves one arrival and one answer audit; unanswered state cannot acknowledge.

### 4. Model and push outages

1. Return malformed model output, timeout, and HTTP 503 on separate correlated arrivals.
2. Assert unresolved failed/retrying Activity, bounded durable retry, no policy mutation, and safe logs.
3. Return push 503 until max attempts, then recovery; separately return 404/410.
4. Assert bounded attempts, one logical notification, persistent in-app badge/queue, and stale subscription disablement without endpoint disclosure.

### 5. Question suspend/resume

1. Force a structured question, kill worker, answer once through authenticated exact-origin HTTP, replay the same answer, then restart worker.
2. Assert one answer/audit, resumed durable workflow snapshot, account-scoped memory source history, and acknowledgement blocked until resolution.

### 6. Mutation ambiguity and verification

1. For an allowlisted test message, interrupt the provider response after mutation may have applied.
2. Assert no blind retry. On restart, verify provider state and record `succeeded`, `failed`, or `unverifiable` accurately.
3. Force a canonical mismatch after provider success; assert `incorrect`, visible failed Activity, and audit. Never use send/permanent delete/account/folder admin.

### 7. Pause race and exact safety threshold

1. Race user pause against a claimed action immediately before provider I/O; assert no mutation after pause commits.
2. In independent windows, record 0/100, 1/101, and 1/100 verified incorrect archive/move/trash outcomes.
3. Assert only 1/100 (exactly 1%) crosses the configured inclusive threshold, atomically pauses that account, and creates one distinct safety Activity/logical notification/alert. Other accounts continue polling.

### 8. Lifecycle and backup degradation

1. Kill worker after a lifecycle batch and before the next lease renewal; start a second worker.
2. Assert lease handoff, replay-safe bounded body purge, retained history/FKs, and disabled-not-deleted expired push records.
3. Force backup destination failure and assert non-zero job, structured sanitized failure, freshness alert, and no partial generation accepted.

## Required artifacts

Record immutable image digests, UTC timestamps, opaque correlations, sanitized fixed metrics, row-count/state assertions, fault timing, Android-visible fallback state, and operator/result. Never record account addresses, sender/subject/body, endpoints, tokens, provider payloads, attachment names, or keys.

Execution cannot begin until the web/worker compositions, queue consumers, provider mutation adapter, approved-send endpoint, approved Hypermail image, acceptance accounts, and fault-control infrastructure exist.
