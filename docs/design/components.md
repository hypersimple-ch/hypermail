# Hypermail HeroUI component convention

**Status:** required for web UI changes  
**Implementation:** Tailwind CSS v4 with HeroUI v3 and thin repository-owned compatibility adapters

## Inventory

### UI primitives

Located in `apps/web/src/components/heroui/`. Button, Card, Alert, Chip-backed Badge, Input, Textarea, Separator, and Spinner use official `@heroui/react` components. Field and NativeSelect remain small application-owned semantic adapters where native form behavior is required.

| Component | Use |
|---|---|
| `Button` | All button/link actions; typed visual and size variants |
| `Input` | Single-line text, email, and password fields |
| `Textarea` | Message and answer editors |
| `NativeSelect` | Native, keyboard-friendly account and option selection |
| `Card` | Grouped content with header/content/footer sections |
| `Badge` | Written status paired with semantic color |
| `Alert` | Error, safety, and status messages |
| `Field` | Label, description, error, legend, and disabled form grouping |
| `Separator` | Semantic or decorative section boundaries |
| `Spinner` | Pending state; paired with written status text |

HeroUI-backed controls expose HeroUI `data-slot` markers, while the native semantic adapters keep repository-owned slots. The Button and Badge adapters translate Hypermail variants to HeroUI variants; caller utilities are merged through `cn()` while preserving focus, disabled, invalid, and 44px target behavior.

### Application patterns

Located in `apps/web/src/components/app/patterns.tsx`:

- `NavigationItem`: desktop rail and mobile navigation state.
- `FilterGroup`: accessible `aria-pressed` filter controls.
- `PageHeader`: screen title, description, and supported actions.
- `StatePanel`: loading, empty, and recoverable state presentation.

Use a pattern when its semantic contract is repeated. Keep one-off mailbox row and domain content layouts in their owning feature component.

## Adding or changing a component

1. Confirm an existing HeroUI component or application pattern cannot express the required semantic control.
2. Use the current [HeroUI React component documentation](https://heroui.com/en/docs/react/components) and import only the required component entry point from `@heroui/react`.
3. Keep adapters thin: translate Hypermail’s domain variants, 44px targets, and native semantics without copying HeroUI source into the repository.
4. Preserve the neutral light theme, visible focus, written non-color state, and Lucide icon accessibility requirements.
5. Add component tests under `apps/web/test/ui/` for semantic props, disabled/invalid behavior, field associations, and interaction. Assert HeroUI slots and user-visible behavior rather than private generated CSS.
6. The optional official HeroUI React MCP server can provide current component documentation and source to supported development clients: `npx -y @heroui/react-mcp@latest`. It is development tooling, not an application runtime dependency.
7. Run:

   ```sh
   pnpm exec vitest run apps/web/test/ui
   pnpm --filter @hypermail/web exec tsc -p tsconfig.json --noEmit
   pnpm --filter @hypermail/web build
   ```

8. Verify the build still emits `apps/web/dist/app.css`; `/app.css` is a public shell and service-worker contract.

## Styling boundaries

`apps/web/src/styles/globals.css` may contain only the Tailwind import/source registration, design tokens, global element normalization, and global accessibility behavior such as reduced motion. Component visuals belong in primitive variants or local Tailwind utilities. Legacy feature stylesheets, broad feature element selectors, `!important`, and inline color fixes are not accepted.
