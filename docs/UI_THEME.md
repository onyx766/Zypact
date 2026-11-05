# UI theme and 21st.dev components

Engineering guidance for the Tailwind/shadcn layer. This is not part of the
canonical product package in `V1_SCOPE.md` / `METHODOLOGY.md`; if it ever
appears to contradict those, they control.

## What "the 21st.dev theme" means here

21st.dev is a **registry, not a theme**: many authors, many styles, code copied
into your repo rather than imported. Its components ship no palette and inherit
the host project's design tokens. So there is nothing to "install" — the work is
to publish the **standard shadcn/ui variable contract under the standard names**
so anything pasted from the registry adopts Zypact's palette on arrival.

That contract now lives in [`app/tailwind.css`](../app/tailwind.css).

## How the layers fit together

This repo carries two styling systems at once, and the boundary between them is
deliberate:

| Surface | Styled by | Renders inside `.v2-root`? |
| --- | --- | --- |
| `/` (landing) | Tailwind tokens + `.lx` landing stylesheets | yes, via `ThemeRoot` |
| `/scan` (demo request) | Tailwind tokens + `.lx` landing stylesheets (`components/landing/styles/request.css` for the form) | yes, via `ThemeRoot` |
| `/perplexity-content-change-test` | Tailwind tokens | yes, via `ThemeRoot` |
| `/admin/**` | Tailwind tokens | yes, via `AdminThemeRoot` |
| `/report`, `/projects/**`, `/outcome-card`, `/login`, `/thank-you`, `/verify-email` | hand-written CSS (`app/globals.css` and friends, ~6,800 lines) | **no** |

Three invariants keep those two worlds apart. Breaking any one of them silently
restyles the legacy pages, including the client-facing report:

1. **Tokens are global; the reset is not.** The custom properties sit on `:root`
   and `.dark` so pasted components find them anywhere. Custom properties are
   inert — only a rule that *reads* one has any effect, and every such rule is
   either a `.v2-root`-scoped utility or a component in `components/ui`. No
   legacy stylesheet declares or reads a single token name.
2. **Every utility is scoped.** `important: ".v2-root"` in
   `tailwind.config.ts` emits utilities as `.v2-root .foo`. This is why the
   `content` globs can safely cover the whole repo, and why utilities do **not**
   apply to the `.v2-root` element itself — only to its descendants.
3. **Preflight is hand-rolled and scoped.** `corePlugins.preflight` is off;
   `app/tailwind.css` re-implements it under `.v2-root :where(...)`, which is
   specificity 0-1-0: above the legacy element rules, tied with utilities so
   utilities still win on source order.

`npm run test:landing-page` asserts all three. Run it after any change here.

## Dark-first

`:root` holds light values and `.dark` holds dark ones — the convention every
registry component and every `dark:` variant assumes. "Dark-first" is expressed
by what renders, not by inverting the contract: `ThemeRoot` applies `.dark`
unless asked otherwise.

```tsx
import { ThemeRoot } from "@/components/theme-root";

export default function Page() {
  return <ThemeRoot>{/* dark by default */}</ThemeRoot>;
}
```

Pass `theme="light"` for a light surface. The founder console keeps its own
`AdminThemeRoot` because it needs a runtime toggle persisted to a cookie.

One trap worth knowing: `app/globals.css` paints `h1`, `h2` and `a:hover` with
`var(--heading)`, a fixed near-black that the scoped preflight deliberately does
not reset. On a dark surface that is invisible text. `--heading` is therefore
repointed at `hsl(var(--foreground))` on `.v2-root` — and must **not** be
repointed on `:root`, which would reach the legacy pages that depend on the
fixed value.

## Adding a component from 21st.dev

1. Paste it under `components/ui/` (primitives) or a feature folder.
2. Make sure its page renders inside `ThemeRoot`.
3. Translate Tailwind v4 syntax to v3 — see below.
4. Install any missing Radix package it imports. Present today:
   `button`, `card`, `badge`, `input`, `textarea`, `label`, `separator`,
   `skeleton`. Only `@radix-ui/react-slot` is a dependency; `label` and
   `separator` are deliberately dependency-free re-implementations with the same
   exports and props, so swapping in the Radix versions later is mechanical.
5. Run `npm run typecheck` and `npm run build:verify` (never bare
   `npm run build` while a dev server is up).

### Tailwind v3 → v4 translation

The repo is on Tailwind **3.4**. Many current registry components assume v4:

| v4 in the paste | v3 equivalent here |
| --- | --- |
| `@theme inline { ... }` | add to `theme.extend` in `tailwind.config.ts` |
| `oklch(...)` token values | HSL channel triplets (`240 10% 4%`), no `hsl()` wrapper |
| `size-4` | `h-4 w-4` |
| `bg-card/50` | already works (tokens use `<alpha-value>`) |
| `rounded-xl` scaling with `--radius` | already works (mapped in config) |

Keep token values as bare HSL channel triplets. The `<alpha-value>` wiring in
`tailwind.config.ts` depends on that format, and it is what makes opacity
modifiers like `bg-primary/10` work.

## Token reference

Standard shadcn set: `background`, `foreground`, `card`, `popover`, `primary`,
`secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`,
`radius`, `chart-1`–`chart-5`, and the full `sidebar-*` set.

Zypact additions:

- `success` / `warning` / `info` — status colours, previously console-only.
- `surface` / `surface-subtle` / `surface-muted` — page surfaces. Variable-driven
  so existing `bg-surface-subtle` classes follow the theme.
- `panel` / `panel-foreground` / `panel-muted` — deliberately inverted sections
  (hero side panel, final CTA), formerly fixed `bg-brand-800` / `bg-brand-900`.
- `brand-50`–`brand-950` — fixed hexes on purpose. This is the identity ramp, not
  a theme surface; use the tokens above for anything that should follow the theme.

Before using `chart-1`–`chart-5` for a real visualization, read the dataviz
guidance. They are a reasonable starting ramp, not a validated palette, and
status encodings (preserved / retried / excluded) should keep using
`success` / `warning` / `destructive` instead.

## Deferred

- **Tailwind v4 upgrade.** Tokens are named and formatted so the move is mostly
  mechanical, but v4 changes the PostCSS pipeline plus border/ring and preflight
  defaults, and would interact with all seven legacy stylesheets. It needs its
  own verification pass across every page.
- **Rethemeing the legacy-CSS pages.** They cannot adopt tokens without their
  markup being rewritten, which is the work new UI would replace anyway.
