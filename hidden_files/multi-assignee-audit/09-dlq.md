## AUDIT 9/20 — src/app/api/cron/process-dlq/route.ts
- :60 ignores point_distribution_mode split (over-awards N x full).
- :60-71 ignores assignment_type collective (credits users not chapter).
- :62-64 no dedupe/normalization -> double award on dup UIDs; poison doc 500s whole batch.
- :77-79 ledger idempotency outside transaction -> double awards on overlapping runs.
- Adjacent: tasks/route.ts:504 enqueues gamification_tx_failed but processor marks it FAILED_PERMANENTLY (unknown action) -> genuine tx crashes never retried.
FIX DIRECTION: reuse executeGamificationTransaction in DLQ path (covers 1,2,4); normalize IDs (3).
