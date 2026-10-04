## AUDIT 3/20 — public mission page (page.tsx + api route)
- API route:57: drops assigneeIds array. route:66: uniqueAssigneeIds singular only. route:123-124: singular assigneeName/assigneeChapter in payload.
- page.tsx:15-18: MissionStep interface singular only. page.tsx:183-192: "Assigned:" row renders one person.
- Submit route already handles assigneeIds correctly (59-61).
- Progress attribution step-based, unaffected. Sanitization safe for arrays.
FIXES: normalize assigneeIds in API; emit assignees[] (keep singulars as first-assignee fallback); extend MissionStep interface; render chips list.
