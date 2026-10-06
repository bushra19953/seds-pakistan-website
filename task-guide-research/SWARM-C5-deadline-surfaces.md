# SWARM C5: Deadline Display Surface Audit

Repo: ~/workspace/seds-pakistan-website, branch feat/remediation-harness-complete.
Investigation only. No code changed.

## Storage facts (ground truth)

Task deadlines live in Firestore `tasks` docs as two fields:

- `deadline` (Firestore Timestamp): the overall/task-level deadline. For workflow steps this holds the workflow's final deadline.
- `individualDeadline` (Firestore Timestamp): the per-step deadline, set only on workflow step tasks. This is the deadline a co-assignee actually works against.

Both are absolute points in time. Firestore Timestamps have no timezone, so any disagreement between surfaces comes from field choice and display conversion, never from storage.

## Surface inventory

### 1. Admin tasks table (/admin/tasks)
File: src/app/admin/tasks/page.tsx, line 1274.

- Field: `individualDeadline || deadline` (per-step first, falls back to task-level). Correct field choice.
- Conversion: client SDK `toDate()`, then date-fns `format(d, 'dd/MM/yyyy hh:mm a')` in the admin's browser timezone (PKT for the current team).
- Display: `04/10/2026 08:00 PM`. Includes date and time.

### 2. Admin edit dialog (opened from the same table)
Files: src/app/admin/tasks/page.tsx lines 340 and 389 (prefill), src/components/admin/tasks/task-form.tsx (rendering).

- Field: main deadline input is prefilled from `deadline` only (line 340); per-step inputs from `individualDeadline` (line 389).
- Conversion: **BROKEN**. Prefill does `(normalizedTask.deadline as Date).toISOString().slice(0, 16)`. `toISOString()` is UTC; the result is placed into an `<input type="datetime-local">`, which the browser interprets as LOCAL time. For a team in PKT (UTC+5) the dialog shows the deadline 5 hours EARLY relative to the table. Same pattern for step prefill at line 389.
- Display: `2026-10-05T15:00` style, no timezone label.
- Round-trip consequence: saving re-parses the shown string as local and stores it back to UTC. If the admin opens the dialog and saves without fixing the shifted time, the stored deadline moves 5 hours earlier. Repeated edits drift further.
- Note: task-form.tsx itself has a CORRECT helper (`toDatetimeLocal`, lines 282-293, converts ISO to local wall-clock) used on the AI-regenerate and recalculate paths. The bug is only in the admin page's prefill at lines 340 and 389, which bypass that helper.

This is the root cause of the reported table-vs-dialog mismatch.

### 3. Profile task list, "Your Turn" and My Tasks (assignee's main view)
File: src/components/profile/assigned-tasks.tsx, lines 714 and 388.

- Field: `deadline: safeDate(t?.individualDeadline) || safeDate(t?.deadline)` at line 714, so the normalized `task.deadline` the UI sees is per-step-first. Correct.
- Conversion: CountdownTimer (src/components/ui/countdown-timer.tsx) computes absolute milliseconds remaining, timezone independent.
- Display: live `DD:HH:MM:SS` countdown. Agrees with the table.

### 4. Profile task detail dialog
File: src/components/profile/task-detail-dialog.tsx, lines 492-494.

- Field: `individualDeadline || deadline`. Correct.
- Conversion: date-fns in browser local timezone.
- Display: `Oct 05, 2026` plus a relative distance line ("in 3 days"). Agrees with table and countdown.

### 5. Profile workflow steps inline panel
File: src/components/profile/workflow-steps-inline.tsx, lines 152 and 314-324.

- Field: `step.individualDeadline || step.deadline` (formatDeadline at line 105 handles Timestamp/Date/string). Correct.
- Conversion: CountdownTimer (absolute) plus date-fns `format(deadline, 'MMM d, yyyy h:mm a')` in browser local timezone.
- Display: countdown plus `(Oct 5, 8:00 PM)`. Agrees.

### 6. Profile workflow visualizer
File: src/components/profile/workflow-visualizer.tsx, lines 188-214 and 258-265.

