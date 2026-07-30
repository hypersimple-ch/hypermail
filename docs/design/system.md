# Hypermail design system

**Status:** approved for implementation  
**Scope:** private, single-user, Android-first, online-only email PWA.

## Direction

Use the recommended **Inbox-led calm utility** direction. The inbox is the familiar default; Activity is a separate, intentional queue for agent work and exceptions. Automation is visible in context, never a persistent competing dashboard.

## Foundations

- **Theme:** light only. `#FFFFFF` surfaces on `#F6F7F7` ground; fine `#DFE3E6` borders; no elevation except the Compose FAB's minimal 2px shadow.
- **Type:** system UI stack. Message sender and selected titles use 700; subjects use 500; snippets and metadata use 400. Never rely on weight alone to convey status.
- **Shape:** 8px controls, 12px cards, 999px filters. Avoid large rounded containers.
- **Spacing:** 4px base; row padding 12px mobile / 13px desktop; 8px control gaps; 14–18px screen gutters.
- **Motion:** no essential animation. Respect `prefers-reduced-motion: reduce` by removing transitions and animation.

## Semantic color

| Token | Value | Meaning | Required non-color cue |
|---|---:|---|---|
| Ink | `#20242A` | primary text | — |
| Muted | `#69727D` | secondary text | hierarchy/position |
| Blue | `#1769AA` | selected, primary action, informational agent work | selected fill, label or icon |
| Green | `#217A4F` | completed/success | completed wording/check |
| Amber | `#986500` | needs review/question | explicit status label |
| Red | `#B3261E` | failed/error | error wording and recovery action |

Use these colors only on white or their very pale semantic surface. Body-size text must meet WCAG AA (4.5:1); semantic state always also has text, icon, or placement.

## Core components

### App navigation

**Mobile (360px):** fixed 4-item tab bar: Inbox, Activity, Drafts, More. Activity can carry a numeric badge. The Compose FAB sits above/right of the bar and always has an accessible “Compose” name.

**Desktop (>=700px):** fixed left rail with Compose and destinations; center message list; right reader. Do not collapse the reader into a fourth pane.

### Message row

A balanced two-line row is 79px minimum on mobile: 28px account/avatar, sender, subject, one-line snippet, timestamp. Sender and subject truncate, never force horizontal scrolling. Unread status is supported by weight **and** an unread count/filter; do not use blue text as its only signal.

### Filters

Use compact, horizontally scrollable pills. Active state uses pale blue fill, blue label, and border. Activity filter order is fixed: **New, Questions, Failed, History**.

### Agent action card

Place an agent card immediately after the message content it concerns. It contains: agent label/icon, concise state, suggested action/content, overflow menu, and visible secondary/primary action. Primary example: “Send reply”; secondary: “Edit”. On mobile, “Agent details” opens a bottom sheet; it must have a visible drag/close affordance, focus containment, Escape/back dismissal, and a non-swipe close control.

### Swipe triage

Swipe is additive, not discoverability-critical. A row exposes Archive on left swipe and Mark unread on right swipe after a deliberate threshold; announce the result and offer Undo. The same operations remain in the message overflow menu and desktop reader toolbar.

### Compose

Use labeled To and Subject fields, a plain message editor, attachment/agent affordances, saved state, and a text “Send” action. Preserve drafts online; because the product is online-only, clearly report connection failure rather than suggesting offline sending.

## Responsive and accessibility requirements

- Baseline mobile viewport: 360px wide with no horizontal document overflow.
- Touch targets: 44×44px minimum for icon-only controls; compact text controls retain 44px tap height where feasible.
- Keyboard: logical tab order; visible focus ring; Enter/Space activates controls; Escape closes overlays.
- Screen readers: landmark labels, actionable card labels, state text, and live announcement for destructive triage/undo.
- Contrast and states: check default, hover/focus, disabled, selected, error, and high text scaling. Do not encode New/Question/Failed/History by color alone.
