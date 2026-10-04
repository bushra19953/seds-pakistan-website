## AUDIT 20/20 — grep sweep (20 stragglers)
SERVER breaks:
- api/cron/check-deadlines:106,163,174,192: overdue cron singular assigneeId; penalty/notifications to one user.
- api/tasks/[taskId]/activity:127,141,149: rejection feedback only to singular assigneeId.
- api/tasks/delegate:41: co-assignee gets 403 delegating own step. :72-110 delegation builds from singular.
- api/tasks/team:101: team board where(assigneeId in) misses array-only members.
- api/tasks/batch:73-74: batch delete decrements counter for singular only.
- api/admin/users/restore-workload:49,60: vacation-restore clobbers co-assignees.
- lib/task-management.ts:111 getUserTasks where(assigneeId==) misses co-assigned.
CLIENT breaks:
- profile/assigned-tasks:191 isYourTurn singular; :658 profile list singular query; :596 chat participants fallback singular.
- profile/workflow-steps-inline:155,213,261 isYou gates vs singular.
- profile/task-history:66 singular query. profile/team-tasks:295 filter drops co-assigned.
- admin/tasks/task-form:270,276,440,466,591,605,1046: one assigneeId per workflow step; CLOBBERS multi-assignee steps to one on save.
COSMETIC: workflow-visualizer, team-tasks sub-steps, projects page, mission-command Lead, generic-inspector.
SYSTEMIC: two parallel models; fix = getAssigneeIds(task) normalization helper + array-contains companion queries.
