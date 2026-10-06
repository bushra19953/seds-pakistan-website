# SWARM C2: Edit Dialog Deadline Rendering Trace
Investigation only, no code changes. Repo: ~/workspace/seds-pakistan-website, branch feat/remediation-harness-complete.

## 1. Which component, which field

The Edit dialog on /admin/tasks is a shadcn `Dialog` defined inline in
`src/app/admin/tasks/page.tsx` (lines ~1338-1368). Its body renders the shared
`TaskForm` component from `src/components/admin/tasks/task-form.tsx`, with:

- `initialValues.deadline` = the task's **`deadline`** field (page.tsx line 1355)
- `initialWorkflowSteps` = per-step objects whose `individualDeadlineIso`
  comes from each step doc's **`individualDeadline`** field (page.tsx lines 366-394)

The overall "Deadline" datetime-local input binds to the **`deadline`** field.
Each step card's "Override Deadline (optional)" datetime-local input
(task-form.tsx line 1031-1033) binds to that step's **`individualDeadline`** field.

## 2. Load: stored value to datetime-local input (timezone shift: YES)

Two spots in `handleEditTask` (page.tsx) do the load conversion, both identically:

- Overall deadline, line 340:
  `deadline: (normalizedTask.deadline as Date).toISOString().slice(0, 16)`
- Per-step deadline, line 369:
  `const indLocal = indDate && !isNaN(indDate.getTime()) ? indDate.toISOString().slice(0, 16) : '';`
  (indDate comes from `data.individualDeadline`, Timestamp or string or Date)

`toISOString()` renders the instant in **UTC**. The result (e.g. `2026-10-04T14:00`)
is placed into an `<input type="datetime-local">`, which the browser interprets
as **local wall-clock time** with no conversion on display. So the dialog shows
the UTC wall clock, not the local time. For a reviewer in PKT (UTC+5) the dialog
displays the deadline **5 hours earlier** than the true local time. There is no
local-time conversion anywhere on this load path. (Note: TaskForm has a correct
UTC-to-local helper, `toDatetimeLocal`, task-form.tsx line 282, but the edit
load path in page.tsx does NOT use it.)

## 3. Save: input back to stored format (inverse bug: YES, double conversion)

- Overall deadline save, `handleUpdateWorkflowSteps`, page.tsx line 563:
  `if (vals.deadline) taskUpdates.deadline = new Date(vals.deadline).toISOString();`
- Per-step deadline save, page.tsx line 580:
  `updates: { individualDeadline: new Date(s.individualDeadlineIso as string).toISOString() }`
- Non-workflow edit/create paths do the same: page.tsx lines 637, 725, 783, 824, 845.

`new Date("2026-10-04T14:00")` parses the string as **browser-local** time, then
`.toISOString()` converts to UTC. The load side showed UTC-as-local, so the save
side re-interprets that UTC wall clock as local and shifts the stored instant
**back by the UTC offset**. Net round trip on a PKT browser: every open-dialog
plus save cycle moves the stored deadline **5 hours earlier**, even if the admin
changed nothing. The API (`src/app/api/tasks/route.ts`, lines 371-374) then
normalizes the ISO string to a Date and stores a Firestore Timestamp, so the
shifted instant is persisted as ground truth.

Concrete example (PKT browser): stored deadline 2026-10-04T14:00:00Z (19:00 PKT).
Dialog input shows `2026-10-04T14:00`. Admin saves untouched. Stored becomes
2026-10-04T09:00:00Z (14:00 PKT). The deadline visibly jumps 5 hours earlier in
every surface after one edit.

## 4. Comparison with the table chain (Agent C1)

- **Same field? Mostly yes.** The table's Deadline column (page.tsx lines
  1273-1277) reads `toDate(task.individualDeadline) || toDate(task.deadline)`.
  The dialog's overall input reads `deadline`; its per-step inputs read
  `individualDeadline`. For a step row, dialog step input and table read the
  same field (`individualDeadline`). The dialog's overall input and the table
  can read different fields (`deadline` vs `individualDeadline`), which are
  genuinely different stored instants on step docs.
- **Same timezone logic? NO. This is the divergence.** The table formats with
  date-fns `format(d, 'dd/MM/yyyy hh:mm a')`, which renders in the **browser's
  local timezone** (correct local time). The dialog loads with
  `toISOString().slice(0, 16)`, which renders in **UTC** inside a
  local-interpreted input. Same stored instant, two different displayed times,
  offset by exactly the browser's UTC offset.

## 5. Additional hazard found (not the reported bug, but adjacent)

TaskForm has a `useEffect` (task-form.tsx lines 305-307) that re-runs
`recomputeDeadlines` over all steps whenever the overall deadline input changes.
`recomputeDeadlines` parses the overall input (a UTC-sliced string from the load
path) as local time and redistributes step deadlines from `now` to that instant
via `calculateWorkflowDeadlines` (src/lib/workflow-utils.ts), then writes them
back with the local-time `toDatetimeLocal`. So merely touching the overall
deadline field in the dialog silently overwrites every per-step deadline with
values derived from a mis-shifted base. If the derived final deadline is in the
past, `calculateWorkflowDeadlines` throws and the steps are left unchanged
(the catch returns steps as-is), which makes the behavior intermittent and
time-dependent.

## 6. Open question on the observed numbers

The live report said the dialog showed 2026-10-04T19:00 / 2026-10-05T15:00 while
the table showed 04/10/2026 02:00 PM, i.e. the dialog 5 hours LATER than the
table. The UTC-slice chain traced here predicts the opposite under a PKT
browser (dialog 5 hours EARLIER than the table). Possible explanations: (a) the
review browser was not in PKT (UTC-5 makes the numbers fit exactly); (b) the
table cell compared (`deadline`, overall) and the dialog input compared
(`individualDeadline`, per-step) were different fields with genuinely different
stored instants; (c) the values had already drifted through one or more
edit-save cycles (section 3). Agent C1's table-chain findings should be checked
against these to pin down which one applies.

## Files and lines (all reads, no edits)

- src/app/admin/tasks/page.tsx: 306-309 (Timestamp normalize), 340 (overall
  deadline UTC slice into formData), 366-394 (per-step individualDeadline UTC
  slice), 563 (overall save), 576-582 (per-step save), 1273-1277 (table render),
  1355 (initialValues.deadline UTC slice into TaskForm)
- src/components/admin/tasks/task-form.tsx: 282-293 (correct local helper,
  unused on edit load), 297-316 (recomputeDeadlines + effects), 1031-1038
  (per-step datetime-local input binding)
- src/lib/workflow-utils.ts: 1-15 (calculateWorkflowDeadlines)
- src/lib/date-utils.ts: 38-57 (toDate, faithful, no shift)
- src/app/api/tasks/route.ts: 371-374 (ISO string to Date to Timestamp)
