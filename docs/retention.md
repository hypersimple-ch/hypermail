# Retention and lifecycle cleanup

The worker runs a singleton, replay-safe lifecycle pass. `BODY_RETENTION_DAYS` defaults to 90 and is evaluated from the injected worker clock against `message_bodies.cached_at`; a body cached exactly at the cutoff is eligible only when its authoritative `purge_after` is also due. This prevents an explicitly extended cache lifetime from being shortened accidentally.

Each pass is bounded (100 body rows and 100 subscriptions by default). It deletes only rows in `app.message_bodies`; it never deletes `messages`, attachments metadata, activities, decisions, actions, verifications, notifications/deliveries, audits, or Mastra memory. Each body-cache deletion writes a `message_body_purged` audit event in the same PostgreSQL statement, with identifiers and cutoff only—never body content. The message-to-body foreign key therefore cannot cause a cascade during retention.

Expired Web Push subscriptions are retained but marked `disabled_at`, with a `push_subscription_expired` audit event. Existing notification and delivery history remains referentially valid. Batching uses `FOR UPDATE SKIP LOCKED`, so concurrent/restarted workers safely make progress; the `lifecycle` scheduler lease prevents normal duplicate passes.

Attachment bytes are not application database records. The web entry point completes secure orphan cleanup before it opens the HTTP listener on every restart. It requires the dedicated `ATTACHMENT_TEMP_DIRECTORY` (never shared `/tmp`), considers only old regular `hypermail-attachment-` files, compares identity before unlinking, accepts an injected clock, and removes at most 100 files per invocation. Compose provisions a mode-0700 named volume shared only by web, worker, and Hypermail, forces the common UID/GID 10001, and sets Hypermail `TMPDIR` to that root. The worker reads one bounded file at a time, uploads supported content to Hindsight, and always cleans the provider temp file. Hindsight's retained document then follows the bank lifecycle below. Attachment metadata remains in PostgreSQL.

Lifecycle audit events and returned per-pass counts are the operational signal. No lifecycle task permanently deletes application history.

Completed durable Agent Tasks retain a structurally valid, privacy-minimized result marker: `{ "kind": "redacted" }`. Cleanup replaces action identifiers in the completed Task and its completed replay snapshot in one lifecycle statement. Earlier heartbeat/question snapshots remain immutable. Migration `0012_agent_task_integrity` permits only this exact one-way report redaction; report identity, request digests, timing, and acceptance remain immutable. Replayed completed reports therefore still parse as terminal Tasks without retaining action identifiers.

Mailbox-memory events retain stable UUID/source identity, tenant ownership, content digests, delivery counters/timing, and sanitized result/error metadata. Content required for replay remains in `content_payload` while an event is pending, processing, or deferred, and automatic delivery retries indefinitely with capped backoff. Successful completion atomically sets that duplicate payload to `NULL`; the append-only guard permits no other content rewrite. Attachment bytes are never stored in the event table, audits, or logs. Hindsight bank retention and permanent deletion are separate projection-lifecycle operations; disconnect does not make this canonical outbox disposable.

## Mailbox memory banks

Hindsight has one deterministic memory bank per Mailbox. These operations have different retention effects:

| Operation | Body cache | Hindsight bank | Other application history |
|---|---|---|---|
| Disconnect a Mailbox/manager | Unchanged; normal age rules continue | Preserved; no new retain/recall work is scheduled | Preserved |
| Purge an expired cached body | Deleted from `app.message_bodies` only | Preserved | Preserved |
| Permanently delete a bank | Unchanged | The one mapped bank is explicitly deleted | Preserved; audit records the identifiers and outcome only |

There is no time-based Hindsight bank cleanup. Disconnect and body purge must never call Hindsight deletion. Permanent bank deletion requires an explicit owner/operator request, an exact Mailbox-to-bank lookup, a stopped/paused producer for that Mailbox, and `DELETE /v1/default/banks/{bank_id}` on the private API. It must be idempotent and audited without memory content. The delete removes active Hindsight state. V1 does not create unsafe online filesystem backups of the live embedded Hindsight database. See the [Hindsight operations runbook](runbooks/hindsight.md).
