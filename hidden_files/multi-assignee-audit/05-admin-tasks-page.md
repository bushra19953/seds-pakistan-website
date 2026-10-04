## AUDIT 5/20 — src/app/admin/tasks/page.tsx (SMOKING GUN for Huzaifah)
- :624 handleSaveTask edit: `assigneeId: assigneeIds[0]` — PATCH sends ONLY first picked user; co-assignees SILENTLY DROPPED on save. This erased Huzaifah from Task 02 Step 1.
- :337 handleEditTask: loads only [assigneeId] into picker; existing co-assignees hidden before save.
- :382 workflow-steps fetch: maps only data.assigneeId.
- :1150-1153,1181-1182 board column renders only usersMap[task.assigneeId].
- :240 + api/tasks:1041 assignee filter: where(assigneeId==) misses array-only.
- :536-589 handleUpdateWorkflowSteps: patches everything except assignees; step reassignments discarded.
- :683-711 create splits per-assignee docs vs edit assumes arrays (architecture trap).
- Bulk ops clean.
FIXES: persist full assigneeIds on PATCH (+assigneeId primary); load existing arrays; read assigneeIds in steps fetch; +N chips on board; OR filter; include assignees in step PATCH.
