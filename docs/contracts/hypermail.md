# Hypermail MCP HTTP contract — v0.7.26

**Status:** production parsing and policy-schema probes are aligned with the pinned v0.7.26 package source. The older [`spikes/hypermail-contract`](../../spikes/hypermail-contract/) fixture remains sanitized evidence only and models some collection payloads too loosely; it is **not live validation**. No provider-specific draft or post-mutation acceptance is claimed.

## Authoritative basis and transport

This record is derived from the tagged [v0.7.26 README](https://github.com/hypersimple-ch/hypermail-mcp/blob/v0.7.26/README.md), its tagged [`src/server.ts`](https://github.com/hypersimple-ch/hypermail-mcp/blob/v0.7.26/src/server.ts), and tagged [`src/tools`](https://github.com/hypersimple-ch/hypermail-mcp/tree/v0.7.26/src/tools), plus the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

POST `http://HOST:3000/mcp`, with `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Use JSON-RPC 2.0 lifecycle `initialize`, `notifications/initialized`, `tools/list`, then `tools/call`; retain server-provided `Mcp-Session-Id`. Tool envelope:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_emails","arguments":{"account":"me@example.com"}}}
```

Tenant acquisition completes this initialization before returning a lease. Onboarding uses the initialized lease directly; it must not repeat `initialize` on the same session. Every operation releases its lease in `finally`, including provider failures. The shared development client has its own initialization barrier.

**Local protocol proof:** on 2026-07-31, the local Compose acceptance run initialized the pinned v0.7.26 image with `protocolVersion=2025-11-25`; worker readiness reported only the pre-existing policy blocker, not Hypermail. This proves the local protocol literal and initialization path, but not live provider tools, session/SSE edge cases, mutation responses, or production deployment. Keep those contract release blockers until the full live matrix passes.

## Exact tool payloads and policy

Classification is local safety policy, not a claim that Hypermail enforces it. `forbidden` explicitly prevents autonomous **send, forward, permanent delete, account administration, and folder administration**.

| Tool | Exact arguments (optional `?`) | Policy |
|---|---|---|
| `list_accounts` | `{}` | read-only |
| `add_account` | `{provider:"gmail"|"outlook"|"imap",email?:string,config?:object}` | forbidden (account admin) |
| `complete_add_account` | `{provider,handle:string,authorizationResponse?:string,code?:string,state?:string}` | forbidden (account admin) |
| `get_account_settings` | `{account:string}` | read-only |
| `set_account_settings` | `{account:string,signature?:string,signaturePath?:string,style?:{fontFamily?:string,fontSize?:string,fontColor?:string}}` (`signature`/`signaturePath` exclusive) | forbidden (account admin) |
| `remove_account` | `{email:string}` | forbidden (account admin) |
| `list_emails` | `{account:string,folder?:string,limit?:positive integer ≤100,unreadOnly?:boolean,skip?:integer}` | read-only |
| `search_emails` | `{account?:string,query?:string,from?:string,to?:string,cc?:string,limit?:positive integer ≤100}`; at least one criterion | read-only |
| `read_email` | `{account:string,id:string,format?:"markdown"|"html"|"text"}` | read-only |
| `read_attachment` | `{account:string,messageId:string,attachmentId:string}` | read-only |
| `get_new_emails` | `{account?:string,limit?:integer ≥0}` | autonomous-policy-eligible |
| `list_folders` | `{account:string,parentFolderId?:string}` | read-only |
| `create_folder` | `{account:string,displayName:string,parentFolderId?:string}` | forbidden (folder admin) |
| `delete_folder` | `{account:string,folderId:string}` | forbidden (folder admin) |
| `rename_folder` | `{account:string,folderId:string,newName:string}` | forbidden (folder admin) |
| `draft_email` / `send_email` | `{account,to:[{address,name?}],cc?,bcc?,subject,body,format:"html"|"markdown",include_signature:boolean,inReplyTo:string|false,replyAll?,forwardMessageId?,attachments?:[{filePath,name?}]}`; `to`, `subject`, `body`, `format`, and `include_signature` are advertised as required; the runtime handler also expects `inReplyTo`, while v0.7.26 `tools/list` omits it from `required` because of its preprocess schema; production callers always provide it; reply/forward are exclusive | user-approved-only / forbidden (send and forward) |
| `edit_draft` | `{account,id,to?,cc?,bcc?,subject?,old_text?,new_text?,body?,format?,include_signature?,new_attachments?,remove_attachments?}`; replacement requires `old_text` and exactly one replacement field | user-approved-only |
| `send_draft` | `{account:string,id:string}` | forbidden (send) |
| `move_email` | `{account:string,id:string,destination:"archive"|"deleteditems"|"inbox"|"drafts"|"junkemail"|"sentitems"|"outbox"|folderId}` | user-approved-only |
| `archive_email`, `trash_email`, `mark_read`, `mark_unread` | `{account:string,id:string}` | user-approved-only, user-approved-only, autonomous-policy-eligible, user-approved-only |

`read_attachment` returns temporary local-file metadata (`name`, optional `contentType`, `path`, optional web URL/reason); it is **not** a documented byte-streaming API. `trash_email` must never be treated as permanent delete; no autonomous permanent-delete operation is allowed.

## Production policy adapter

The production client unwraps MCP `structuredContent`, validates the advertised restricted tool schemas, and parses `list_emails`, `search_emails`, and `list_folders` using the v0.7.26 `items` collections. `read_email` does not return an account field, so the caller-supplied account is retained as the isolation scope.

Draft policy actions load recipients, subject, body, `body_format`, and optional reply identity from the durable application draft, pass that exact format to `draft_email` or exact-text `edit_draft`, retain the returned post-operation provider draft ID, and verify that the returned draft remains readable. Agent/MCP-created application drafts explicitly use `markdown`. For exact edit selection, prior `markdown` revisions are rendered with `renderDraftMarkdown`; prior `html` revisions are compared unchanged. If a unique prefix selection cannot be proven, the edit fails closed rather than replacing quoted reply/forward history. Neither policy client nor autonomous transport exposes send, forward, or administration tools.

Runtime schema readiness is not provider acceptance. Mutation results are strictly parsed and returned post-operation IDs are retained before verification. Archive, recoverable-trash, and move verification list the actual destination and require the retained ID to be present. Outlook/IMAP may change IDs after a move; Gmail archive state is not uniformly observable through `read_email.folder` or an Archive label, so that case remains `unverifiable` rather than fabricating a universal folder fact. If a draft may have been created but its provider ID was not retained, later distinct create attempts fail closed to prevent duplicates; operator reconciliation is then required.

## Integrated owner-approved send

The web-only `@hypermail/hypermail/approved-send` subpath is distinct from public MCP, agent, conversation and policy transports. It uses an already consumed owner approval and the private-process journal in `packages/send`; no external send endpoint/token is configured. `send_email` receives exactly the approved recipients/subject/body/format, `include_signature:false`, the scoped provider reply ID or `inReplyTo:false`, and `replyAll:false`, without attachments or forwarding.

One journal CAS is committed before one network invocation. `sent:true` is a submission acknowledgement only: Gmail returns a native ID, Graph may return an empty ID, and IMAP returns an SMTP RFC Message-ID even if the later Sent append fails. Empty references remain unknown. Native identity is located in the provider well-known `sentitems` folder with at most50 pages of100, then read by exact ID with message-date evidence. The pinned tool output does not expose RFC Message-ID headers or exact header search, so SMTP references explicitly remain `PROVIDER_SENT_ID_UNVERIFIABLE`; they are never passed to `read_email` as folder/UID IDs.

`POST /api/v1/drafts/:id/reconcile` and `/api/v1/send-requests/:id/reconcile` take `{approvalId,expectedVersion}` and never submit mail. Their `manual-send-review` counterparts additionally take `{outcome:'observed_sent'|'not_observed',note}` (max2000 characters). A manual review is append-only owner testimony, not a provider result, and never causes a submission. Draft/read/request APIs expose `submission` state, reason, `dispatchMayHaveOccurred` and latest manual review. The5-minute recent-auth fence and live-session check serialize approval consumption against password reset; edits invalidate approval versions. Restarted dispatches remain ambiguous without retry.

A crash after confirmation commits but before the dispatch CAS leaves the journal `pending`, which proves no provider attempt occurred. Reconciliation leaves a still-valid approval pending; after its original expiry, it atomically rejects only that undispatched row with `APPROVAL_EXPIRED_UNDISPATCHED`, preserving `started_at=NULL` and exposing `dispatchMayHaveOccurred:false`. The migration guard requires a consumed, expired original approval for this transition. A competing delayed submission loses the pending CAS and cannot call the provider. The ordinary draft becomes failed/editable at a new version; an agent send request, its action and run settle failed together. The owner may explicitly prepare a new approval/version where allowed, but the old approval remains consumed. `dispatching`, `reported` and `unknown` are never treated as proven undispatched, regardless of approval expiry, and are never resent by reconciliation.

## Owner Inbox and full-message reads

`GET /api/v1/inbox?accountId=<uuid>&limit=50&cursor=<opaque>` reads the provider's role-resolved Inbox, not all projected mail. It returns `{messages,nextCursor}`; the signed cursor binds version, owner, mailbox, provider folder and provider listing position, expires after 15 minutes and uses a dedicated HMAC derivation from the session secret. Refresh starts at page one. Provider changes can shift pages; the browser merges by message ID rather than claiming snapshot consistency. No unread total is inferred from a partial page.

Pages only upsert message/folder/attachment projections. They never establish a baseline, create Activity/jobs or retain email in memory. Existing baseline flags survive read projection updates. An owner read before the next poll does not consume the later arrival: arrival deduplication is the unique message Activity, not whether its projection was inserted.

`GET /api/v1/messages/:id` checks owner scope before provider I/O. A missing or expired full-body cache is filled by `read_email`; cache entries expire after 24 hours. HTML is sanitized with scripts, event handlers and all image tags removed, so remote images are never fetched. Attachments retain scoped application IDs. A provider missing-message result returns 404; outages return retryable 503. Neither stale previews nor an empty preview are presented as a fetched body, and reads never implicitly mark mail read. Reply quotation uses this same full-body path. IMAP passwords are nonempty strings passed verbatim, including leading/trailing spaces.

Policy readback uses `locateMessageInFolder`, returning `present`, `absent`, or `incomplete`. `absent` requires provider `hasMore=false`; reaching the 50-page/100-item bound or the bounded timeout is `incomplete`. `locateMessageInFolderPage` also returns a resumable provider cursor for durable worker recovery, without another mutation. Folder identity is provider-derived; an Archive label is not invented for Gmail.

## Owner onboarding boundary

`add_account` and `complete_add_account` are pinned to v0.7.26 and are account-administration operations. Hypermail makes no ownership decision: the authenticated, exact-same-origin web service is the sole owner-facing caller, and autonomous worker, agent, and policy ports do not expose either tool. Credentials and provider state remain Hypermail private state.

The owner-facing contract uses `pending`, `ready`, `expired`, and `error` outcomes. A mailbox is projected into application `app.accounts` and `app.user_accounts` only after `ready`; incompatible ownership fails closed. Map Hypermail provider `outlook` to application provider `microsoft`. A newly ready mailbox is baselined on its next worker ingestion cycle, so previously existing mail does not create Activity.

- **Gmail:** `add_account` begins the OAuth URL flow. Completion consumes the redirect authorization response/code/state through the app's same-origin `/oauth/gmail/callback`. The browser retains only opaque provider, handle, and expiry values in `sessionStorage`, and removes callback query parameters after handling them.
- **Outlook:** `add_account` starts device-code onboarding. It remains pending until the owner explicitly requests a status/complete check; the web app does not advance it by background polling.
- **IMAP:** configuration is submitted to the private owner-only web API and completes synchronously as ready or error. The web app must never persist, log, or echo IMAP credentials.

Mailbox removal is not part of the owner-facing contract.

## Semantics, identities, and provider differences

`list_accounts` returns provider identity (`outlook`, `gmail`, `imap`) and public account metadata. Treat `(account email, provider, message ID)` as provider-scoped identifiers: do not infer cross-provider ID portability. `list_emails` defaults to Inbox and reports `hasMore`; advance with `skip`. `get_new_emails` is Inbox-only, does not mark messages read, establishes its first-use checkpoint at newest Inbox mail and returns no mail initially, then returns unseen mail oldest-first. `limit:0` initializes/checks without bodies; all-account limits are global and partial failures are returned in `errors`.

| Provider | Documented difference | Unpublished/blocked |
|---|---|---|
| Outlook/M365 | device-code onboarding; Graph folders support well-known names/IDs/localized fallback; move may refresh ID/link and fall back to OWA | per-tool support matrix, limits |
| Gmail | OAuth URL then redirect/code/state completion; web URL is best-effort unofficial | per-tool support matrix, scopes, limits |
| IMAP | synchronous host/user/password configuration; no universal webmail URL, so return unavailable reason | `config` keys/auth mechanisms, per-tool support, limits |

The server documents common tools but **does not publish a provider-by-tool capability matrix**. Do not encode availability beyond these documented differences; validate each provider against live tagged service.

## Fixture proof and execution

`src/client.ts` is a minimal typed Streamable-HTTP JSON-RPC client. `fixtures/hypermail-v0.7.26.ts` runs controlled localhost HTTP JSON-RPC responses for sanitized accounts, Inbox pagination, checkpoint behavior, folders/search/message/attachment metadata, and write-tool payload acknowledgements. Tests cover lifecycle/session headers, identities and IDs, pagination, checkpoint behavior, policy, provider differences, HTTP 503 retryability, retryable JSON-RPC error, and malformed JSON.

```sh
cd spikes/hypermail-contract
npm run check
```

The production live suite is gated separately. With explicit reversible-mutation authorization, it creates, reads, and exact-edits one self-addressed unsent draft per configured provider and verifies the returned post-operation IDs:

```sh
HYPERMAIL_LIVE_ACCEPTANCE=1 HYPERMAIL_LIVE_MUTATION_ACCEPTANCE=1 \
HYPERMAIL_ACCEPTANCE_RUN_ID=<opaque-run-id> pnpm vitest run packages/hypermail/test/live-provider.acceptance.test.ts
```

It additionally requires the private endpoint/key/protocol and isolated Outlook, Gmail, and IMAP account environment variables described by the test.

A passing result proves only client/fixture compatibility. The local pinned-image run additionally proves `2025-11-25` initialization. Remaining live-contract blockers: production endpoint/configuration and credentials; live SSE edge cases; actual `tools/list` schemas; provider-by-tool support; IMAP config; OAuth scopes; rate/attachment limits; and live error-code retry semantics.
