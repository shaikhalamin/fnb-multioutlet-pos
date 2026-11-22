# DESIGN_SYSTEM.md — Editorial Design System (both frontends)

This is the canonical design-system specification for `hq-frontend` and
`outlet-frontend`. Every UI change in either app MUST follow it. The
implementation lives in each app's `src/styles.css` (Tailwind CSS v4,
CSS-first config — **the two files are byte-identical by contract**; change
one, copy to the other in the same commit).

The system is a quietly editorial, print-magazine voice: off-white canvas,
warm near-black ink, a light display serif, Inter body type, hairline cards,
pill CTAs, and pastel gradient orbs as the only "color" moments. There is **no
saturated CTA color, no dark mode, no glassmorphism**.

## 1. Fonts

| Role | Family | Weights | Loaded via |
|---|---|---|---|
| Display (headlines, page titles, receipt numbers) | **EB Garamond** (Waldenburg Light substitute) | 400 | `@fontsource/eb-garamond` |
| Body / UI / buttons / nav / tables | **Inter** | 400, 500, 600 | `@fontsource/inter` |

- Fonts are **self-hosted** (Fontsource `@import`s at the top of
  `src/styles.css`) — outlets may run without internet; never switch back to a
  CDN `<link>`/`@import`.
- The spec's display weight is 300. EB Garamond's lightest real weight is 400,
  which is what renders; the type tokens still declare `font-weight: 300` so a
  true Light cut can drop in later without markup changes. **Never bold display
  copy** (`font-bold`/`font-semibold` on `font-display` text is a defect).
- Body Inter stays at 400/500 (600 for `kicker`/captions) — never 300.

Apply the display family with the `font-display` utility; everything else
inherits Inter (`font-sans` on `<body>`).

## 2. Color tokens (`:root` in `src/styles.css` → Tailwind utilities)

| Token (CSS var) | Utility | Hex | Use |
|---|---|---|---|
| `--canvas` | `bg-canvas`, `text-canvas` | `#f5f5f5` | Page floor (body background) |
| `--canvas-soft` | `bg-canvas-soft` | `#fafafa` | Alternating soft bands, inset form surfaces |
| `--surface-card` | `bg-surface-card` | `#ffffff` | Cards, inputs, popover surfaces |
| `--surface-strong` | `bg-surface-strong` | `#f0efed` | Badges, chips, hover fills, slider tracks |
| `--surface-dark` | `bg-surface-dark` | `#0c0a09` | Rare deliberate dark band (with `text-on-dark`) |
| `--surface-dark-elevated` | `bg-surface-dark-elevated` | `#1c1917` | Cards on a dark band |
| `--ink` | `text-ink`, `border-ink` | `#0c0a09` | Display + primary text |
| `--body` | `text-body` | `#4e4e4e` | Default running text |
| `--body-strong` | `text-body-strong` | `#292524` | Emphasized body |
| `--muted` | `text-muted-foreground` | `#777169` | Sub-titles, table headers, metadata |
| `--muted-soft` | `text-muted-soft` | `#a8a29e` | Disabled text, placeholders |
| `--primary` | `bg-primary` | `#292524` | The ink pill — **the only primary CTA color** |
| `--primary-active` | `hover:bg-primary-active` | `#0c0a09` | Press/hover state of the ink pill |
| `--on-primary` | `text-on-primary` | `#ffffff` | Text on the ink pill |
| `--on-dark` / `--on-dark-soft` | `text-on-dark(-soft)` | `#fff` / `#a8a29e` | Text on dark bands |
| `--hairline` | `border-hairline` | `#e7e5e4` | Default 1px divider / card border |
| `--hairline-soft` | `border-hairline-soft` | `#f0efed` | Lighter row dividers |
| `--hairline-strong` | `border-hairline-strong` | `#d6d3d1` | Outlines: outline buttons, inputs |
| `--success` | `text-success`, `bg-success/10` | `#16a34a` | Confirmations, stock-in, sync-ok |
| `--error` | `text-error`, `bg-error/10` | `#dc2626` | Validation errors, destructive text |
| `--gradient-mint` … `--gradient-rose` | `bg-gradient-*` (rarely direct) | mint `#a7e5d3`, peach `#f4c5a8`, lavender `#c8b8e0`, sky `#a8c8e8`, rose `#e8b8c4` | **Atmospheric orbs only** — never fills for interactive elements, never text |

Rules:

- **No hardcoded hex/rgba in components.** Use the utilities above (tints via
  `/10` opacity modifiers, e.g. `bg-error/10`). The only hexes live in
  `src/styles.css`.
