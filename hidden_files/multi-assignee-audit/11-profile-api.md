## AUDIT 11/20 — src/app/api/profile/[userId]/route.ts
FINDING: tasks query either/or instead of union (lines 122-125). Fetches by assigneeId==uid; only if empty falls back to assigneeIds array-contains. Co-assignee with any primary task never sees co-assigned tasks on profile.
FIX: run both queries in parallel, union by doc id, dedupe, cap 100.
NOTE: tasksAssignedCount denormalized counter — writers must bump every id in assigneeIds.
