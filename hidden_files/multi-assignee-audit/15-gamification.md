## AUDIT 15/20 — gamification-transaction.ts + ledger writers
- :53 alreadyReceived .some() across all: one paid assignee vetoes everyone's payout. FIX: move check inside per-uid loop.
- :36 distributionMode defaults 'duplicate': 60pt x 3 assignees = 180 minted. DESIGN decision; leave default, note it.
- :147-151 delegation pointsKept applied to EVERY assignee. FIX: only delegating uid.
- :316-335 parent workflow bonus duplicated per assignee, no split consulted. FIX: honor distribution mode.
- :408 pointsAwardedTotal is per-assignee, label lies with N assignees.
- :32 collective branch reads snake_case assignee_id -> branch never fires. FIX: ?? fallback.
- :90,346,349 nextStepAssignee singular -> co-assignees miss "Your Turn!".
- DLQ :66-97 diverges: full points, no split/penalty. FIX: reuse executeGamificationTransaction.
SCOPE: fix :53, :147-151, :32 (clear bugs). Leave distribution default (design). Note DLQ.
