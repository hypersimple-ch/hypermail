# Provider acceptance record

Status: **BLOCKED / NO-GO**

## Automated fixture evidence

The sanitized v0.7.26 fixture contract and production read-client suites pass for Outlook, Gmail, and generic IMAP account projection, MCP lifecycle/session handling, folder and Inbox browse, pagination, search/read, attachment handoff, first-use checkpoint behavior, retry classification, and provider identity isolation.

Live suites now exist at:

- `packages/hypermail/test/live-provider.acceptance.test.ts`
- `packages/send/test/live-approved-send.acceptance.test.ts`

They are fail-closed and disabled unless an operator explicitly supplies the live endpoint/protocol/key, one acceptance account per provider, and opt-in flags. Reversible mutation cases come from an operator-owned JSON file and are restricted to draft/edit, move/archive/recoverable-trash, and read-state tools. The send suite requires a separate explicit flag, test recipient, opaque run ID, and deployed private approved-send endpoint; replay must return the same provider message ID.

## Live matrix

| Capability | Outlook/M365 | Gmail | IMAP | Evidence |
|---|---:|---:|---:|---|
| Onboarding/account projection | BLOCKED | BLOCKED | BLOCKED | No release test accounts or live approved Hypermail service supplied |
| Baseline and later Inbox arrival | BLOCKED | BLOCKED | BLOCKED | Stateful checkpoint run requires isolated test mailboxes and injected arrivals |
| Folders, Inbox, search, read | BLOCKED | BLOCKED | BLOCKED | Live suite ready; fixture-only pass |
| Archive/move/read-state/recoverable trash | BLOCKED | BLOCKED | BLOCKED | Explicit reversible case file and test messages not supplied |
| Draft create/edit | BLOCKED | BLOCKED | BLOCKED | Explicit reversible case file not supplied |
| Approved send and replay dedupe | BLOCKED | BLOCKED | BLOCKED | Private durable send endpoint/test recipient not supplied |
| Attachment stream/cleanup | BLOCKED | BLOCKED | BLOCKED | Live message/attachment fixtures and approved image runtime not supplied |
| Provider degradation/rate/auth errors | BLOCKED | BLOCKED | BLOCKED | Requires controlled live service/account fault window |

## Release blockers discovered

1. `apps/worker/src/index.ts` exports libraries but starts no ingestion, queue consumer, model/policy runner, notification delivery, lifecycle scheduler, or health process. The worker image exits instead of operating.
2. `apps/web/src/server.ts` serves only static PWA assets and liveness. Authentication, onboarding, mailbox, activity, draft/send, attachment, notification, and agent route contracts are not mounted.
3. No concrete Hypermail mutation transport is wired to `PolicyExecutor`.
4. The private approved-send endpoint is a deployment contract, not a service present in this repository or Compose topology.
5. No approved Hypermail v0.7.26 image digest/runtime proof establishes non-root UID/GID 10001, persistent-state path, health path, or shared `TMPDIR` behavior.

Do not connect personal production mailboxes or run mutation/send acceptance until these composition blockers are fixed in a non-production acceptance deployment.
