## AUDIT 17/20 — task-detail-dialog.tsx (806 lines)
- :33 TaskDetail interface: assigneeId only, no assigneeIds.
- :167 isAssignee = uid === assigneeId — THE gate; co-assignee treated as stranger. FIX: resolve ids list, includes().
- :264 handleUpdateMission, :292 handleRecallSubmission, :521 Delegate button, :617/672/719 report-tab branches — all follow from :167.
- :215-224 hydration fetches only singular; single assignee state.
- :479-493 Operator header card single avatar/name.
- :606-612 SITREP attribution singular (fine unless per-assignee reports).
FIX: one-line gate fix + hydrate array + avatar stack header.
