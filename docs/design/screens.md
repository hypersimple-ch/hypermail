# Hypermail screen specifications

**Status:** approved for implementation

## Design bet

**Inbox-led calm utility — approved.** Inbox opens first; Activity is a dedicated view; agent work appears in message context. The product remains a quiet, familiar single-user mail utility, not an operations dashboard or feature-complete mail client.

## Mobile: Inbox (<700px)

**Purpose:** scan all accounts quickly without a dense enterprise-list feel.

- Header: “All Accounts” and unread count. Show search only when it is API-backed.
- Show only API-backed filters. Do not promise starred, archive, read/unread, folder, or search behavior when unavailable.
- Group mail by time with stable `TODAY` / `YESTERDAY` labels where data supports it.
- Each row has account/avatar, sender, subject, snippet, and time. Rows are 79px minimum. Sender, subject, and snippet truncate within the central column; timestamp remains readable; the document never scrolls horizontally at 360px.
- Bottom navigation remains present. Compose FAB remains reachable without obscuring a tab target.
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
- Inline agent card presents one recommendation, not a stack of opaque activity. It shows agent identity, proposed result, state, and supported revise/reject/approval controls.
- Agent suggestions never send casually. A send requires explicit user approval at the point of sending.
- “Agent details,” when available, opens an accessible bottom sheet with rationale and affected actions; it has visible close control, focus containment, and Escape/back dismissal.
- Do not show archive, reply, or other message actions unless the API supports them. Unsupported actions are absent or honestly disabled, never enabled no-ops.

## Mobile: Compose and authentication

**Purpose:** compose or authenticate with low ceremony and stable layout.

- Compose header has close/discard path, “New message,” and explicit Send approval.
- Fields are labeled To, Subject, and message editor. Show only supported attachment or agent affordances.
- Footer shows saved, pending, error, or conflict state clearly. Do not imply background/offline delivery; report online failure plainly.
- Unsaved close asks for confirmation; saved drafts remain reachable from Drafts.
- Authentication is compact and viewport-stable, with clear loading, error, and retry/next-step feedback.

## Settings and Account

**Purpose:** let the single owner manage mailbox onboarding and their current session without turning More into a fifth mobile tab.

- **More** is a hub that links to Settings and Account. Mobile navigation keeps its four tabs; Settings and Account are pushed full-page screens and remain usable without horizontal scrolling at 360px. On desktop they use the full area after the rail, not the Inbox list column.
- **Settings** lists projected mailboxes and offers explicit owner-initiated Gmail, Outlook, and IMAP onboarding. Gmail shows the OAuth handoff and a written pending, ready, expired, or error state. Outlook shows the device code and an explicit status-check action; it does not imply background completion. IMAP uses a labeled credential form and reports synchronous completion or failure.
- **Account** shows the owner email as read-only, provides a current-password-verified password rotation form, and exposes sign out. Do not offer owner-email editing, account deletion, mailbox removal, or unimplemented preferences.
- Forms use the repository’s calm HeroUI-backed components and Tailwind v4 utilities. Every interactive control has a 44px minimum target, visible focus, associated labels/errors, keyboard operation, and written status in addition to color. OAuth/device-code handoffs, pending states, and errors must give a clear next step and expose changing status through an appropriate live region.

## Desktop: shell (>=700px)

**Purpose:** retain navigation and context without squeezing non-Inbox work into a message-list column.

- **Rail (220px):** brand, Compose, Inbox, Activity, Drafts, Sent, More, account/online indicator.
- **Inbox:** a 385px list with All Accounts header and only API-backed filters; remaining width is the reader. Selected rows use neutral off-white fill and a charcoal keyline/indicator, plus semantic selected state.
- **Reader:** toolbar and actions only where supported, then subject, sender, body, and contextual agent card. Reader content measures no wider than ~850px.
- **Compose, Activity, Drafts, Sent, More, Settings, and Account:** use the full area after the 220px rail, with their content sized for readability rather than constrained to 385px.
- **Drafts:** distinct editable saved-message projection. **Sent:** distinct read-only sent-message projection.
- Below 700px, use the mobile screens—not a squeezed desktop shell.

## Acceptance checks

1. Inbox, Activity, message detail with agent card, Compose, authentication, More, Settings, Account, Drafts, Sent, and desktop shell follow this contract.
2. At 360px, `scrollWidth` equals `clientWidth`; essential Compose/auth controls remain visible and usable.
3. At 1440px, Inbox shows rail/list/reader; non-Inbox desktop screens use all remaining space after the 220px rail.
4. Activity shows all four specified filter names, visible non-color status labels, and pending/error/conflict feedback.
5. No unsupported behavior is promised or presented as an enabled control; no enabled control is a no-op.
6. Send remains explicitly user-approved. Settings and Account show written/live onboarding and form states; reduced motion, keyboard, focus, contrast, labels, and 44px touch-target requirements satisfy the system specification.
7. Current React surfaces use the shared components in `apps/web/src/components/` and Tailwind utilities; no feature imports a legacy component stylesheet or styles a raw button, input, textarea, or select.
8. The production build emits the complete Tailwind bundle at `/app.css`, and the static shell references no parallel PWA stylesheet.
