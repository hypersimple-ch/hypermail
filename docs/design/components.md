# Hypermail web component convention

**Status:** required for web UI changes  
**Implementation:** Tailwind CSS v4 with repository-owned shadcn/ui-style React components

## Inventory

### UI primitives

Located in `apps/web/src/components/ui/`:

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

All controls expose `data-slot` for stable component tests. Button and Badge use CVA variants. Controls merge caller utilities through `cn()` and preserve visible focus, disabled, invalid, and 44px target behavior.

### Application patterns

Located in `apps/web/src/components/app/patterns.tsx`:

- `NavigationItem`: desktop rail and mobile navigation state.
- `FilterGroup`: accessible `aria-pressed` filter controls.
- `PageHeader`: screen title, description, and supported actions.
- `StatePanel`: loading, empty, and recoverable state presentation.

Use a pattern when its semantic contract is repeated. Keep one-off mailbox row and domain content layouts in their owning feature component.

## Adding or changing a component

1. Confirm an existing primitive or app pattern cannot express the required semantic control. Do not add a wrapper only to shorten one call site.
2. For an official shadcn component, use `apps/web/components.json` as the source convention. Registry code may be generated with a reviewed, pinned CLI invocation or copied from the current official registry; generated code becomes owned project source.
3. Add only the component's required runtime dependency. Do not install the full registry or unused Radix packages.
4. Adapt the source to Hypermail requirements: neutral CSS variables, light-only presentation, 44px controls, visible focus, written non-color state, and Lucide icons.
5. Put reusable variants in CVA and combine classes with `cn()`. Tailwind class names must remain statically detectable; do not construct fragments such as `bg-${state}`.
6. Add component tests under `apps/web/test/ui/` for variants, semantic props, disabled/invalid behavior, field associations, and interaction. Feature tests should assert rendered semantics and component slots, not minified CSS text.
7. Run:

   ```sh
   pnpm exec vitest run apps/web/test/ui
   pnpm --filter @hypermail/web exec tsc -p tsconfig.json --noEmit
   pnpm --filter @hypermail/web build
   ```

8. Verify the build still emits `apps/web/dist/app.css`; `/app.css` is a public shell and service-worker contract.

## Styling boundaries

`apps/web/src/styles/globals.css` may contain only the Tailwind import/source registration, design tokens, global element normalization, and global accessibility behavior such as reduced motion. Component visuals belong in primitive variants or local Tailwind utilities. Legacy feature stylesheets, broad feature element selectors, `!important`, and inline color fixes are not accepted.
