# SWARM C4: Deadline Save Path Trace (Investigation Only, No Code Changes)

Branch: feat/remediation-harness-complete
Repo: ~/workspace/seds-pakistan-website
Date of investigation: 2026-10-06

## 1. The save path, end to end

When an admin clicks Edit on /admin/tasks and saves, the flow is:

1. `handleEditTask(taskId)` in `src/app/admin/tasks/page.tsx` (around line 302) loads the task and prefills the edit form.
2. On submit, `handleUpdateWorkflowSteps(vals, steps)` (line 541) runs for workflow step tasks, or `handleSaveTask(values)` (line 600) for plain tasks.
3. Both send `PATCH /api/tasks` with body `{ taskId, updates }`.
4. `PATCH /api/tasks` (src/app/api/tasks/route.ts, line 822, common handler line 206) normalizes and writes to Firestore.

No workflow endpoint is involved for Task 02 step edits. It is always PATCH /api/tasks.

## 2. The datetime conversion chain

### Save conversion (client side)

All three save handlers do the same thing:

- `handleUpdateWorkflowSteps`, line 563:
  `if (vals.deadline) taskUpdates.deadline = new Date(vals.deadline).toISOString();`
- Step-level override, line ~579:
  `updates: { individualDeadline: new Date(s.individualDeadlineIso as string).toISOString() }`
- `handleSaveTask`, line ~637:
  `deadline: new Date(deadline).toISOString(),  // comment in code: "Send deadline as ISO string; server converts to timestamp"`

`vals.deadline` is the raw `datetime-local` input string, e.g. `"2026-10-05T20:00"` (no timezone). `new Date("2026-10-05T20:00")` parses it as **browser-local time**. `.toISOString()` then converts to UTC. So for an admin whose browser is in PKT (UTC+5), typing 2026-10-05 20:00 stores `"2026-10-05T15:00:00.000Z"`. That is correct behavior: the stored instant is 20:00 PKT. There is no shift on a first clean save from a PKT browser.

### Server side (PATCH /api/tasks)

- `deadline` (string) is converted to a `Date` and stored as a Firestore Timestamp (route.ts lines 371-376).
- `individualDeadline` is NOT normalized by the PATCH handler. It is stored verbatim as whatever string the client sent, e.g. `"2026-10-05T15:00:00.000Z"`. So a task doc can hold `deadline` as a Timestamp and `individualDeadline` as a string. Both parse to the same instant via `toDate()`.

### Display conversion (this is where it breaks)

The table and the dialog disagree because they render the stored instant differently:

- Table (`src/app/admin/tasks/page.tsx`, around line 1273): `format(toDate(task.individualDeadline) || toDate(task.deadline), 'dd/MM/yyyy hh:mm a')`. date-fns `format` renders in **browser-local** time. Correct for a PKT browser. Note it prefers `individualDeadline` over `deadline`.
- Edit dialog prefill, TWO places, both buggy:
  - Line 340 (handleEditTask): `deadline: (normalizedTask.deadline as Date).toISOString().slice(0, 16)`
  - Line 1355 (TaskForm initialValues): `deadline: editingTask.deadline ? new Date(editingTask.deadline as any).toISOString().slice(0, 16) : ''`

  `.toISOString()` is UTC. Slicing it into a `datetime-local` input shows the **UTC wall-clock time as if it were local time**. For a PKT browser this is always 5 hours behind the true local time. The dialog shows only the main `deadline` field, never `individualDeadline`.

So even with a perfectly stored deadline, the dialog shows a time 5 hours earlier than the table. That is a pure display bug, present since the initial commit (both lines predate the October fixes).

## 3. The re-save corruption cycle

Because the dialog displays UTC-as-local, opening the dialog and pressing Save with no changes corrupts the data:

1. Stored instant T (say Oct 5 15:00Z = 20:00 PKT, correct).
2. Dialog shows `"2026-10-05T15:00"` (UTC slice).
3. Save: `new Date("2026-10-05T15:00")` parsed as browser-local (15:00 PKT) -> `toISOString()` = Oct 5 10:00Z.
4. New stored instant = T minus 5 hours.

Every open-and-save round trip with no edits shifts the stored deadline exactly 5 hours earlier (for a PKT browser). The dialog then shows a value 5 hours earlier than before, inviting another "correction".

## 4. Reconstruction against the observed values

Observed (Oct 6 review): table shows `04/10/2026 02:00 PM`; Print Production dialog shows `2026-10-04T19:00`; Audit dialog shows `2026-10-05T15:00`. Assumed admin browser in PKT (UTC+5).

### Audit dialog `2026-10-05T15:00`

Dialog shows UTC wall time, so stored instant = Oct 5 15:00Z = Oct 5 20:00 PKT. This is exactly the intended deadline. Two histories produce it:

- (a) The removed Oct 4 migration stored the verbatim string `"2026-10-05T20:00:00+05:00"` (see section 5) and this step was never re-saved through the dialog afterward. Dialog: `new Date("2026-10-05T20:00:00+05:00").toISOString().slice(0,16)` = `"2026-10-05T15:00"`. Exact match.
- (b) One clean dialog save from a PKT browser with the admin typing `2026-10-05T20:00`: `new Date("2026-10-05T20:00").toISOString()` = `"2026-10-05T15:00:00.000Z"`. Same stored instant.

Both are consistent. The Audit step's stored value is correct; only the dialog display is misleading (shows 15:00 instead of 20:00).

### Print Production dialog `2026-10-04T19:00`

