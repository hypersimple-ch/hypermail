# Hypermail MCP HTTP contract — v0.7.26

**Status:** production parsing and policy-schema probes are aligned with the pinned v0.7.26 package source. The older [`spikes/hypermail-contract`](../../spikes/hypermail-contract/) fixture remains sanitized evidence only and models some collection payloads too loosely; it is **not live validation**. No provider-specific draft or post-mutation acceptance is claimed.

## Authoritative basis and transport

This record is derived from the tagged [v0.7.26 README](https://github.com/hypersimple-ch/hypermail-mcp/blob/v0.7.26/README.md), its tagged [`src/server.ts`](https://github.com/hypersimple-ch/hypermail-mcp/blob/v0.7.26/src/server.ts), and tagged [`src/tools`](https://github.com/hypersimple-ch/hypermail-mcp/tree/v0.7.26/src/tools), plus the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

POST `http://HOST:3000/mcp`, with `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Use JSON-RPC 2.0 lifecycle `initialize`, `notifications/initialized`, `tools/list`, then `tools/call`; retain server-provided `Mcp-Session-Id`. Tool envelope:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_emails","arguments":{"account":"me@example.com"}}}
```

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