- Field: steps use `task.individualDeadline || task.deadline` (line 188). Correct. The summary countdown uses `wfTasks[0]?.deadline` (task-level final deadline), which is intentional for the overall mission countdown.
- Conversion: `toLocaleDateString()` / `toLocaleTimeString()` in browser local timezone; CountdownTimer for the summary.
- Display: mixed local formats. Agrees on instants.

### 7. Public mission status page (/missions/[workflowId])
File: src/app/missions/[workflowId]/page.tsx, lines 43-50, 168, 224.

- Field: mission-level `deadline`, per-step `individualDeadline`. Correct.
- Conversion: `new Date(iso).toLocaleDateString('en-PK', { day, month, year })` in the VISITOR's timezone.
- Display: date only, e.g. `5 Oct 2026`. No time component.
- Disagreement risk: for a visitor outside PKT the rendered date can be a day off near midnight boundaries, and the missing time means the public page can never match the table's `hh:mm a` exactly. Low impact since it is informational, not actionable.

### 8. Public submit page (/missions/[workflowId]/submit/[stepIndex])
File: src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx, lines 188-200.

- Field: `task.individualDeadline || task.deadline` (line 188). Correct.
- Conversion: `toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })` in the visitor's timezone.
- Display: e.g. `5 Oct 2026, 8:00 pm`. Agrees with the table for PKT users.

### 9. Workflow directive PDF (per-step T-MINUS)
File: src/lib/workflow-pdf-export.ts, lines 633-636.

- Field: `step.individualDeadline` only. Correct.
- Conversion: `toLocaleDateString('en-PK', ...)` + `toLocaleTimeString('en-PK', ...)` in the generating machine's timezone (admin's browser, PKT in practice).
- Display: `T-MINUS: 5 Oct 2026 8:00 PM`. Agrees with the table.

### 10. Task-assigned email
Files: src/lib/mailer.ts (task_assigned template, "Target Deadline" row), src/app/api/tasks/route.ts lines 1109-1125, src/app/api/tasks/delegate/route.ts line 154.

- Field: email template renders `data.dueDate` if provided.
- Conversion: **partially broken and inconsistent**:
  - In tasks/route.ts, `dueDateStr` is computed with `new Date(deadline).toLocaleDateString('en-US', ...)` on the SERVER (Node, UTC timezone) but is NEVER passed into the email data object. Dead code. The plain task-assigned email therefore shows NO deadline at all.
  - In delegate/route.ts, `dueDate` IS passed as `format(stepDeadlines[i], 'MMM dd, yyyy')`, also formatted on the server in UTC, date only. A deadline at 12:30 AM PKT renders as the previous day.
- Display: either missing entirely or a UTC-formatted date without time.

### 11. In-app notifications and push
Files: src/app/api/tasks/route.ts (createNotification), src/lib/push-notifications.ts.

- The task_assigned notification body is `You have been assigned: "title"` with a link. No deadline is included. Nothing disagrees because nothing is shown.

### 12. Deadline warning cron and warnings
File: src/app/api/cron/check-deadlines/route.ts.

- Reads `data.individualDeadline || data.deadline` (line 69) and compares absolute milliseconds. Correct field choice, timezone independent. Warning records carry no deadline timestamp, so no display disagreement.

### 13. Penalty engine (gamification)
File: src/lib/server/gamification-transaction.ts, lines 108-131.

- Reads `deadline`, prefers `individualDeadline` when present (lines 116-122), compares `completedAt <= deadlineDate` on absolute timestamps. Timezone independent. Consistent with surfaces 1, 3, 4, 5.

### 14. WhatsApp share text (profile, assignee copies task info)
File: src/components/profile/assigned-tasks.tsx, line 411.

- Field: `task.deadline` (already normalized to individualDeadline-first at line 714). Correct.
- Conversion: `toLocaleDateString('en-PK', { day, month, year })` on the assignee's device. Date only, local timezone. Agrees within a day.