Stored instant = Oct 4 19:00Z = Oct 5 00:00 PKT. Starting from the correct Oct 5 15:00Z value, the re-save cycle in section 3 produces this in exactly 4 no-change round trips:

- Oct 5 15:00Z -> dialog `2026-10-05T15:00` -> save -> Oct 5 10:00Z
- -> dialog `2026-10-05T10:00` -> save -> Oct 5 05:00Z
- -> dialog `2026-10-05T05:00` -> save -> Oct 5 00:00Z
- -> dialog `2026-10-05T00:00` -> save -> Oct 4 19:00Z -> dialog `2026-10-04T19:00`

Equivalently, manual edits typed while looking at the shifted display produce the same result. Either way, the mechanism is the UTC-slice prefill feeding back into the local-parse save. I cannot determine from code alone how many round trips actually happened; the arithmetic shows the observed value is reachable purely through this cycle.

### Table `04/10/2026 02:00 PM`

Table renders browser-local, so this is instant Oct 4 09:00Z = 14:00 PKT. Two compounding facts explain a table/dialog split on the same task:

- The table prefers `individualDeadline`; the dialog shows only `deadline`. If anyone edited the main deadline field without touching the per-step override (or vice versa), the two fields diverge and the two views show different times. This divergence alone explains disagreement with zero corruption.
- From the correct Oct 5 15:00Z, Oct 4 09:00Z is 30 hours earlier = 6 re-save cycles, or one manual edit typed against a shifted display.

Note: I could not verify which table row the `04/10/2026 02:00 PM` reading came from (Task 02 step vs another task); the conversion chain above applies to any row.

### Summary table (admin typed 2026-10-05 20:00 intending PKT)

| Conversion hypothesis | Stored value | Table (PKT browser) | Dialog prefill |
|---|---|---|---|
| Correct: local parse then toISOString (actual save path) | Oct 5 15:00Z | 05/10/2026 08:00 PM | 2026-10-05T15:00 |
| Migration verbatim string (removed Oct 4) | "2026-10-05T20:00:00+05:00" | 05/10/2026 08:00 PM | 2026-10-05T15:00 |
| After N no-change re-saves (display bug feedback) | Oct 5 15:00Z minus 5h x N | shifts 5h earlier per cycle | shifts 5h earlier per cycle |
| N=4 | Oct 4 19:00Z | 05/10/2026 12:00 AM | 2026-10-04T19:00 |

The observed Audit value matches the "correct save / migration, never re-saved" row. The observed Print Production dialog value matches the N=4 re-save row exactly.

## 5. Git history: deadline-related commits and migrations

Relevant commits (all by the remediation agent, Oct 4):

- `28d3aab` Automatic deadline penalty deduction engine: computes lateness from stored deadlines; does not rewrite deadlines.
- `42b4df9` / `4c42f21` feat: Task 02 deadline updater migration with UI. Created `POST /api/admin/migrations/update-task02-deadlines`, which wrote the POSTed ISO string **verbatim** into both `deadline` and `individualDeadline` of all 3 Task 02 step tasks. The bundled UI defaulted the input to `2026-10-05T20:00:00+05:00`.
- `cb1e19e` revert: removed the migration route (Oct 4 12:04).
- `592ae24` revert: removed the /admin/migrations page; `3ada623` removed the dashboard link.
- `350c013` feat: deterministic Task 02 recreation migration: preserved all existing deadlines ("all other fields (titles, descriptions, deadlines, points) preserved"); did not set or shift them.
- `0cabdb1` fix: workflow step edits no longer 400 and persist co-assignees: made the workflow-edit save path actually persist (previously every workflow step edit failed with 400). It did not change the deadline conversion; the `new Date(...).toISOString()` client conversion and the UTC-slice dialog prefill both predate it.

So: yes, a migration rewrote Task 02 deadlines (the Oct 4 deadline updater, since reverted and deleted after it ran). It stored the string with an explicit +05:00 offset, which is unambiguous and correct. No later migration touched deadlines. The Task 02 recreation preserved them.

## 6. Root cause statement

There are two distinct defects, and the observed inconsistency needs both:

1. **Display bug (primary):** the edit dialog prefills the `datetime-local` input with `toISOString().slice(0, 16)` (page.tsx lines 340 and 1355), showing UTC as if local. For PKT this is always 5 hours behind the table, which renders correctly in local time. This makes a correct deadline look wrong in the dialog.
2. **Feedback corruption (consequence):** saving from that mislabeled dialog reinterprets the UTC wall time as local time (`new Date(vals.deadline).toISOString()`, line 563), shifting the stored instant 5 hours earlier per save. Repeated "corrections" walk the deadline backward in exact 5-hour steps. The observed `2026-10-04T19:00` dialog value is exactly 4 such steps from the correct value.
3. **Field split (contributor):** the table renders `individualDeadline` first while the dialog edits/shows `deadline`; the PATCH handler normalizes `deadline` to a Timestamp but stores `individualDeadline` as a raw string. Editing one without the other makes the two views disagree with no corruption at all.

## 7. Open questions for other agents / the admin

- How many times each Task 02 step was re-saved through the dialog after Oct 4 (determines whether Print Production's value came from the re-save cycle vs a manual edit). The code alone cannot answer this; Firestore `updatedAt` / audit log could.
- Which table row the `04/10/2026 02:00 PM` reading came from, and whether that row's `individualDeadline` differs from its `deadline`.
- The admin browser's actual timezone (assumed PKT throughout; a UTC browser would make the dialog display correct and the table wrong, which contradicts the observed table value being the "sane" one).
