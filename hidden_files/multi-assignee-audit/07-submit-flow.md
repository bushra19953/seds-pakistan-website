## AUDIT 7/20 — submit flow
- Auth OK for multi-assignee (lookup + PATCH check arrays). QR shared URL fine.
- F2/F7: isManagerAbove fallback singular (submit route ~:75-82, tasks PATCH :297). FIX: loop all assigneeIds.
- F3: shared report/hoursWorked, last-writer-wins, no submittedBy/At. FIX: per-assignee submissions or lastSubmittedBy/At stamp.
- F4: deliverableFiles replaced wholesale per session -> co-submitter wipes files. FIX: arrayUnion merge server-side.
- F5: shared status; either assignee can flip to submitted. FIX: submittedBy[] gate on doer.
- F6: deliverableFiles NOT in ASSIGNEE_SAFE_FIELDS (:397) -> assignee upload 403s. FIX: add to allowlist. (Breaks Task 02 proof upload TODAY.)
SCOPE: F6 (one line, critical path), F4 merge, F2/F7 loops. F3/F5 attribution -> note as follow-up (data model change).
