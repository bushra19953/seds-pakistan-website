## Slice 08/20 DONE — per-step assignee application logic

- Zero uid-to-user resolution anywhere: task-form.tsx:582 copies any string; route.ts validates points only; "validation" is prompt wording.
- Unresolvable uid: user-selection-combobox.tsx:158 -> null -> "Select a user" placeholder (line 199), BUT assigneeId stays set so submit guard (398-403, non-emptiness only) passes. Task submittable with assignee resolving to nobody.
- Eman Shah divergence explained: storage independent by design (WorkflowStep.assigneeId vs main assigneeIds); main derived as union of per-step uids on generation (590-602); UI intends per-step subset-of-main via restrictToIds (1007) but it's dropdown-filter only. Removing Eman from main assignees cascades NOTHING to steps; combobox 170-172 deliberately keeps stale selection visible. Submit validation doesn't check subset membership. Real consistency gap, not intended.
- Regeneration: setWorkflowSteps(wf) full replacement (609) with fresh ids (wfstep_Date.now) — merge structurally impossible; manual per-step edits destroyed.
- Fixes: (1) server-side validate assigneeUid, drop/flag unknown; (2) on main-assignee removal, clear/re-prompt orphaned per-step assignees; (3) merge-on-regenerate with stable step identity, or preserve manual overrides.
