# Hypermail screen specifications

**Status:** implemented; automated behavior and responsive checks accompany the current surfaces

## Design bet

**Inbox-led calm utility — approved.** Inbox opens first; Activity is a dedicated view; agent work appears in message context. The product remains a quiet, familiar single-user mail utility, not an operations dashboard or feature-complete mail client.

## Mobile: Inbox (<700px)

**Purpose:** scan all accounts quickly without a dense enterprise-list feel.

- Header: “All Accounts” and unread count. Show search only when it is API-backed.
- Show only API-backed filters. Do not promise starred, archive, read/unread, folder, or search behavior when unavailable.
- Group mail by time with stable `TODAY` / `YESTERDAY` labels where data supports it.
- Each row has account/avatar, sender, subject, snippet, and time. Rows are 79px minimum. Sender, subject, and snippet truncate within the central column; timestamp remains readable; the document never scrolls horizontally at 360px.
- Sticky mobile header contains the brand, labeled Compose action, and owner-avatar menu. The 66px bottom bar plus safe-area inset exposes Inbox, Drafts, Sent, Approvals, and Activity. Assistant is the only FAB; content scroll padding clears both floating action and tabs.
- Any control that is unsupported is omitted or disabled with a clear reason. No enabled control is a no-op.

## Mobile: Activity

**Purpose:** make agent work, questions, errors, and audit history inspectable without turning Inbox into a task board.

- Filter order: **New**, **Questions**, **Failed**, **History**. New is default.
- Each event has a written status, related message/account, relative time, and one visible supported next action.
- Use neutral styling for ordinary/new items. Green means completed, amber needs input, and red failed; color never stands alone.
- Pending work, errors, and conflicts are visible with an explanation and available next step. Failed items show a supported recovery path; History is read-only but may open original context when supported.

## Mobile: message detail and agent card

**Purpose:** read mail and approve, modify, or reject automation in the same context.

- Back control returns to Inbox; title, sender block, and message body precede automation.
- Proposal cards present each action independently, with immutable target/content, estimated confidence and threshold, reason, inspectable evidence, dependencies and written execution state. Approve, Reject and structured Correct operate on one proposal, never the entire mail plan. Only the submitted card becomes pending; a conflict preserves edits and requires explicit reload and inspection.
- Agent suggestions never send casually. A send requires explicit user approval at the point of sending.
- “Agent details,” when available, opens an accessible bottom sheet with rationale and affected actions; it has visible close control, focus containment, and Escape/back dismissal.
- Do not show archive, reply, or other message actions unless the API supports them. Unsupported actions are absent or honestly disabled, never enabled no-ops.
- “Discuss this mail” opens the centered Assistant over the current reader and attaches that exact message as next-new-chat context without clearing the current conversation or unsent text. Explicit New chat creates a scoped conversation; opening or minimizing never creates one.
- Assistant labels mailbox versus explicitly global scope, distinguishes owner and assistant messages, and shows pending/failed turns with retry of the original request identity. Conflict preserves typed text and requires reload; no automatic resubmission. Global chat never implicitly reads mailbox email.
- A single state-owning Assistant remains mounted across mail navigation and minimization, including pending-response polling. A blurred/dimmed backdrop, focus containment, Escape/backdrop dismissal, visible Minimize control, and restored launcher focus come from the HeroUI modal. History starts collapsed; transcript scrolls independently of composer and header.
- `/chat` and `/chat/{id}` open Assistant over Inbox on direct entry. In-app opening preserves the exact background URL/screen; Back minimizes and Forward reopens without resetting chat. Conversation changes replace the Assistant history entry; completion while minimized cannot reopen it or change the background URL. Motion is optional and respects reduced motion.

## Mobile: Compose and authentication

**Purpose:** compose or authenticate with low ceremony and stable layout.

