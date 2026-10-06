# SWARM C3: Deadline Field Audit

Branch: feat/remediation-harness-complete. Investigation only, no code changed.

## TL;DR

For workflow-step tasks (like the three Task 02 steps), a task document carries TWO
deadline fields that are intentionally different:

* `task.deadline` = the workflow's FINAL deadline (same value on every step task).
* `task.individualDeadline` = this step's own deadline (computed per step at workflow
  creation, or set explicitly in the admin workflow editor).

The admin tasks TABLE shows `individualDeadline || deadline` (per-step value, local
time). The admin EDIT DIALOG prefills its deadline input from `task.deadline` ONLY
(the final workflow deadline), rendered via `toISOString().slice(0,16)` which is
UTC pushed into a datetime-local input (a second, timezone, discrepancy). So yes:
the table reads field X while the dialog reads field Y, and the dialog additionally
mishandles timezone. That exactly explains the reported mismatch (dialog showed
2026-10-04T19:00 / 2026-10-05T15:00 while the table showed 04/10/2026 02:00 PM).

## 1. Every deadline-like field, where set, by which code path

### On the `tasks` collection document

| Field | Meaning | Set by |
|---|---|---|
| `deadline` | Legacy/global deadline. For workflow steps it is the workflow FINAL deadline, identical on every step task. | Task create: `POST /api/tasks` (src/app/api/tasks/route.ts). Workflow create: `POST /api/workflows` sets `deadline: finalDeadline` (src/app/api/workflows/route.ts:216). Delegate: `POST /api/tasks/delegate` sets `deadline: finalDeadline` (src/app/api/tasks/delegate/route.ts:112). Deadline edit: admin tasks page `taskUpdates.deadline` (src/app/admin/tasks/page.tsx ~line 565) -> `PATCH /api/tasks`. |
| `individualDeadline` | Per-step deadline for workflow steps. More specific than `deadline`. | Workflow create: `individualDeadline` per step; explicit `step.individualDeadline` wins, else `deadlines[i]` from `calculateWorkflowDeadlines(finalDeadline, steps.length)` (src/lib/workflow-utils.ts), which spreads deadlines across steps. Workflow editor (admin tasks page): per-step editor writes `updates: { individualDeadline: ... }` for each changed step (src/app/admin/tasks/page.tsx ~line 576-591). Delegate: `individualDeadline: stepDeadlines[i] \|\| finalDeadline` (delegate/route.ts:113). Task form (task-form.tsx): per-step `individualDeadlineIso` -> `individualDeadline` on workflow create payload (src/app/admin/tasks/page.tsx ~line 824). PATCH schema accepts both fields (src/app/api/tasks/route.ts:270,907). |

### On the `workflows` collection document

The workflows collection does not store per-step deadline fields directly on the doc;
the step tasks in `tasks` are the carriers. The public missions API reads the workflow
doc's own `deadline` field plus `firstTask?.deadline` as the workflow-level deadline
(src/app/api/missions/[workflowId]/route.ts:54,154).

## 2. Which consumer reads which field (source of truth per consumer)

For workflow-step tasks the intended source of truth is `individualDeadline`,
falling back to `deadline`. Consumers are inconsistent:

