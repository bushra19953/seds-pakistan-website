## AUDIT 12/20 — src/app/api/webhooks/firestore/route.ts
- :89 deletion activity log: only assigneeIds[0] gets taskDeleted in feed. FIX: write to each assignee.
- :103 creation activity: creatorId falls back to single assigneeId, mislabels creator. FIX: creatorId = userId||createdBy only; log taskAssigned per assignee.
- :173 update activity: only first assignee gets taskUpdated. FIX: loop all.
- :182 universal submission sync: single userId owner of TASK_REVIEW. FIX: accept userIds[], keep user_id primary.
- CLEARED: creation notification fan-out (109-124), completion rewards (146-166), handleRoleWritten, handleNotificationPush.
