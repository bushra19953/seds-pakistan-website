# Design audit: /projects + Grand Prix detail page

Branch: `design/projects-pass`, base `df8275f4` (current live line).
Scope: `src/app/projects/page.tsx` and `src/app/projects/detail/page.tsx` only.
Method: impeccable `audit` (5 dimensions) + design-better heuristics (cited H#).
Date: 2026-11-03. Auditor note: the lead's brief is fully specified, so this
pass proceeded from the brief without an interview round (lead is async via relay).

## Method limits (stated, not hidden)

- Live leg is desktop-only (1919px viewport, managed browser, read-only):
  /projects renders 13 real cards, the Mission Command board (23 missions,
  62% NMR), search + filters, footer. The Grand Prix detail renders title,
  hero image, full description, a Team Lead badge with no visible names,
  one "technical" tag, and Roadmap 0/1 (0%).
- Mobile 390px could NOT be verified by render: this environment has no
  viewport-resize tool and zoom attempts had no effect. Mobile findings
  below are code-inferred and marked [code-inferred].
- Detector: file scan over both pages returned zero findings. The rendered
  URL scan could not run here: the managed Chrome binary is gated by Hatch
  policy, the Playwright headless shell refuses root without --no-sandbox,
  and the egress proxy requires auth the detector does not forward.
  Desktop screenshots were captured in the browser session but are not
  retrievable as files from this environment, so none are attached.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | Clickable progress div is not keyboard-operable (P1) |
| 2 | Performance | 3 | Good lazy/deferred patterns; one un-lazy iframe (P3) |
| 3 | Theming | 3 | Tokens used; HUD palette is hard-coded but deliberate |
| 4 | Responsive Design | 2 | Desktop verified clean; mobile code-inferred risks only |
| 5 | Implementation Integrity | 3 | Coherent, product-specific; detector file scan clean |
| **Total** | | **13/20** | **Acceptable** |

## Implementation integrity verdict

Pass. Both pages express one coherent product system (dark HUD styling,
accent typography, card + badge + progress vocabulary shared with the rest
of the site). No decorative or misleading content found. The issues below
are isolated craft gaps, not systemic drift.

## Executive summary

- 3 P1, 9 P2, 3 P3 findings. No P0 (nothing blocks task completion).
- Top issues: keyboard-inaccessible roadmap trigger, unlabeled search,
  failing-contrast empty-state text, unnamed team avatars, two no-wrap rows
  that risk narrow-viewport overflow.
- This pass fixes P1s, P2s, and the P3 iframe. It deliberately does NOT
  touch: the shared Footer (see observation O1), the board's position above
  the grid (founder call, O2), or the HUD's hard-coded palette (P3 note).

## Detailed findings

### P1

**[P1-1] Roadmap trigger is a clickable div, not a button**
- Location: `src/app/projects/page.tsx:741` (progress block, `onClick` opens
  the roadmap dialog).
- Category: Accessibility. Impact: keyboard and screen-reader users cannot
  open a roadmap at all; the "Click to view roadmap" text is click-only.
- Standard: WCAG 2.1.1 (H37).
- Fix: render it as a `<button type="button">` with the same styling.
  Function identical.

**[P1-2] Search input has a placeholder but no label**
- Location: `src/app/projects/page.tsx:587`.
- Category: Accessibility. Impact: assistive tech announces an unlabeled
  field; placeholder text disappears on input.
- Standard: WCAG 1.3.1 / 3.3.2 (H40).
- Fix: add `aria-label="Search projects"`. Placeholder text unchanged.

**[P1-3] Board empty-state text fails contrast**
- Location: `src/app/projects/page.tsx:487` ("No active national missions"),
  `:509` ("No recent signal activity"): `text-slate-600` on a near-black card
  (~2.5:1).
- Category: Accessibility. Impact: empty-state text is unreadable for
  low-vision users.
- Standard: WCAG 1.4.3 (H14).
- Fix: `text-slate-400`. No copy change.

### P2

**[P2-1] Category filter group has no semantics**
- Location: `src/app/projects/page.tsx:597` ("Filter by category:" span) and
  the buttons below it: no group label, no `aria-pressed`.
- Category: Accessibility. Impact: the selected filter is not announced.
- Standard: WCAG 1.3.1 / 4.1.2 (H48).
- Fix: `role="group"` + `aria-label` on the wrapper, `aria-pressed` on each
  button. Visible labels unchanged.

**[P2-2] Motion has no reduced-motion alternative**
- Location: `src/app/projects/page.tsx:359,374,501,521,542`
  (`animate-pulse`, `animate-ping`) and `:539` (1500ms readiness transition).
- Category: Accessibility. Impact: vestibular-sensitive users get
  continuous motion with no opt-out.
- Standard: WCAG 2.3.3 (H36).
- Fix: `motion-reduce:animate-none` / `motion-reduce:transition-none` on
  those elements. Feedback signal kept (dots/bars stay visible).

**[P2-3] Detail team members have no visible names**
- Location: `src/app/projects/detail/page.tsx:27` (`MemberAvatar`: avatar
  only, no name text, no `title`) and `:357-367` (Team Members card).
- Category: Accessibility / UX. Impact: on the live Grand Prix page the
  card shows a "Team Lead" badge beside anonymous faces; on touch there
  is not even a tooltip. The roadmap section on the same page already
  shows assignee names (AssigneeChip pattern).
- Standard: H20 (discoverability), H45 (no hover-only info).
- Fix: render team members (and the lead) as avatar + name chips reusing
  the in-file AssigneeChip pattern; add an explanatory line only when
  there is no leader and no members. Same profile links, same data.

**[P2-4] Two no-wrap rows risk narrow-viewport overflow [code-inferred]**
- Location: `src/app/projects/page.tsx:454` (workflow card footer: avatar
  stack + "Operational Intel" button, `flex justify-between` with no wrap)
  and `:554-555` (NMR legend row, `flex gap-4` with no wrap).
- Category: Responsive. Impact: at 320-390px these rows can overflow the
  card instead of wrapping.
- Standard: WCAG 1.4.10 (H9).
- Fix: add `flex-wrap` + gap to both rows. Desktop layout unchanged
  (rows already fit there).

**[P2-5] Board card padding squeezes narrow viewports [code-inferred]**
- Location: `src/app/projects/page.tsx:354` (`CardHeader px-8`) and `:382`
  (`CardContent px-8`): 32px each side at 320px leaves ~256px of content.
- Category: Responsive.
- Fix: `px-5 md:px-8` on both. Desktop (md+) identical.

**[P2-6] Detail description lines run too long**
- Location: `src/app/projects/detail/page.tsx:332`
  (`prose prose-invert max-w-none` inside the 2/3 column, ~830px lines).
- Category: Typography. Impact: long lines slow reading.
- Standard: H8 (50-75ch).
- Fix: cap the prose container at `max-w-[65ch]`. Copy unchanged.

**[P2-7] Detail "Project not found" has no recovery path**
- Location: `src/app/projects/detail/page.tsx:259` (bare heading).
- Category: States. Impact: a dead end on a bad slug; nothing tells the
  visitor where to go.
- Standard: H32 (errors say what/why/how to fix).
- Fix: styled state panel + a "Back to projects" link (existing route,
  no new feature).

**[P2-8] Detail "No image provided" fallback is bare text**
- Location: `src/app/projects/detail/page.tsx:321`.
- Category: States / consistency. Impact: inconsistent with the
  projects-page placeholder (logo + label) for the same situation.
- Standard: H31 (empty states are first impressions).
- Fix: reuse the projects-page placeholder block (logo + "SEDS Pakistan"
  label). No new content.

**[P2-9] Projects empty states are bare muted text**
- Location: `src/app/projects/page.tsx` search-no-results and no-projects
  branches (plain centered text).
- Category: States. Impact: reads as a broken page rather than a designed
  state; inconsistent with the board's own dashed-border empty states.
- Standard: H31.
- Fix: dashed-border panels matching the board's empty-state pattern.
  No new actions, no copy changes beyond the existing sentences.

### P3

**[P3-1] Detail video iframe is not lazy**
- Location: `src/app/projects/detail/page.tsx` video section.
- Category: Performance. Fix: add `loading="lazy"`. Function identical.

**[P3-2] HUD palette bypasses tokens (not fixed)**
- Hard-coded `slate-*`, `emerald-*`, `sky-*` values across the Mission
  Command board. Correct on the default dark theme (app defaults to dark,
  `app-client-shell.tsx:83`), but will not adapt if the light theme is
  ever used. Changing it would alter the incumbent HUD look, so it is
  flagged here as a New Pattern note, not changed.

**[P3-3] Chapter chip text at 60% opacity is borderline contrast**
- `text-primary/60` on the workflow chapter chip (page.tsx, board cards).
  Small bold uppercase text; likely near the 4.5:1 line. Flagged, not
  changed: altering it would shift the HUD's muted-chip treatment, and
  the chip is supplementary (the chapter name is not task-critical).

## Observations (no fix in this pass)

- **O1 — Footer copyright spacing.** Live footer reads "©2026SEDS Pakistan
  All Rights Reserved" (missing space). The Footer is shared across all
  pages, so fixing it here would touch every page; flagged for the lead
  instead of fixed in this lane.
- **O2 — Board dominates the first screen.** The Mission Command panel
  sits above the project grid and fills the first viewport(s). Whether
  projects should lead is a founder call; this pass does not reorder
  content (that would be a content-order change, not a design polish).
- **O3 — Live vs crawl data mismatch.** An earlier text crawl showed the
  board at 0 missions / 0% NMR; the rendered browser pass showed 23
  missions / 62%. Client-rendered data explains the gap; the rendered
  figures are the verified ones.

## Patterns

- Repeated: `text-slate-600` on dark surfaces (both board empty states).
- Repeated: motion without `motion-reduce` variants (5 spots, one fix shape).
- Repeated: interactive-looking elements without keyboard semantics (one
  div-button here; worth a site-wide grep in a later pass, out of scope).

## Positive findings (keep these)

- Loading skeletons shape-match the final cards (H29) on both pages.
- Search/category updates are deferred with `useTransition`, keeping
  keystrokes responsive.
- Progress bars use Radix semantics (`role="progressbar"` + values) on
  both pages.
- Card titles wrap cleanly, including a long Urdu title, with no clipping
  at desktop width.
- The detail guest roadmap message states what, why, and how (sign in) —
  a correct H32 pattern.
- Default dark theme matches both pages' dark styling; `prose-invert` on
  detail is correct for it.

## Fix list for this pass (13 items)

P1-1, P1-2, P1-3, P2-1, P2-2, P2-3, P2-4, P2-5, P2-6, P2-7, P2-8, P2-9,
P3-1. All are class/attribute/markup changes; no data, route, or feature
changes; no copy rewrites except the two factual empty-state lines
(P2-3 roster line, P2-7 recovery line). Recommended next command:
`$impeccable polish` after the lead's gate, then re-run `$impeccable audit`
to confirm the score moves.
