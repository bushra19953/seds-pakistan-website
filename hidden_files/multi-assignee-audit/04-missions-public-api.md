## AUDIT 4/20 — src/app/api/missions/[workflowId]/route.ts (public mission API)
- F1 (line 57): projection drops assigneeIds array; only singular assigneeId projected.
- F2 (line 66): uniqueAssigneeIds collects only t.assigneeId; co-assignees never resolved.
- F3 (lines 123-124): public payload exposes one assigneeName/assigneeChapter per step.
- F4 (lines 111,113): totalSteps/progress count task docs; multi-assignee creation splits one doc per assignee -> inflated counts, duplicated step titles, isCompleted needs both copies. FIX: dedupe by sequenceIndex, merge assignee lists.
- F5: contact masking safe (no leak). F6: N/A (public route).
FIXES: normalize assigneeIds array in projection; flatMap for resolution; emit assignees[] keeping singulars as fallback.
