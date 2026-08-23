# Hypermail HeroUI component convention

**Status:** required for web UI changes  
**Implementation:** Tailwind CSS v4 with HeroUI v3 and thin repository-owned compatibility adapters

## Inventory

### UI primitives

Located in `apps/web/src/components/heroui/`. Button, Card, Alert, Chip-backed Badge, Input, Textarea, Separator, and Spinner use official `@heroui/react` components. Select and Checkbox now use the official HeroUI compound components. Field composes the official HeroUI Label and Fieldset with application layout helpers. HeroUI and React Aria may render internal native or hidden form elements to preserve browser semantics, but application source must not author visible native controls.

| Component | Use |
|---|---|
| `Button` | All button actions; typed visual and size variants |
| `Link` | HeroUI navigation and external links |
| `Input` | Single-line text, email, and password fields |
| `Checkbox` | HeroUI labelled boolean control with a 44px interactive target |
| `Textarea` | Message and answer editors |
| `Select` | HeroUI popover and ListBox selection with hidden native form submission |
| `Card` | Grouped content with header/content/footer sections |
| `Badge` | Written status paired with semantic color |
| `Alert` | Persistent error, safety, and status messages |
| `Toast` | Transient operation feedback; auto-dismisses after 5 seconds with a duration bar |
| `Field` | Label, description, error, legend, and disabled form grouping |
| `Separator` | Semantic or decorative section boundaries |
| `Spinner` | Pending state; paired with written status text |

HeroUI-backed controls expose HeroUI `data-slot` markers. The Button and Badge adapters translate Hypermail variants to HeroUI variants; caller utilities are merged through `cn()` while preserving focus, disabled, invalid, and 44px target behavior. Outlined buttons, form fields, select triggers, and cards use the white surface token so they remain distinct from the light-gray page background.

### Application components

Located in `apps/web/src/components/app/`:

- `patterns.tsx` provides `NavigationItem`, `FilterGroup`, `PageHeader`, and `StatePanel`.
- `rich-text-editor.tsx` provides the lazily loaded `RichTextEditor` boundary. Its Tiptap engine supports font family/size, emphasis, lists, quotes, alignment, and history controls. The owned HeroUI toolbar keeps core emphasis actions initially visible and scrolls locally on narrow screens.

The root-mounted HeroUI `ToastProvider` owns transient feedback. Use the repository `toast` helper for completed or failed user operations. Keep field validation, recoverable page-load errors, and persistent domain alerts inline. Toasts pause while hovered or focused, expose a 44px close control, and remove countdown motion under `prefers-reduced-motion: reduce`.

Use a shared application component when its semantic contract is repeated. Keep one-off mailbox row and domain content layouts in their owning feature component.

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
