# Light-mode audit — public site (fix/light-mode-audit)

Base: `origin/deploy/train-2026-11-05` @ `995bc5e6`. Branch: `fix/light-mode-audit`.
Review-gated: nothing here deploys, nothing merges without the lead's gate.

## Method

- Theme system: `next-themes`, `attribute="class"`, `defaultTheme="dark"`.
  `:root` in `src/app/globals.css` IS the light theme (Lunar Beige bg
  `60 17% 95%`, black foreground); `.dark` overrides it. Light was forced
  by setting next-themes localStorage `theme=light` and reloading; every
  screenshot's `<html>` class was verified to contain `light`.
- Rendered locally: `next dev` on the branch with dummy Firebase env vars
  (the known no-env 500 is bypassed; pages return 200 with real copy).
  Headless Chromium (Playwright build) drove each page: step-scroll to the
  bottom dispatching mousemove/scroll (wakes theater mode, triggers
  `whileInView`), back to top, screenshot full page.
- Two harness artefacts, both verified theme-independent (same in dark):
  1. The hero fades out after 3.5s idle (theater mode,
     `induction-hero-section.tsx` `IDLE_TIMEOUT = 3500`). The scroll-through
     wakes it before each shot.
  2. Framer-motion entrance animations do not advance in headless Chrome:
     word spans stay at inline `opacity: 0` after 15s, in dark too, and
     finishing WAAPI animations does not move them. The shoot forces final
     state IN-SESSION ONLY (inline `opacity: 0` -> `1`, inline blur -> none)
     so the shots show true colours. No source was touched for this.
- Pages rendered, desktop 1440 + mobile 390: `/`, `/grand-prix`,
  `/grand-prix/register`, `/about`, `/sourcing-bridge`.
- Pre-fix shots: `~/workspace/seds-heap-hunt/light-mode-shots/`
  (tops + full-page). Post-fix shots:
  `~/workspace/seds-heap-hunt/light-mode-shots-fixed/`.

## What passes in light mode (no change)

- Header dock, desktop + mobile: white pill, logo, nav links, theme toggle
  and hamburger all legible.
- Footer (forced-dark surface, all pages): legible.
- Grand Prix + register heroes (forced-dark starfield scenes): gold headline,
  white body, flags, fee callout all legible.
- `/sourcing-bridge` end to end (12,091px desktop, 38,300px mobile):
  token-based page, every section legible. Control case: token-driven pages
  render fine in light mode.
- Register form fields, labels, placeholders, ENROL NOW button: legible
  (after the border fix below; labels in `#CBBFA5` are marginal but readable).

## Catalogue — fixed on this branch (token swaps, dark-neutral)

Every swap below replaces a hard-coded white tint with the equivalent
`foreground` token. In dark mode `--foreground` is white, so dark rendering
is byte-identical in computed colour. Verified by re-shoot (see below).

- **L1. Home hero H1 invisible.** `src/components/sections/induction-hero-section.tsx:230,238`
  Both headline lines hard-coded `text-white`; white on Lunar Beige is
  ~1.1:1. Fixed: `text-white` -> `text-foreground`. Re-shoot: H1 now black,
  fully legible, desktop + mobile.
- **L2. Readiness hairlines invisible.** Same file `:248,250`. `bg-white/20`
  flanking "OPERATIONAL READINESS: NOMINAL". Fixed: `bg-foreground/20`.
  Re-shoot: hairlines visible.
- **L3. CubeSat underline invisible.** Same file `:255`.
  `decoration-white/40` -> `decoration-foreground/40`. Re-shoot: underline visible.
- **L4. Hero ghost buttons + chapter card tints.** Same file `:295,308,320,326,330,394`.
  `border-white/*`, `bg-white/*`, `hover:bg-white/*` on Join The Tribe,
  Donate, Establish Chapter card/chip/scan-line, icon tile. Fixed to the
  `foreground` equivalents. Note: the `bg-slate-950/40` glass fills were NOT
  changed (see W1); borders/tints now read, fills still need the design call.
- **L5. Grand Prix light-section card borders invisible.**
  `src/app/grand-prix/page.tsx:239,265,291,298` (discipline, module, both
  patron cards). `border-white/10` -> `border-foreground/10`. Re-shoot:
  cards now have visible hairline outlines. Titles inside still washed (W2).
- **L6. Register input borders invisible.** `src/app/grand-prix/register/page.tsx:62,64,410`
  (`fieldClass`, `selectClass`, unselected pass-type radio). `border-white/15`
  -> `border-foreground/15` (+ `hover:border-white/35` -> `hover:border-foreground/35`).
  Re-shoot: every field now has a visible border. Labels inside still washed (W3).

## Catalogue — written up, not implemented (needs component/design work)

