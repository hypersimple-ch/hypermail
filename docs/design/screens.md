# Hypermail screen specifications

**Status:** approved for implementation  
**Design source:** [Lazyweb research data](../../.lazyweb/deep-design-research/report-data/hypermail-greenfield.json) and [prototype](../../.lazyweb/deep-design-research/prototype/index.html).

## Design bets

| Bet | Structural model | Assessment |
|---|---|---|
| A — Inbox-led calm utility | Inbox opens first; Activity is a dedicated tab; agent work appears in the message context. Desktop keeps rail/list/reader. | **Approved.** Familiar email scanning, quieter automation, and the least structural friction for a single user. |
| B — Activity-led operations center | Activity opens first and a persistent agent queue is promoted above mail; Inbox becomes a filtered secondary feed. | Not recommended. Better exception visibility, but makes standard email scanning feel like operations work and competes with the core inbox. |

## Mobile: Inbox

**Purpose:** scan all accounts quickly without a dense, one-line enterprise-list feel.

- Header: “All Accounts”, unread count, search.
- Filter pills: All mail, Unread, Starred.
- Group mail by time; use a stable `TODAY` / `YESTERDAY` label.
- Every mail row has account/avatar, sender, subject, snippet, and time. Rows are 79px minimum and expose swipe triage, but all swipe actions are also visible via the message toolbar/overflow.
- Bottom navigation is always present. Compose FAB is always reachable and does not obscure a tab target.
- At 360px, truncate sender/subject/snippet within the central column; do not shrink the timestamp into unreadable text or allow horizontal scrolling.

## Mobile: Activity

**Purpose:** make agent work, questions, errors, and audit history inspectable without turning the inbox into a task board.

- Filter order: **New**, **Questions**, **Failed**, **History**. New is default.
- Each event has a semantic status marker plus a written title, related message/account, relative time, and one visible next action.
- Blue: informational/new; amber: needs input; red: failed; green: complete. Color never stands alone.
- Failed items always show a recovery path (“Fix”, retry, or account settings); History is read-only but can open original context.

## Mobile: message detail + agent card

**Purpose:** read mail and approve, modify, or reject automation in the same context.

- Back control returns to Inbox; title, sender block, and message body precede automation.
- Inline agent card presents one recommendation, not a stack of opaque agent activity. The card shows agent identity, proposed result, overflow, Edit, and a clear primary action.
- “Agent details” opens a bottom sheet with rationale, affected fields/actions, and controls to dismiss or revise. It is not the only path to act.
- Archive, reply, and overflow remain available outside the card. Announce completed actions and offer Undo where reversal is possible.

## Mobile: Compose

**Purpose:** send an intentional message with low ceremony.

- Header: close/discard path, “New message”, Send.
- Fields: To, Subject, message editor; each has an accessible label.
- Footer: attachment and agent affordances plus a saved status. Do not imply background/offline delivery; report online failure plainly.
- Unsaved close asks for confirmation; draft remains reachable from Drafts.

## Desktop: three-pane shell

**Purpose:** keep navigation and list context while reading and acting.

- **Rail (220px):** brand, Compose, Inbox, Activity, Drafts, Sent, More, account/online indicator.
- **List (385px):** All Accounts header, search, filters, balanced two-line mail rows. Selected row gets pale-blue background and a blue left keyline; this supplements selected state semantics.
- **Reader (remaining width):** toolbar, subject, sender, body, contextual agent action card. The reader content measures no wider than ~850px.
- At widths below 700px, use the mobile screens—not a squeezed three-pane shell.

## Acceptance checks

1. All five required screens are represented in the prototype: Inbox, Activity, message detail with agent card, Compose, and desktop shell.
2. At 360px, document `scrollWidth` equals `clientWidth`; rows truncate instead of overflowing.
3. At desktop width (1440px), rail/list/reader are simultaneously visible.
4. Activity shows all four specified filter names and visible non-color status labels/actions.
5. Reduced-motion CSS disables nonessential animation/transition.
6. Keyboard, focus, contrast, labels, and alternatives to swipe satisfy the system specification before implementation.
