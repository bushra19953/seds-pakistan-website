# Tasks Ecosystem — System Architecture Document (SAD)

## Purpose
Establish a complete understanding of the current Tasks system (admin creation, performer execution, completion → rewards), its dependencies, and all known failure points with exact code references. This document is the prerequisite for Phase 2 hardening and Phase 3 verification.

## Lifecycle Traces

### Assigner (Admin) Journey
- Admin page: `src/app/admin/tasks/page.tsx:45–100, 182–227, 229–247`
  - Fetches tasks via server-side query parameters (`status`, `assigneeId`, `limit`, `cursor`).
  - Opens dialog to create/edit tasks and manages optimistic updates.
- Task creation (UI → API): `src/app/admin/tasks/page.tsx:476–539`
  - Sends POST to `/api/tasks` with normalized ISO deadlines, batch per `assigneeId`.
- Workflow creation: `src/app/admin/tasks/page.tsx:553–611`
  - Creates chained tasks with `workflowId`, `sequenceIndex`, `dependsOnTaskId`, first step `releasedAt`.
- API create handler: `src/app/api/tasks/route.ts:336–507`
  - Auth + admin role enforcement (`manageTasks`/role check) at `367–387`.
  - Zod validation: `389–411` (title, description, points≥0, deadline required; at least one assignee).
  - Normalizes deadline: `419–431`.
  - Creates one doc per assignee: `455–483`; user counters increment: `481–487`; project counters: `489–495`.

### Performer (Member) Journey
- Task view page: `src/app/tasks/[taskId]/page.tsx` (loads, access control, PATCH status/report via API).
- Aggregated dashboard data: `src/app/api/profile/[userId]/route.ts:86–104, 127–145`
  - Returns `profile`, `projects`, `badges`, `chapter`, `certificates`, `warnings`, `tasks` with `sectionStatuses` and caching.
  - Auth: dev bypass (lines `29–50`); production requires token (`37–50`).

### Completion → Rewards Journey
- Admin approves completion (UI): `src/app/admin/tasks/page.tsx:330–361`
  - PATCH `/api/tasks` → `{ updates: { status: 'completed' } }`.
- API update handler: `src/app/api/tasks/route.ts:101–307`
  - Auth: `108–112`; role/claims check: `115–132, 174–179` (admins only set completed).
  - Normalizes deadline: `162–171`; stamps `updatedAt`: `181–183`.
  - Batch update (`185–187`); transition detection: `189–191`.
  - On first `completed`:
    - Stamp `completedAt`: `203–205`.
    - On-time calc: `206–221` versus deadline.
    - Resolve assignees: `222–226` (supports `assigneeIds` or `assigneeId`).
    - Points award via atomic increments: `227–241, 242–243`.
    - Optional badge award: `244–251` via `arrayUnion`.
    - Project completed counter: `255–264`.
    - Next workflow step release: `266–288` (sequenceIndex+1).

### Cloud Functions
- Logging (activity feed):
  - `functions/src/index.ts:23–39, 41–57, 59–75` (`onTaskCreated/Updated/Deleted`).
- Badge auto-award on points increase:
  - `functions/src/index.ts:77–119` (`onUserUpdatedAwardBadges`).
- Role denormalization:
  - `functions/src/index.ts:121–159` (`onRoleChangedSyncToUser`).
- Leaderboard aggregation:
  - `functions/src/index.ts:221–328` (`onLeaderboardAggregate`); cache update: `330–377`.

## Dependency Map (Mermaid)

```mermaid
graph TD
  AdminUI[/admin/tasks] -->|POST/PATCH/GET| APITasks[/api/tasks]
  AdminUI -->|GET aggregated| APIProfile[/api/profile/{uid}]
  APITasks -->|write/read| Tasks[tasks]
  APITasks --> Users[users]
  APITasks --> Projects[projects]
  APITasks --> Badges[badges]
  APIProfile --> Users
  APIProfile --> Tasks
  APIProfile --> Projects
  APIProfile --> Badges
  APIProfile --> Certificates[certificates]
  APIProfile --> Warnings[users/{uid}/warnings]

  Tasks --> CF_Create[onTaskCreated]
  Tasks --> CF_Update[onTaskUpdated]
  Tasks --> CF_Delete[onTaskDeleted]
  Users --> CF_Badge[onUserUpdatedAwardBadges]
  Users --> CF_RoleSync[onRoleChangedSyncToUser]
  Users --> LeaderboardCache[cache/leaderboard]
  CF_Aggregate[onLeaderboardAggregate] --> Users
```

## Failure Points (Located) & Recommendations

1) Atomicity (points + badges awarding)
- Current: API update uses batch increments and arrayUnion (`src/app/api/tasks/route.ts:227–251`). Not a single Firestore Transaction; cross-document writes may partially succeed on failure.
- Recommendation: Move awarding logic to a Cloud Function triggered on status change and wrap in a Firestore Transaction (read points, ledger check, write points, write badges, mark rewardApplied). Idempotency via `users/{uid}/rewards/{taskId}`.

2) Race conditions on rapid completions
- Current: increments per assignee in batch (`231–241`) reduce risk but still susceptible under parallel approvals.
- Recommendation: Transactional CF with `rewardApplied` guard; per-task reward ledger.

3) Server-side pagination enforcement
- Admin page uses server params and cursors (`182–227`, `721–749`), but ensure strict server-side filtering/sorting in API (`542–580`) and avoid any client mass filtering.
- Recommendation: Keep `/api/tasks` as single source; do not fetch all tasks client-side.

4) Input validation gaps
- Create schema enforces many constraints (`389–411`) but deadline normalization still allows missing (`429–431` early return ok). Confirm points cannot be negative (already `393`). Ensure future deadline check (add). Ensure valid `assigneeId(s)` existence.

5) Optimistic UI feedback
- Admin save already optimistic (`411–551`), but performer side should optimistically mark completed with rollback on error.
- Recommendation: Add optimistic handlers to member task components and clear error toasts.

6) Graceful degradation in aggregated profile
- Profile API has section-wise try/catch with `sectionStatuses` and caching (`86–104`, `127–145`, many sections). Ensure cache invalidation after PATCH (implemented in profile PATCH: `565`).

7) CF logging and auditability
- CFs log, but reward path currently in API handler. Move rewards to CF and log transaction scope with task/user IDs.

## Data Model Overview
- `tasks`: { title, description, assignerId, assigneeId/assigneeIds, workflowId, sequenceIndex, dependsOnTaskId, deadline, status, points, projectId, completionBadgeId, createdAt, updatedAt, completedAt, releasedAt }
- `users`: { displayName, points, badges[], tasksAssignedCount, tasksCompletedCount, tasksCompletedOnTimeCount, lastTaskAssignedAt, lastTaskCompletedAt, whatsappNumber }
- `projects`: { taskCount, taskCompletedCount, updatedAt }
- `badges`: { slug, name, imageUrl, pointsRequired, isActive }
- `cache/leaderboard`: { lastUpdated, invalidatedUser }
- `users/{uid}/notifications`: ephemeral completion notifications (to be added).
- `users/{uid}/rewards/{taskId}`: ledger for idempotency (to be added).

## Recommendations Summary
- Backend: transactional CF for rewards + idempotency + comprehensive logging.
- Admin UX: strict server-side pagination/filter; async AI with error handling.
- Performer UX: single aggregated fetch; optimistic completion + real-time notifications.
- Rules: ensure read/write security aligns with admin/assignee roles.

## Next Steps
- Approve SAD.
- Execute Phase 2 hardening per this document and verify per Phase 3 test suites.

