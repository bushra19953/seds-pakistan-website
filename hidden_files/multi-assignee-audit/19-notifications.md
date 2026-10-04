## AUDIT 19/20 — notifications
- tasks/route.ts:413 reassignment: no notification to new assignee at all.
- gamification:90 nextStepAssignee singular -> co-assignees miss "Your Turn!".
- tasks/delegate:41 403 for co-assignee; :72-121 fan-out singular.
- check-deadlines:106-108,174,192 singular; remind-deadlines GOOD (array-aware).
- webhooks:89,102,173,182 review sync to assigneeIds[0].
- workflows POST :44/:114/:158/:194 + PATCH :522 strictly singular assigneeId.
- CRITICAL FLAG: browser Step-1 edit went through singular-only PATCH -> co-assignee likely did NOT persist (400 or collapse). VERIFY on /admin/workflows before PDF regen.
