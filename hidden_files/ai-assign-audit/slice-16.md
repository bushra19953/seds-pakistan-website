## Slice 16/20 DONE — assignee validation fix design

Key facts:
- Client generateWithAI already EXCLUDES member/none roles from the subordinates pool it sends ("tasks are only for official team"). So once demotions land as users.role=member, the AI won't see them as candidates at all.
- task-form.tsx copies assigneeUid strings with zero membership check; aiSelected:true lends false legitimacy; restrictToIds is self-referential.
- delegate-task-dialog.tsx:210 renders non-matching uids as literal "Unknown".

Fix design (proposal only):
- Server (route.ts): sanitizeAssignees(steps) after orchestrateMission, before response. Allow-set via Admin SDK: users/{uid} exists, isBanned!=true, resolved role not in {'','member','none'} (roles/{uid}.role ?? users/{uid}.role). Vacation => keep + warn. Invalid uids stripped, recorded in new droppedAssignees[] response field. Never 500.
- Client (task-form.tsx generateWithAI): accept assigneeUid only if in validUidSet built from usersChapter; merge server droppedAssignees; show setAiMessage listing removed names.
- delegate-task-dialog.tsx: same guard before accepting uid.
- Residual: server still trusts client registry as prompt input (future: rebuild server-side); task-creation API should re-validate assigneeIds on write as final gate.