- **W1. Hero glass buttons stay dark-glass in light mode.**
  `induction-hero-section.tsx:295,308` — Join The Tribe and Donate keep
  `bg-slate-950/40` with `text-foreground` / `text-foreground/80`. In light
  mode that is black text on a dark navy glass fill: poor contrast. No token
  equivalent exists for "dark glass fill"; needs a light-mode fill (e.g.
  `bg-card` + `border-border`) or a theme-aware variant. Same for the stats
  card body `bg-card/40` (`:320`) and icon tile (`:394`): white 40% on beige
  reads as washed panels with no visible surface.
- **W2. Grand Prix light sections: gold/ivory text on light surfaces.**
  `src/app/grand-prix/page.tsx` constants `IVORY #F5F0E4`, `GOLD #C9A45C`,
  `GOLD_LIGHT #E8CF8F`. Section headings use `style={{ color: GOLD_LIGHT }}`
  (`:230` disciplines, curriculum, patrons headings); discipline/module titles
  use `style={{ color: IVORY }}` (`:245,:273`); body copy `text-[#CFC8B8]`
  (`:247,:276,:296,:305`); labels `text-[#CBBFA5]`. Pale gold/cream on
  beige/white is ~1.6–2.5:1. The gold palette is correct on the dark hero; the
  light sections need darkened text golds (founder/design call: e.g. a text
  gold around `#8A6D2B`, keeping `#C9A45C` for fills/borders on dark). Also
  `bg-white/[0.04]` card fills stay washed; the border fix (L5) outlines them
  but the surface is still near-invisible.
- **W3. Register pass-type labels invisible.**
  `src/app/grand-prix/register/page.tsx:400-418` — radio buttons carry
  `style={{ color: IVORY }}` (`#F5F0E4`) on white cards. Both options
  unreadable in light mode. Needs a theme-aware label colour (dark ink on
  light, ivory on dark). The selected state's gold border is fine.
- **W4. Register "01 Your enrolment" title crosses the dark/light seam.**
  Same file: the first form card uses translucent `cardClass`
  (`border-white/10 bg-white/[0.04]`) over the dark `SpaceScene` hero; its
  `CardTitle` is `text-foreground` (black in light), so the title sits black
  on the dark scene where the card overlaps the hero, while "02 About you"
  sits fully on light and reads fine. Needs the card given a light-mode
  surface or the title kept off the seam.
- **W5. Orbit starfield is white-on-light.**
  `src/components/hero/orbiting-partners.tsx:124-127` — stars are
  `fill="white"` circles, constellation chains `stroke="white" strokeOpacity="0.09"`.
  On the light hero (no dark void) the whole star chart is invisible. The
  planet discs themselves are dark and would show once partner data loads;
  the starfield's light-mode treatment belongs to the starfield slice — noted
  here so the two slices do not diverge.

## Coverage gaps (not breaks)

- **`/about` unassessable in this harness.** `src/app/about/page.tsx:50,70-97`
  starts `isLoading=true` and renders content only once Firestore resolves;
  with dummy Firebase it spins forever (both viewports). Nothing about its
  light styling could be judged; needs a branch preview with the backend.
- **Home below the hero unassessable.** Store, Showcase, About, Skills, Join
  Us, News, Projects, TrustBar, Timeline, Events sections are Firestore-driven
  and render empty with dummy Firebase. The hero + header + footer chrome is
  fully assessed; data sections need the backend.

## Ruled out (looked like breaks, are not)

- Pale peach APPLY NOW button in the shots: the intake window never resolves
  with dummy Firebase, so `useIntakeWindow('induction')` stays `loading` and
  the CTA renders disabled at 50% opacity by design
  (`induction-hero-section.tsx:67-81`, fail-safe). With a resolved open window
  the gold button shows. Not a light-mode break.
- Empty orbit band in the first shots: partners come from Firestore; with no
  data there are no planet discs to draw. The discs are dark by design and
  will show on light once data loads. The white stars (W5) are the real item.
- Empty hero in the first shoot: theater-mode idle fade + frozen entrance
  animations (see Method). Both theme-independent.

## Gates (measured on this worktree, the lead's way)

- `tsc --noEmit`: branch **147** errors; base `995bc5e6` (measured by stashing
  the diff and re-running) **147** errors. Identical; the change is
  class-string-only.
- Jest affected suites: `home-critical-path`, grand-prix registration route +
  lib — **3/3 suites, 32/32 tests pass**.
- Full Jest not re-run: change touches no logic, only Tailwind class strings.

## Diff

3 files, 18 insertions / 18 deletions, all `white/*` -> `foreground/*`:
`src/components/sections/induction-hero-section.tsx`,
`src/app/grand-prix/page.tsx`, `src/app/grand-prix/register/page.tsx`.