- There is deliberately **no warning/amber color**. Warning/neutral states use
  `badge-neutral` (`--surface-strong` + `text-body`).
- Semantic shadcn tokens (`--background`, `--primary`, `--border`,
  `--destructive`, `--ring`, …) are re-mapped to this palette so
  `src/components/ui/*` primitives and any future `shadcn add` output render
  on-brand. Exception: shadcn's `bg-muted` maps to the muted **text** color
  here — use `bg-surface-strong` for muted surfaces (see §6).

## 3. Typography scale (`--text-*` tokens → `text-*` utilities)

| Utility | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `text-display-mega` | 64px / 1.05 | 300 | −1.92px | Landing hero h1 (desktop) |
| `text-display-xl` | 48px / 1.08 | 300 | −0.96px | Subsidiary heroes |
| `text-display-lg` | 36px / 1.17 | 300 | −0.36px | Section heads |
| `text-display-md` | 32px / 1.13 | 300 | −0.32px | **Page h1s** |
| `text-display-sm` | 24px / 1.2 | 300 | 0 | Card-group titles, receipt numbers |
| `text-title-md` | 20px / 1.35 | 500 | 0 | Component/section h2s (Inter **or** display) |
| `text-title-sm` | 18px / 1.44 | 500 | +0.18px | List labels |
| `text-body-md` | 16px / 1.5 | 400 | +0.16px | Default body |
| `text-body-strong` | 16px / 1.5 | 500 | +0.16px | Emphasized body |
| `text-body-sm` | 15px / 1.47 | 400 | +0.15px | Secondary body, footer |
| `text-caption` | 14px / 1.5 | 400 | 0 | Captions, metadata |
| `text-caption-uppercase` | 12px / 1.4 | 600 | +0.96px | Badges, labels |
| `text-button` | 15px / 1 | 500 | 0 | CTA pill (built into `.btn-*`) |
| `text-nav-link` | 15px / 1.4 | 500 | 0 | Top-nav links (built into `.nav-link`) |

Conventions: page h1 = `font-display text-display-md text-ink`; panel h2 =
`font-display text-title-md text-ink`; body letter-spacing (+0.16px) is set
once on `<body>`. Responsive hero: `text-display-md sm:text-display-xl
lg:text-display-mega` (32 → 48 → 64 across mobile/tablet/desktop).

## 4. Spacing, radius, elevation, rhythm

- Spacing: Tailwind default scale (4px base). Section rhythm: `py-24` (96px)
  between major bands; cards inside a band sit at 16–24px gaps.
- Content container: `.page-wrap` (max 1200px).
- Radius: `rounded-md` 8px (inputs), `rounded-2xl` 16px (cards),
  `rounded-3xl` 24px (orb cards), `rounded-full` (CTAs, badges, avatars).
  Never 0px on interactive elements.
- Elevation: **one** shadow tier — `shadow-soft` (`0 4px 16px rgba(0,0,0,0.04)`)
  on hovered cards only. Cards at rest are flat: white surface + 1px hairline.

## 5. Component classes (`@layer components` in `src/styles.css`)

| Class | Purpose |
|---|---|
| `.page-wrap` | 1200px content container |
| `.card-panel` | The standard white card: `--surface-card` bg, 1px `--hairline` border, 16px radius |
| `.feature-card` | Card-panel + hover lift (`translateY(-2px)` + `shadow-soft`); for clickable tiles/links |
| `.kicker` | Section label: 12px/600/+0.96px uppercase in `--muted`; also used for `<th>` (add `text-left`) and `<legend>` |
| `.btn-primary` (`+ .btn-sm`) | Ink pill CTA: 40px high, 15px/500, hover `--primary-active` |
| `.btn-outline` (`+ .btn-sm`) | Secondary: transparent, 1px `--hairline-strong`, hover `--surface-strong` |
| `.badge-pill` | Pill badge/chip: `--surface-strong` bg, caption-uppercase voice |
| `.badge-success` / `.badge-error` / `.badge-neutral` | Status variants (pair with `.badge-pill`); use `normal-case tracking-[0.08em]` when the content is a name/role, not a status |
| `.form-input` | Form control: 44px, white, 8px radius, `--hairline-strong` border, typed text always ink; focus = 2px ink ring (no layout shift). Override size with utilities (`h-9 w-28 px-2.5`) |
| `.money` | Money & aligned numerals: Inter + `tabular-nums`. **Use this instead of `font-mono`** — the system has no mono moment |
| `.orb` + `.orb-mint/-peach/-lavender/-sky/-rose` | Decorative blurred radial-gradient circle. Always `aria-hidden="true"`, absolutely positioned, sized/placed with utilities. Hero/login: large (h-72+); dashboard/POS headers: small accent (h-40) |
| `.orb-card` | Soft band (canvas-soft, 24px radius) with an orb blooming behind centered display copy — landing/brand moments |
| `.nav-link` (+ `.is-active`) | Top-nav link: 15px/500, ink underline on hover/active |
| `.rise-in` / `.site-footer` | Entrance animation / hairline-top footer |