### 15. Admin workflows page step rows
File: src/app/admin/workflows/page.tsx, line 183-185.

- Field: `step.individualDeadline`. Correct.
- Conversion: `safeFormat` (date-fns, browser local).
- Display: `Oct 05, 2026`, date only. Agrees within a day.

### 16. Admin Mission Command countdown
File: src/app/admin/mission-command/page.tsx, lines 35 and 194.

- Field: mission-level `deadline`. CountdownTimer is absolute. Agrees.

### 17. Orphaned mission-card.tsx
File: src/components/profile/mission-card.tsx reads `task.deadline` ONLY (no individualDeadline fallback, lines 152-156, 247-248). Nothing imports this component, so it currently renders nowhere. If it is ever re-wired into the profile, it would disagree with every other assignee-facing surface on any workflow step whose individualDeadline differs from the final deadline.

### Universal Inbox (/admin/submissions)
Checked: the submissions inbox and email-logs render no task deadlines. No surface to audit there.

## Disagreements, ranked by assignee impact

Rank 1. Admin edit dialog vs admin table (surface 2 vs surface 1). The dialog shows the deadline 5 hours early for PKT users, and saving silently rewrites the stored deadline 5 hours earlier. This corrupts the value that every other surface and the penalty engine act on. The admin sees and acts on this directly. This is the reported bug.

Rank 2. Task-assigned email (surface 10). Plain task creation emails show NO deadline (dead dueDateStr); delegated-step emails show a UTC-formatted date without time that can be a day off. The email is often the first thing an assignee sees, so a missing or wrong deadline here sends them to work against the wrong target.

Rank 3. Public mission page (surface 7). Date-only rendering in the visitor's timezone can be a day off for viewers outside PKT and can never match the table's time. Low impact: informational, not actionable, and the primary audience is PKT-based.

Rank 4. Main deadline field in the edit dialog uses `deadline` while the table and every assignee surface use `individualDeadline || deadline`. For workflow steps these are different instants. An admin editing a step sees the workflow-final deadline in the main field while the table shows the step deadline, which reads as a second, independent mismatch on top of the UTC shift.

Rank 5. Orphaned mission-card.tsx (surface 17). Currently renders nowhere, so zero live impact, but it is a trap for the next person who wires it back in because it lacks the individualDeadline fallback every live surface has.

Everything else (profile countdowns, detail dialog, steps inline, visualizer, submit page, PDF, warning cron, penalty engine, Mission Command) agrees: they read individualDeadline-first and compare absolute instants.

## Recommended single source of truth

One rule for every read surface and every write path:

1. Field: effective deadline = `individualDeadline ?? deadline`. Never read `deadline` alone for a workflow step task. For emails and public pages the same rule applies.
2. Storage: absolute instant (Firestore Timestamp / ISO string in UTC). Unchanged from today.
3. Conversion: perform timezone rendering exactly once, at the display edge, in the viewer's local timezone, and always include the time of day next to the date. The canonical client helper is `toDate()` + date-fns `format(d, 'dd/MM/yyyy hh:mm a')` from src/lib/date-utils.ts, which every surface except the edit dialog and the server-side email formatters already uses.
4. Edit inputs: prefill `datetime-local` inputs with the LOCAL wall-clock value (the existing `toDatetimeLocal` helper in task-form.tsx does this correctly) and convert back with `new Date(localString).toISOString()` on save, which the save paths already do.
5. Server-side formatting (emails, cron messages): pin the timezone explicitly, e.g. `timeZone: 'Asia/Karachi'`, instead of relying on the Vercel Node default of UTC, and include the time.

Concretely: fix the prefill at src/app/admin/tasks/page.tsx lines 340 and 389 to use the local conversion instead of `toISOString().slice(0, 16)`; pass the already-computed dueDateStr (rendered with an explicit Asia/Karachi timezone) into the task_assigned email; and add the `individualDeadline ?? deadline` fallback to the email and notification builders. After that, the table, the dialog, the countdowns, the PDF, the emails, and the penalty engine all describe the same instant.
