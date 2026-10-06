# Approved send adapter

`IntegratedApprovedSendProvider` is private to the web process. Approval consumption inserts the exact immutable snapshot into `app.approved_send_submissions` in the same transaction. A single committed `pending -> dispatching` CAS precedes the one network attempt; no recovery or reconciliation path resubmits a dispatched approval. This is not an exactly-once delivery guarantee.

The restricted `@hypermail/hypermail/approved-send` transport invokes `send_email` with the approved recipients, body format and reply source, without signatures, forwarding or unapproved attachments. A positive submission acknowledgement is `reported`, not proof of delivery. Native IDs are checked by exact identity in Sent; SMTP RFC Message-IDs are matched only against exposed headers, never used as opaque read IDs. Missing identity/header/date evidence remains `unknown` (`PROVIDER_SENT_ID_UNVERIFIABLE`).

`status(approvalId)` only reads provider state. A process death or timeout during dispatch remains visibly ambiguous, with no retry button. Owner manual reviews are append-only and displayed separately from provider verification. Journal payloads follow configured operational retention; IDs, digest and state survive payload erasure to preserve deduplication.