## 6. Hard rules (do / don't)

**Do**

- One primary action per view: the ink pill (`.btn-primary` / `bg-primary`).
- Every CTA and badge is a pill; cards are `rounded-2xl` with hairline borders.
- Pair dark surfaces with `text-on-dark` / `text-on-dark-soft` text.
- Render money via `formatMinor` + `.money` (tabular numerals, string math
  only — see root AGENTS.md §4.3).
- Keep receipt/print views working: preserve `print:*` variants when restyling.
- Keep both apps' `src/styles.css` byte-identical.

**Don't**

- Don't introduce a saturated brand action color, gradients on buttons, or
  glow shadows. Ink pill is the only CTA color.
- Don't bold display copy (`font-display` stays at its token weight).
- Don't use orb colors as backgrounds of interactive elements, text colors, or
  borders — orbs are pure atmosphere (decoration only, `aria-hidden`).
- Don't hand-write `bg-muted` for a muted **surface** — that utility is the
  muted **text** color here (shadcn naming collision); use `bg-surface-strong`.
- Don't add a dark-mode theme or a theme toggle — the system is off-white
  only; `.dark` is never applied (`@custom-variant dark` remains only to keep
  `dark:` utilities inert, class-scoped).
- Don't use `font-mono` for money or IDs.
- Don't import fonts from a CDN.

## 7. Implementation notes

- Tailwind v4 CSS-first: tokens are declared in `:root`, mapped to utilities
  in `@theme inline`. There is no `tailwind.config.*`; `src/styles.css` is the
  single theme source.
- Component classes live in `@layer components`, so plain utilities can
  override them per-usage (e.g. `form-input h-9 w-28`).
- Element defaults (`a`, form controls, …) must live in `@layer base`. An
  unlayered rule outranks every layer and silently overrides component classes
  — an unlayered `a { color }` left link CTAs (`a.btn-primary`) with ink text
  on the ink pill.
- Never name a component class after a `@theme` color token (the `.text-input`
  lesson): `--color-input` makes Tailwind generate a `text-input` **color
  utility** (grey `--hairline-strong`), and the utilities layer beats
  `@layer components` — so the old `.text-input` class rendered every typed
  value in light grey. The form control is `.form-input`; typed text is also
  forced to ink by an `@layer base` rule on `input/select/textarea`, so even
  bare fields can't inherit the grey body color.
- Overlays and selectors (HQ console): `components/ui/dialog.tsx`,
  `checkbox.tsx` and `radio-group.tsx` are the only modal/selection
  primitives. The dialog is the standard card (`bg-surface-card`, hairline
  border, 16px radius) over a `bg-ink/50` scrim at `z-[60]` — above the
  `z-50` sticky header and toaster, so neither can cover a focused control
  inside it. It fades/zooms for ≤ 200 ms; `motion-reduce:animate-none!`
  removes the motion (the `!` is required: the `data-[state=open]`
  animation rule is more specific). Checkbox and radio draw an 18px control
  inside a 36px / 24px hit area; checked = ink fill + glyph (state is never
  colour alone), focus = ink ring on the visible box. The **unchecked**
  outline is `border-muted-foreground` (≈ 4.8:1), not the input hairline: at
  18px `--hairline-strong` is ≈ 1.5:1 against the card and a control boundary
  needs 3:1 (WCAG 1.4.11).
- `components/ui/*` (shadcn primitives) consume the semantic tokens; `button`
  is pill-geometry. When adding components via
  `pnpm dlx shadcn@latest add <name>`, they inherit the palette — afterwards
  swap any `bg-muted`/`bg-accent` surface utilities for `bg-surface-strong`
  and give action buttons pill geometry.
- Status vocabulary: ok/in-stock/settled → success; expired/error/out-of-stock
  → error; pending/warning/unknown → neutral (no amber in this system).
- Accessibility: primary pill is 40px tall; keep tap targets ≥ 40px on POS
  flows; visible focus (`.form-input` ink ring; `outline-ring` on the rest).
- Native checkboxes/radios get `accent-color: var(--ink)` from `@layer base`
  (no OS-blue accents); placeholders are `--muted-soft`, typed values ink.
