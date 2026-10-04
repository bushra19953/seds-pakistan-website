## Slice 18/20 DONE — re-generation clobber fix design

Root cause: task-form.tsx `generateWithAI` (~line 441) "Atomic State Updates" block unconditionally overwrites title/description/points/deadline/assigneeIds/workflowSteps on every "Generate Suggestions" click. No dirty tracking.

Fix design (client-side only, no server change):
- Add `dirtyFieldsRef` (Set<string>) + `stepsDirtyRef` (boolean) refs near useState declarations (~line 160).
- Mark dirty in each user-input handler: title Input onChange (~752) -> 'title'; description Textarea (~763) -> 'description'; points Input -> 'points'; deadline Input -> 'deadline'; handleAssigneeChange (~232) -> 'assigneeIds'; step card handlers -> stepsDirtyRef=true.
- Guarded apply in generateWithAI: only apply AI values for non-dirty fields; only setWorkflowSteps(wf) if steps not dirty.
- UX: button becomes "Regenerate Suggestions" after first gen with tooltip; "Clear my edits" text-button restores old full-overwrite behavior.

Unchanged: route.ts, buildWorkflowFromDescription, submit validation.
Verify: generate -> edit title/deadline/step assignee -> regenerate -> edits survive.
