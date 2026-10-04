# Verifier FAILs (fix specs collected 2026-10-04)

## 16/20 deadline crons: PARTIAL FAIL
- (a) src/app/api/cron/remind-deadlines/route.ts:41 — `.where('reminderSent24h','!=',true)` excludes legacy docs (field missing). Fix: drop != filter, add `if (task.reminderSent24h === true) continue;` at loop top.
- (c) src/app/api/cron/check-deadlines/route.ts:106-108 — singular assigneeId only; array co-assignees never warned/penalized. Fix: resolve assigneeIds array-or-singular, wrap per-user block in for loop. Product decision: co-assignees share penalty? (default yes, each accountable).
