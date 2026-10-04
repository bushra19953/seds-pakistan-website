## AUDIT 13/20 — delegate-task-dialog.tsx + api/tasks/delegate/route.ts
DIALOG (7): :57-64 interface singular; :213-233 AI handling drops arrays; :249-257 launch guard false-block; :268-276 payload drops co-assignees; :509-514 single-select picker; :546 review row singular; :561 manual step seeds singular. :432 workload display already correct.
BACKEND (5): :72 subIds singular -> missing userDetails; :79 participantIds singular -> co-assignees fail participant gates; :81,87 sub-task doc singular owner; :105,110 counter+notification singular; :121 email singular.
Adjacent: workflows api :384 uniqueAssigneeIds singular.
