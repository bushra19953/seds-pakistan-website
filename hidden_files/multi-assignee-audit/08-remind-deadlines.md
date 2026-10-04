## AUDIT 8/20 — src/app/api/cron/remind-deadlines/route.ts
- Core loop already multi-assignee correct (lines 53-59 build IDs from both forms, loops all).
- CRITICAL adjacent (:41): `.where('reminderSent24h','!=',true)` excludes docs missing the field; field never initialized at creation -> cron matches ZERO tasks ever. FIX: init reminderSent24h:false at creation.
- :53-59 no dedup of assignee IDs -> duplicate notifications. FIX: Set dedupe.
- :59-69 partial failure: reminderSent24h=true set even if one assignee's send failed; no retry. FIX: only flag when all succeed or per-assignee state.
- :70,77 reminderCount understates (counts tasks not notifications).
