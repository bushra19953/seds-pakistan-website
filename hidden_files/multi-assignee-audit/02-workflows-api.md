## AUDIT 2/20 — src/app/api/workflows/route.ts GET
- :384 uniqueAssigneeIds singular only -> co-assignee UIDs never fetched (no name/photo/role).
- :445-455 tasksWithNames resolves only singular; co-assignees get zero enrichment.
- :464 isParticipant misses array-only assignees -> contacts masked for them on own steps.
- :490 participantCount undercounts.
- :315 (list branch) participants set ignores arrays -> (a) member undercount, (b) CRITICAL: visibility filter ~:345 hides whole workflow from array-only co-assignees.
- Adjacent: POST schema :44 and PATCH :522 accept only singular assigneeId; multi-assignee steps enter via /api/tasks.
FIXES: flatten both fields everywhere; resolve assignees[] keeping singulars as first-id fallback; union arrays into participants set.
