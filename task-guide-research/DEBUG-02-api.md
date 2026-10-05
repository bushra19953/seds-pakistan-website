# DEBUG-02: PATCH /api/tasks — API boundary audit

**Question:** Does the API return trustworthy status codes, or does it ever report
success on failure (which would make a frontend `res.ok` check useless)?

**Handler:** `PATCH /api/tasks` -> `handleUpdate()` in
`src/app/api/tasks/route.ts` (lines 822-829, implementation ~200-820).

## Verdict

**The API is trustworthy.** Every failure path returns a non-2xx status code.
There is exactly one edge case where a 200 response does not do what the caller
asked (see "Silent no-op" below), but it does not affect the transmit flow.
The false-success bug is purely frontend: `handleQuickAction` never checks
`res.ok`, so 401/403/404/500 responses all render as "Mission Success
Transmitted!" + confetti.

## Failure-path inventory (all non-200)

| # | Condition | Code | Body |
|---|-----------|------|------|
| 1 | Firestore Admin SDK not initialized | 500 | `{ error: 'Internal Server Error: Firestore not initialized' }` |
| 2 | No bearer token / session cookie | 401 | `{ error: 'Unauthorized: missing Bearer token', error_code: 'missing_token' }` |
| 3 | Session verification throws SessionError(500) | 500 | `{ error: <message> }` |
| 4 | Token invalid / expired | 401 | `{ error: 'Unauthorized: invalid token', error_code: 'token_invalid' }` |
| 5 | Token issued for different Firebase project | 401 | `{ error: 'Unauthorized: token issued for different project', error_code: 'issuer_mismatch' }` |
| 6 | Body fails zod schema (`taskId` missing, bad `updates` shape) | 400 | `{ error: 'Invalid request', details }` |
| 7 | Task ID does not exist | 404 | `{ error: 'Task not found' }` |
| 8 | Optimistic concurrency conflict (`lastUpdatedAt` stale) | 409 | `{ error: 'Conflict: ...', serverVersion, clientVersion }` |
| 9 | Self-approval attempt (submitter == validator) | 403 | `{ error: 'Forbidden: you cannot validate your own submission' }` |
| 10 | Caller not above submitter / not assigner / not manager (decision) | 403 | `{ error: 'Forbidden: only someone above the submitter...' }` |
| 11 | `changes-requested` without `feedback_text` | 400 | `{ error: 'Feedback text is mandatory for requesting changes' }` |
| 12 | Assignee not in workflow participant list | 400 | `{ error: 'Invalid assignee for workflow: not in participant list' }` |
| 13 | Caller is neither assignee nor manager | 403 | `{ error: 'Forbidden: you are not assigned to this task' }` |
| 14 | Assignee touches non-safe fields (anything outside `status`, `hoursWorked`, `report`, `resourceLinks`, `feedback_text`, `deliverableFiles`) | 403 | `{ error: 'Forbidden: only task managers may edit these fields', fields }` |
| 15 | Reassign outside caller's chapter | 403 | `{ error: 'Forbidden: cannot reassign tasks outside your chapter' }` |
| 16 | Reassign to banned user | 403 | `{ error: 'Cannot assign tasks to banned users', message }` |
| 17 | Reassign to user on vacation | 403 | `{ error: 'Cannot reassign tasks to users on vacation', message }` |
| 18 | Reassign to invalid user | 403 | `{ error: 'Cannot reassign tasks to invalid users', message }` |
| 19 | Gamification transaction crash (completion path) | 500 | `{ error: 'Transaction failed via Strict Lock. DLQ Queued.', details }` |
| 20 | Firestore batch commit failure | 500 | `{ error: 'Transaction failed. Reverted to PENDING and triggered DLQ retry.' }` |
| 21 | Uncaught exception anywhere in handler | 500 | `{ error: 'Internal Server Error', details }` |
| 22 | Malformed JSON body (`request.json()` throws) | 500 | `{ error: 'Internal Server Error', details }` (should arguably be 400, but it is non-200 so `res.ok` still catches it) |

## Success responses (200)

Normal update (includes the transmit flow):
```json
{
  "ok": true,
  "taskId": "<id>",
  "badgeAwarded": false,
  "pointsAwardedTotal": 0,
  "completedOnTime": false,
  "transitionedToCompleted": false,
  "taskBefore": { ... },
  "taskAfter": { ... },
  "uid": "<caller uid>"
}
```

Completion/approval path (gamification transaction runs first):
```json
{
  "ok": true,
  "taskId": "<id>",
  "badgeAwarded": false,
  "transitionedToCompleted": true,
  "taskBefore": { ... },
  "taskAfter": { ... },
  "uid": "<caller uid>"
}
```

**What "success" means for the frontend:** `res.ok === true` AND
`data.ok === true` AND `data.taskAfter.status === <expected status>`.
The `taskAfter` echo is the strongest signal — it is built from the same
`updatesToApply` object that was committed to Firestore.

## The one silent no-op (edge case, not the transmit bug)

If the client sends `status: 'overdue'`, the handler silently deletes it
(`'overdue'` is a display-only status, never persisted) and still returns
200 `ok: true` — with `taskAfter.status` showing the OLD status. The write
succeeded, but the requested status change did not happen. A frontend that
only checks `res.ok` would believe the status changed. Checking
`data.taskAfter.status` catches this.

## Non-blocking side effects (cannot cause false 200s or false failures)

These are all wrapped in try/catch and never affect the response code:
- `logTaskActivity` (catches internally)
- `createNotification` incl. FCM push and email (catches internally)
- Validator fan-out on submission (`notifyValidatorsOnSubmission`)
- Validation audit + decision notifications (`logValidationDecision`, `notifyOnDecision`)

If notifications fail, the task write still succeeds and the response is
still 200 — correct behavior, since the state change is what matters.

## DLQ behavior on 500s

On gamification crash (#19) or batch commit failure (#20), the handler writes
to `dlq_points_retry` with `status: 'PENDING_RETRY'` before returning 500.
The write is `await`ed; if the DLQ write itself throws, the outer catch
returns 500 anyway. No path returns 200 after a failed write.

## Conclusion for Phase 2 (frontend fix)

A frontend check of `res.ok && data.ok && data.taskAfter?.status ===
'submitted-for-review'` is sufficient and trustworthy. No API changes needed.
