## AUDIT 16/20 — src/app/admin/workflows/page.tsx
- :56-67 WorkflowStep interface singular only; no assignees array type.
- :155-177 WorkflowStepRow renders only step.assigneeName + singular contacts.
- :250-262 PDF photo pre-processing: only primary assigneePhoto -> base64.
- :276-295 PDF export payload mapping: only singular fields forwarded (THIS is why Huzaifah never appeared in the Task 02 PDF).
- :341 member count from participants <- API uniqueAssigneeIds singular-only (root cause in API).
FIXES: add assignees to interface; iterate in row render; loop photo prep; pass assignees to exporter; API unions arrays.