| Consumer | Reads | Verdict |
|---|---|---|
| Penalty engine (`src/lib/server/gamification-transaction.ts:108-123`) | `deadline` first, then overrides with `individualDeadline` if present | Correct (individual wins) |
| Check-deadlines cron / admin "Check Deadlines" (`src/app/api/cron/check-deadlines/route.ts:68-69`) | `data.individualDeadline \|\| data.deadline` | Correct |
| Overdue cron (`src/app/api/cron/overdue/route.ts:26`) | `where('individualDeadline', '<', now)` ONLY | Wrong for plain tasks: a non-workflow task with only `deadline` is never marked overdue by this cron. Also marks `submitted-for-review` tasks overdue (only excludes completed/overdue). |
| Admin tasks TABLE, deadline column and overdue badge (`src/app/admin/tasks/page.tsx:1251,1275`) | `toDate(task.individualDeadline) \|\| toDate(task.deadline)`, formatted local `dd/MM/yyyy hh:mm a` | Correct |
| Admin EDIT DIALOG top-level deadline prefill (`src/app/admin/tasks/page.tsx` handleEditTask, `formData.deadline`) | `normalizedTask.deadline` ONLY (not individualDeadline), via `(normalizedTask.deadline as Date).toISOString().slice(0,16)` | WRONG FIELD + WRONG TZ: shows the final workflow deadline, and the UTC ISO string is pasted into a datetime-local input that the browser reads as local time (5h shift for PKT). |
| Admin EDIT DIALOG per-step deadline editor | `individualDeadlineIso` from `task.individualDeadline`, `indDate.toISOString().slice(0,16)` (src/app/admin/tasks/page.tsx:368-372) | Correct field, but same UTC-into-datetime-local timezone bug as above. |
| Profile assigned-tasks normalization (`src/components/profile/assigned-tasks.tsx:714`) | `safeDate(t?.individualDeadline) \|\| safeDate(t?.deadline)`, then everything downstream (countdown, groups) uses the merged `task.deadline` | Correct (merged) |
| Profile raw overdue flag (`assigned-tasks.tsx:195`) and priority score (`assigned-tasks.tsx:752`) | `task.deadline` directly (not individualDeadline) | Only correct because of the line-714 merge; a direct Firestore read without that merge would be wrong for workflow steps. Fragile: depends on the normalization running first. |
| Task detail dialog, profile (`src/components/profile/task-detail-dialog.tsx:492,494`) | `displayTask.individualDeadline \|\| displayTask.deadline` | Correct |
| Review queue API (`src/app/api/tasks/review-queue/route.ts:121`) | `task.individualDeadline ?? task.deadline` | Correct |
| Team tasks (assigner side, `src/components/profile/team-tasks.tsx:528,620`) | `task.deadline` only | Unknown whether team-tasks normalizes first; if it reads raw task docs, workflow-step deadlines are wrong (shows final deadline instead of step deadline). Needs a Group F check. |
| Workflow visualizer (`src/components/profile/workflow-visualizer.tsx:188`) | `task.individualDeadline \|\| task.deadline` | Correct |
| Workflow steps inline (`src/components/profile/workflow-steps-inline.tsx:152`) | `step.individualDeadline \|\| step.deadline` | Correct |
| Public mission status page API (`src/app/api/missions/[workflowId]/route.ts:54`, `submit/[stepIndex]/route.ts:101`) | `task.deadline` ONLY (per step), workflow-level `firstTask?.deadline` | WRONG FIELD: the public page shows the workflow final deadline for every step instead of each step's `individualDeadline`. |
| Workflow PDF export (`src/lib/workflow-pdf-export.ts`) | greps clean; check export code for which field is printed | Not deadline-reading in the grepped section; verify during PDF regen tests. |

## 3. Answer: same field with different timezone, or different fields?

BOTH problems exist, stacked:

1. **Different fields.** Table = `individualDeadline || deadline`. Edit-dialog main
   deadline field = `task.deadline` only. On Task 02 steps these differ by design
   (`deadline` = final deadline Oct 5 8:00 PM-ish; `individualDeadline` = per-step).
   The dialog's top-level "Deadline" input therefore edits and displays the WRONG
   field for workflow steps; it is also the field the main edit save writes
   (`taskUpdates.deadline`), so saving from the dialog silently overwrites the
   global/fallback deadline without touching the per-step deadline the table shows.
   The per-step deadline editor in the same dialog writes the right field.

2. **Different timezone handling.** The table formats with `date-fns format(d,
   'dd/MM/yyyy hh:mm a')` in the browser's local timezone (correct for PKT users).
   The dialog prefill does `date.toISOString().slice(0,16)`, producing a UTC string
   that a `datetime-local` input interprets as LOCAL time. For a PKT admin this
   shifts the displayed time by 5 hours (and on save, `new Date(localString)`
   re-interprets it as local, shifting it back or double-shifting depending on the
   path). `task-form.tsx` has a correct `toDatetimeLocal` helper (local components,
   no UTC) used for the AI-generated per-step deadlines, but `page.tsx`'s prefill
   code does not use it.

## 4. Concrete bugs found (for the fix swarm)

1. `src/app/admin/tasks/page.tsx` handleEditTask: prefill `formData.deadline` from
   `task.individualDeadline || task.deadline`, and use local-time formatting
   (reuse the `toDatetimeLocal` helper from task-form.tsx) instead of
   `toISOString().slice(0,16)`.
2. Same file, per-step `individualDeadlineIso` prefill: switch
   `indDate.toISOString().slice(0,16)` to local-time formatting (same helper).
3. `src/app/api/cron/overdue/route.ts:26`: query only covers `individualDeadline`;
   plain tasks with only `deadline` never become overdue. Options: second query for
   `deadline < now` where `individualDeadline` is absent, or a scheduled migration
   to backfill `individualDeadline = deadline` on legacy tasks.
4. `src/app/api/missions/[workflowId]/route.ts:54` and
   `submit/[stepIndex]/route.ts:101`: per-step public deadline should be
   `individualDeadline || deadline` so the public status page shows real step
   deadlines.
5. Audit `src/components/profile/team-tasks.tsx:528,620` (raw `task.deadline`):
   confirm whether its data source is normalized first; if not, switch to
   `individualDeadline || deadline`.

## 5. Suggested source-of-truth rule (for the remediation harness)

For any read of "a task's deadline", the canonical expression is:

```
const effectiveDeadline = task.individualDeadline || task.deadline;
```

with local-timezone formatting for display and local-timezone datetime-local
values for editing. Every consumer above marked "Correct" already follows this;
the fix list is the set of consumers that do not.
