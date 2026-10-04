# Verifier FAILs (fix specs collected 2026-10-04)

## 16/20 deadline crons: PARTIAL FAIL
- (a) src/app/api/cron/remind-deadlines/route.ts:41 — `.where('reminderSent24h','!=',true)` excludes legacy docs (field missing). Fix: drop != filter, add `if (task.reminderSent24h === true) continue;` at loop top.
- (c) src/app/api/cron/check-deadlines/route.ts:106-108 — singular assigneeId only; array co-assignees never warned/penalized. Fix: resolve assigneeIds array-or-singular, wrap per-user block in for loop. Product decision: co-assignees share penalty? (default yes, each accountable).

## 17/20 team route: PARTIAL FAIL
- (c) src/app/api/tasks/route.ts PATCH swap block (~:431-490): reassignment sends no notification to the new assignee. Fix: createNotification task_assigned to newUid after validation; notify ALL newly added uids in assigneeIds (not just primary); swap detection should compare normalized arrays, not just singular assigneeId.

## 19/20 visualizer/chat sweep: 12 FAILs (follow-up batch, not edit-blockers)
Functional:
1. profile/workflow-steps-inline.tsx:155 — isYou singular; co-assignees invisible, no highlight
2. profile/assigned-tasks.tsx:191 — isYourTurn singular; co-assignees miss "Your Turn"
3. profile/assigned-tasks.tsx:596 — chat participants fallback drops co-assignees
4. profile/assigned-tasks.tsx:658 — client query assigneeId== only; co-assigned tasks missing from profile list
5. profile/team-tasks.tsx:295 — assignee filter drops co-assigned tasks
6. profile/task-history.tsx:66 — history query singular; co-assigned completions missing
7. workflows PATCH singular (already fixed by agent 1/20 in 0cabdb1)
8. task-form.tsx per-step assignee editing singular-only by design (creation gap)
Cosmetic:
9. profile/workflow-visualizer.tsx:79,187 — names only for singular
10. profile/assigned-tasks.tsx:249-261,322 — Mission Squad strip singular
11. admin/mission-command/page.tsx:191 — renders raw UID fragment
12. app/projects/page.tsx:108-111 — participants keyed by singular