- Compose header has close/discard path, “New message,” and explicit Send approval.
- Fields are labeled To, Subject, and message editor. The message editor provides font family and size, bold, italic, underline, strikethrough, lists, quotes, alignment, and undo/redo. Its toolbar scrolls within the editor on narrow screens instead of widening the document. Show only supported attachment or agent affordances.
- Footer shows saved, pending, error, or conflict state clearly. Do not imply background/offline delivery; report online failure plainly.
- Unsaved close asks for confirmation; saved drafts remain reachable from Drafts.
- Compose preserves unsaved To/Cc/Bcc, subject and body through save failures and version conflicts; sending stays disabled until the saved snapshot matches the editor. Reloading for comparison must not silently overwrite the owner’s edits.
- Send preparation displays the server’s exact mailbox, every recipient (including Bcc), subject, body and format. HTML snapshots are shown as literal text, not executable markup. Confirmation is a separate explicit action bound to that snapshot and approval expiry.
- A fresh-auth challenge preserves the send intention, asks for the current password, then prepares a new approval and displays the new snapshot. Authentication never automatically confirms either the old or new approval.
- **Approvals** is a direct destination. Its neutral badge counts only known `pending_owner_approval` requests across authorized mailboxes; loading/error/unavailable review suppresses the badge. Awaiting approval precedes Sending outcomes, which retains rejected requests, reported submissions and unknown outcomes. Refresh failures retain the last-loaded cards. “Verify provider outcome” is read-only, never a retry send.
- Manual observations are separate append-only reviews: “verified by you” is not provider proof, and “not observed” is not evidence of non-submission. No resend control is offered for an ambiguous submission.
- Authentication is compact and viewport-stable, with clear loading, error, and retry/next-step feedback.

## Mailboxes & agents and Account & security

**Purpose:** separate connected-mailbox automation from the private owner's identity and current session.

- The owner-avatar menu opens **Mailboxes & agents**, **Account & security**, and Sign out. Desktop shows the truncated email and written Online/Offline state; the menu repeats the full wrapping email with Private owner context. Navigation closes the menu; pending sign-out is guarded against duplicates and failure allows retry.
- **Mailboxes & agents** lists projected mailboxes and offers explicit owner-initiated Gmail, Outlook, and IMAP onboarding. Gmail shows the OAuth handoff and a written pending, ready, expired, or error state. Outlook shows the device code and an explicit status-check action; it does not imply background completion. IMAP uses a labeled credential form and reports synchronous completion or failure.
- **Account & security** shows the owner email as read-only, provides a current-password-verified password rotation form, and retains sign out. Both pages return to Inbox. Do not offer owner-email editing, account deletion, mailbox removal, or unimplemented preferences.
- Forms use the repository’s calm HeroUI-backed components and Tailwind v4 utilities. Every interactive control has a 44px minimum target, visible focus, associated labels/errors, keyboard operation, and written status in addition to color. OAuth/device-code handoffs, pending states, and errors must give a clear next step and expose changing status through an appropriate live region.

## Desktop: shell (>=700px)

**Purpose:** retain navigation and context without squeezing non-Inbox work into a message-list column.

- **Rail (240px, 16px padding):** compact brand, full-width 44px charcoal Compose, Inbox, Drafts, Sent, then separated Approvals and Activity, and owner menu footer. Selected destinations use neutral fill, stronger text and `aria-current`.
- **Inbox:** at 700–1023px, show list or selected reader, not both. At >=1024px, a 360px list precedes the remaining-width reader. One mounted instance of each uses responsive visibility. Mail surfaces are white with 1px dividers.
- **Reader:** toolbar and actions only where supported, then subject, sender, body, and contextual agent card. Reader content measures no wider than ~850px.
- **Compose, Activity, Drafts, Sent, Approvals, Mailboxes & agents, and Account & security:** mount once and use the full area after the rail, sized for readability. The Assistant modal never changes the underlying reader geometry.
- **Drafts:** distinct editable saved-message projection. **Sent:** distinct read-only sent-message projection.
- Below 700px, use the mobile screens—not a squeezed desktop shell.

## Acceptance checks

1. Inbox, Activity, message detail with agent card, Compose, authentication, Approvals, owner settings/security, Drafts, Sent, Assistant, and desktop shell follow this contract.
2. At 360px, `scrollWidth` equals `clientWidth`; essential Compose/auth controls remain visible and usable.
3. At 700px only one mail pane is visible; at 1024px and above Inbox shows rail/list/reader. Other desktop screens use all remaining space after the 240px rail.
4. Activity shows all four specified filter names, visible non-color status labels, and pending/error/conflict feedback.
5. No unsupported behavior is promised or presented as an enabled control; no enabled control is a no-op.
6. Send remains explicitly user-approved. Settings and Account show written/live onboarding and form states; reduced motion, keyboard, focus, contrast, labels, and 44px touch-target requirements satisfy the system specification.
7. Current React surfaces use the shared components in `apps/web/src/components/` and Tailwind utilities; no feature imports a legacy component stylesheet or styles a raw button, input, textarea, or select.
8. The production build emits the complete Tailwind bundle at `/app.css`, and the static shell references no parallel PWA stylesheet.
9. Automated Chromium checks cover 360, 700, 1024, 1440, and 1800px plus 20px mobile text: overlay containment/centering, FAB/utility clearance, five tabs, full-width Compose, focus/escape, reduced motion, draft persistence, history return, and approval count transitions. Human aesthetic review remains separate.
