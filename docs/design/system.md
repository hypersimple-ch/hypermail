# Hypermail design system

**Status:** approved for implementation  
**Scope:** private, single-user, Android-first, online-only email PWA.

## Direction

Use **Inbox-led calm utility**. Inbox is the familiar default; Activity is a separate, intentional queue for agent work and exceptions. Automation remains visible in message context, never a competing dashboard. The interface is basic, modern, and neutral-gray—not a branded or feature-expanded mail client.

## Foundations

- **Theme:** light only. White `#FFFFFF` surfaces on off-white `#F6F6F5` ground, with `#E2E2E0` borders and charcoal `#252525` ink. No elevation except the Compose FAB's minimal 2px shadow.
- **Type:** system UI stack. Message sender and selected titles use 700; subjects use 500; snippets and metadata use 400. Never use weight alone to convey state.
- **Shape:** 8px controls, 12px cards, 999px filters. Avoid large rounded containers.
- **Spacing:** 4px base; row padding 12px mobile / 13px desktop; 8px control gaps; 14–18px screen gutters.
- **Motion:** no essential animation. `prefers-reduced-motion: reduce` removes transitions and animation.
- **Controls:** project-owned HeroUI adapters retain a 44px minimum interactive height, including compact and icon controls; feature code must not shrink that target.

## Implementation convention

Hypermail uses **Tailwind CSS v4** and **HeroUI v3 React components** behind thin repository-owned adapters. This is the only production web styling convention.

- Global tokens and base accessibility rules live in `apps/web/src/styles/globals.css`. Tailwind v4 is configured CSS-first; do not add `tailwind.config.*`, PostCSS, CSS Modules, or a second styling system.
- HeroUI-backed controls live in `apps/web/src/components/heroui/`; reusable application patterns live in `apps/web/src/components/app/`. Feature components use TSX and Tailwind utilities for their unique layout.
- Use `cn()` from `apps/web/src/lib/utils.ts` when application-specific Tailwind classes must be merged with HeroUI styling. Never repair contrast or state with selector specificity, `!important`, inline color styles, or broad element selectors.
- Use the owned Button, Input, Checkbox, Textarea, Select, Card, Badge, Alert, Field, Separator, and Spinner primitives instead of styling raw controls in feature code. Compose navigation, filters, page headers, and empty/loading/error presentation from the app patterns.
- Use Lucide icons with an accessible text label or `aria-label`; decorative icons are `aria-hidden`. Do not use Unicode glyphs as interface icons.
- `globals.css` imports `@heroui/styles` immediately after Tailwind, then applies Hypermail’s light neutral tokens and accessibility rules. HeroUI v3 requires no global provider; add one only for an explicitly required optional integration such as internationalization.
- The web build compiles `globals.css` with the Tailwind CLI to the public `/app.css` asset. Static HTML and service-worker caching depend on that path.

See [`components.md`](components.md) for the component inventory and add-component workflow.

## Color and state

| Token | Value | Use | Required non-color cue |
|---|---:|---|---|
| Ink | `#252525` | primary text and primary actions | label, icon, or position |
| Muted | `#6B6B68` | secondary text | hierarchy/position |
| Selected | `#E9E9E6` | selected row/control | selected label or indicator |
| Green | `#217A4F` | explicit completed/success status only | completed wording/check |
| Amber | `#986500` | explicit needs-review/question status only | status label/action |
| Red | `#B3261E` | explicit failed/error status only | error wording/recovery action |

Do not use blue as a primary, selected, or informational state. Green, amber, and red are semantic-status colors only; all ordinary UI is neutral. Body-size text meets WCAG AA (4.5:1), and state is always communicated by text, icon, or placement as well as color.

## Core components

### App navigation

**Mobile (<700px):** fixed four-item tab bar: Inbox, Activity, Drafts, More. Activity may carry a numeric badge. The Compose FAB sits above/right of the bar and has an accessible “Compose” name.

**Desktop (>=700px):** fixed 220px left rail with Compose and destinations. Inbox uses a 385px message list and a remaining-width reader. Compose, Activity, Drafts, Sent, and More use the full area remaining after the rail; they are never constrained to Inbox's list column.

### Message row and projections

A balanced two-line inbox row is 79px minimum on mobile: 28px account/avatar, sender, subject, one-line snippet, timestamp. Sender and subject truncate without horizontal scrolling. Unread is supported by weight **and** an unread count/filter, never color alone.

Drafts and Sent are distinct projections. Drafts show editable saved messages and their saved state; Sent is read-only sent-message history. Render only metadata and actions supported by the API. Do not imply archive, read/unread changes, starring, folders, search, or other unsupported mail behavior.

### Filters and agent cards

Use compact, horizontally scrollable pills only where a supported filter exists. Active state uses neutral selected fill, charcoal label, and border. Activity filter order is fixed: **New, Questions, Failed, History**.

Place an agent card immediately after the message content it concerns. It contains agent label/icon, concise state, suggested action/content, and explicit approval controls. Sending is human-in-the-loop: an agent may draft or recommend, but sending requires the user's explicit approval. Unsupported actions are absent or visibly disabled with an honest explanation; no enabled control may be a no-op. Pending, error, and conflict states are visible and explain the next available action.

### Compose and auth

Compose and authentication are compact, modern, and stable within the viewport: no layout jumps, document overflow, or obscured essential controls. Compose has labeled To and Subject fields, a plain message editor, clear saved/pending/error state, and an explicit approval-to-send action. Preserve drafts online; report connection failure plainly rather than suggesting offline sending. Authentication clearly shows loading, failure, and retry/next steps.

## Responsive and accessibility requirements

- Baseline mobile viewport: 360px wide with no horizontal document overflow.
- Touch targets: 44×44px minimum for icon-only controls; compact text controls retain 44px tap height where feasible.
- Keyboard: logical tab order; visible focus ring; Enter/Space activates controls; Escape closes overlays.
- Screen readers: landmark labels, actionable-card labels, state text, and live announcement for pending, completion, error, and conflict feedback.
- Contrast and states: check default, hover/focus, disabled, selected, error, and high text scaling. Do not encode Activity status by color alone.
