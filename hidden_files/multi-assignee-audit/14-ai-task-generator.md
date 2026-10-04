## AUDIT 14/20 — src/app/api/ai-task-generator/route.ts
- :50-57 WorkflowStep interface: assigneeUid singular, no oversight slot.
- :~186 MATCHING rule: doer-first framed as either/or vs leader.
- :~190 LEADERSHIP rule: forces leader-as-sole-assignee or extra step.
- :218-226 JSON schema: only assigneeUid.
- :176-187 sanitizeAssignees: would coerce/drop array, ignore oversightUid.
- :~198-203 points validation: no split guidance.
- Consumers: task-form.tsx:584-595 and delegate-task-dialog.tsx:220-232 map singular assigneeUid -> assigneeId.
FIX DIRECTION: add optional oversightUid to interface+schema+prompt+validation; map into step assignee set in consumers. Note api/tasks:660 semantics = separate task per assignee (decision needed: co-assignee on one task vs linked task).
SCOPE: include if clean; additive optional field.
