## AUDIT 1/20 — src/lib/workflow-pdf-export.ts (13 findings)
- Interface singular fields force one person; assignees[] added but unread.
- :320 stepHeight += 95 fixed -> overflow with extras. FIX: + 10 * (assignees.length - 1).
- :431 personnelNeeded = 60 guard -> FIX: 60 + 8 * extraCount.
- :455/:521 avatar single. :457 nameStr singular -> add IN THE LOOP line for assignees[1:].
- :463 roleStr uses step.role (ambiguous). :469-472 chapter singular.
- :475-497 contacts single. :502-519 single QR.
- :525 curY floor pY+55 -> raise by extra block height.
- :457 Pending Assignment fallback should try assignees[0].name.
- :59 participants[] never rendered -> leadership invisible.
- UPSTREAM: api/workflows must populate assignees from task assigneeIds.
SCOPE DECISION: implement in-the-loop line + layout math + API/population + page pass-through. Skip per-assignee QRs (doer submits; oversight views) and avatar clusters (keep primary avatar).
