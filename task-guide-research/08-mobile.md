# Mobile Experience: Task Submission Flow

**Date:** 2026-10-05
**Scope:** `src/components/profile/assigned-tasks.tsx` (profile task list, the primary submit path),
`src/components/profile/task-detail-dialog.tsx` (task detail dialog),
`src/components/profile/optimized-profile.tsx` (profile tabs),
`src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx` (personal submit link page),
`src/app/missions/[workflowId]/page.tsx` (public mission page)

**Method:** Static code audit of responsive classes, touch targets, and layout.
Live-device rendering NOT verified (no browser access in this environment);
visual check on a real phone still recommended before shipping the guide.

---

## What works well on mobile

1. **Task cards stack correctly.** The card layout uses `flex-col lg:flex-row`,
   so on phones everything stacks vertically: title, status, action buttons.
   No side-by-side cramming.

2. **Most touch targets meet the 44px guideline.**
   - Quick action ("TRANSMIT SUCCESS"): `h-11` (44px), full-width on mobile
   - Icon buttons (edit, expand): `h-11 w-11` (44px)
   - Final submit: `h-12` (48px), full-width
   - Resource links: `min-h-[44px]`

3. **Task detail dialog fits the screen.** `w-[95vw] h-[95vh]` on mobile with
   internal scroll (`overflow-y-auto`). Content grids collapse to single
   column (`grid-cols-1 sm:grid-cols-2`).

4. **Profile tabs wrap instead of overflowing.** `TabsList` uses `flex-wrap`,
   so Mission Control / My Team / Projects / Certificates / Tickets / Orders
   wrap to multiple rows on narrow screens.

5. **Filter bar stacks.** The status/project filters use
   `flex-col sm:flex-row`, stacking vertically on phones.

6. **Text scales down.** Pervasive `text-xs sm:text-sm`-style scaling;
   long titles use `truncate` / `break-words`.

7. **Submit-link page is phone-safe.** `max-w-2xl mx-auto px-4`, buttons use
   `flex-col sm:flex-row`, file input is styled and full-width.

## What's broken or risky on mobile

### 1. Status pills are too small to tap reliably (assigned-tasks.tsx ~523)
The Standby / Active / Transmit segmented control uses `py-2` buttons,
roughly 30px tall. Apple's and Google's minimum touch target is 44px.
On a phone, tapping "Transmit" can easily misfire to a neighboring pill,
which changes the task status to the wrong value. **This is the single
riskiest element in the submit flow.**

Suggested fix: bump to `py-3` (or `min-h-[44px]`) on the pill buttons.

### 2. Hours stepper buttons are 40px (assigned-tasks.tsx ~540)
The +/- stepper uses `h-10 w-10` (40px). Close to the guideline but
slightly under; fat-finger risk is low but real. Bump to `h-11 w-11`.

### 3. Countdown timer can clip in the 3-column stat grid (assigned-tasks.tsx ~379)
On a 360px phone each stat cell is ~110px wide. The "Ends In" countdown
has `whitespace-nowrap` inside `overflow-hidden`, so a value like
"2D 4H 30M" may get cut off with no indication. Consider allowing wrap
or shrinking to `text-[10px]` on mobile.

### 4. Dialog tabs scroll invisibly (task-detail-dialog.tsx ~469)
The detail dialog's tab strip uses `overflow-x-auto no-scrollbar`.
On phones, extra tabs are reachable only by swipe, with no visual hint
they exist. Users may never find tabs off-screen. Add a fade indicator
or `scrollbar-width: thin`.

### 5. Submit-link page: Hours + Links side-by-side is tight (~submit/[stepIndex])
`grid grid-cols-2 gap-4` on a 360px screen gives each field ~160px.
Usable, but the file-upload input label ("goes straight to SEDS Drive")
wraps awkwardly. `grid-cols-1 sm:grid-cols-2` would be safer.

### 6. Confetti on submit (assigned-tasks.tsx ~283)
`canvas-confetti` fires 100 particles on every successful transmit.
Harmless on desktop; can jank on low-end Android phones. Consider
`disableForReducedMotion` or skipping on small screens. Minor.

### 7. No pull-to-refresh; stale data risk
The task list relies on Firestore `onSnapshot`. If the app is backgrounded
on a phone and resumed, the listener should reconnect, but there is no
manual refresh control if it doesn't. Users seeing stale statuses may
think a transmit failed. Low priority.

## Confusing for a phone user (UX, not layout)

- **Two submit paths exist** (profile task list AND personal `/submit/<n>`
  link) with different UIs and different button labels ("TRANSMIT FOR
  REVIEW" vs "Transmit Mission Update"). A phone user who finds one path
  may not recognize the other. The guide should pick ONE canonical path
  (recommend the profile) and mention the other only as backup.
- **Status vocabulary is inconsistent.** The filter says "STANDBY (TO DO)",
  the pill says "Standby", the badge elsewhere says "PENDING". Pick one
  word per state in the guide.
- **"TRANSMIT SUCCESS" quick action vs full form.** The card has both a
  one-tap transmit button and an expandable full update form. On a small
  screen the quick button is prominent; users may tap it thinking it
  opens the form, accidentally submitting with the default report text
  ("Objective reached. Direct Transmit."). The guide should warn about this.

## Verdict

The layout is genuinely mobile-friendly; no horizontal scrolling, no
overlapping elements, dialogs fit. The problems are touch-target sizes
(status pills, stepper) and potential confusion from dual submit paths.
Nothing here blocks a phone user from submitting, but the status pills
should be enlarged before the guide goes out, or the guide should warn
users to tap carefully.
