# VERIFY-06 — Submission Communications Sweep
**Worker 6 · 2026-10-06 ~07:20–07:25 PKT · Investigation only, no writes**

## Verdict
**No additional submission-related communications found beyond the three known "Submitted for Review" emails.** The three known emails correspond exactly (to the second) to the three tasks' `submittedAt` timestamps. No resubmissions, no duplicate emails, no revision-request/feedback emails, no approval emails, and no system-generated comms from Huzaifah's UID exist anywhere I could reach.

## Known baseline (for reference)
- `L5Kv8tmIsb6yGi44zkyT` — Executive Document Audit — submitted 20:38:59 PKT Oct 5 → email 8:39:00 PM
- `z20ZnLAPd3q8ZWRPnRVr` — Assembly, 5-Point QC & Final Delivery — submitted 20:47:56 PKT Oct 5 → email 8:47:57 PM
- `UHtT8yldnfIjWFmnnhGM` — Print Production & Material Procurement — submitted 20:53:19 PKT Oct 5 → email 8:53:20 PM

## Where comms live (code audit)

**Email logs** — `src/lib/mailer.ts` `logEmailAttempt()` writes to the **`email_logs`** Firestore collection (Admin SDK) on every send attempt: fields `to, from, template, subject, htmlPreview` (first 5000 chars), `success, error, sentAt`. This is the canonical email record.

**Who gets emailed on submission** — `PATCH /api/tasks` (`src/app/api/tasks/route.ts` ~line 682): on status → `submitted-for-review`, a `task_submitted_for_review` email goes **only to the assigner** (`assignerId`, via Gmail SMTP). Assigner here = `pLW0PuQCTAQHCNK1SfllVhPZdMz1` (task `createdAt` = 2026-10-04T06:43Z = 11:43 PKT Oct 4, matching the Task 02 recreation); the three known emails to **ghazanmongol@gmail.com** are consistent with that. One email per transition — a co-assignee transmitting afterwards does NOT send another email (no transition).

**Validator fan-out** (`src/lib/server/validation-notifications.ts`) — hierarchy-chain validators get **in-app + push only**; channel policy explicitly reserves email for the assigner path. So Huzaifah could never have received a system email for these submissions.

**In-app notifications** — `users/{uid}/notifications` subcollections (always written, even when email fails); FCM push if tokens exist. Top-level `notifications` collection exists in code (`createGlobalNotification`) but no submission path uses it.

**Public mission-submit route** (`/api/missions/[workflowId]/submit/[stepIndex]`) — sends **no emails and creates no notifications**. Not a comms source.

**Approval/feedback emails** (`task_approved`, `task_feedback`) cannot have fired: all three tasks are still `submitted-for-review`; no decision, rejection, or feedback fields exist on any doc.

## Live Firestore evidence (unauthenticated REST, API key from `.env.local`)

| Collection / path | Access | Result |
|---|---|---|
| `email_logs` (list) | **403** — no rule in `firestore.rules` → default-deny | Canonical log unreadable |
| `submissions` (list) | **403** — requires superadmin / canManageInbox | Denied |
| Top-level `notifications` (list) | **403** — no rule → default-deny | Denied |
| `users/{uid}/notifications` | Denied — rules require owner auth; no way to list UIDs unauth | Denied |
| `tasks/{id}/activity` (subcollection) | **403** — no subcollection rule → default-deny | Revision audit trail unreadable |
| `workflows/{id}` | **403** | Denied |
| `tasks/{3 known IDs}` (direct GET) | **200** — readable via `workflowId != null` public-missions rule | Full docs read |
| `tasks` runQuery filter `workflowId == 'wf_1791096197560_ugmmt1'` | **200** — allowed | **Exactly 3 task docs exist in the workflow — no duplicate/resubmitted clones** |
| `GET /api/admin/email-logs` (unauthenticated) | **401** — requires auth + `canViewEmailLogs` | Denied |
| Gmail skill (`hatch_gws_cli`) | **Not connected** — no accounts linked in this sandbox | ghazanmongol@gmail.com inbox unverifiable from here |

## Task-document facts (read live 2026-10-06 ~07:22 PKT)

- All three: `status = submitted-for-review`, `submittedBy = aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2` (primary assignee = doer Maira), co-assignee UID `njnWidUfROQTgb92mDWVoXguifR2` (Huzaifah) present on all three `assigneeIds` but **nothing was ever written under his UID** — no `submittedBy`, no resubmit fields.
- `submittedAt` (UTC): 15:38:59 / 15:47:56 / 15:53:19 Oct 5 → exactly the three email send times.
- Reports: Audit = `Objective reached. Direct Transmit.` (dummy text, unchanged); Assembly + Print = the same Google Doc link.
- No `rejectionReason`, `feedback`, revision counters, or resubmission fields on any doc.
- **One anomaly:** Audit task `updatedAt` (15:53:48Z) is ~15 min *after* its `submittedAt` (15:38:59Z) — tasks 2 and 3 have `updatedAt == submittedAt`. `submittedAt` and `report` unchanged, so this was **not** a resubmission; the doc also shows `hoursWorked = 1`. Cause unknowable without the (403-blocked) activity subcollection — most likely a hours log or non-status edit. Worth a look in `/admin/email-logs` (would also show whether any 4th email attempt was logged ~20:53).
- Out-of-scope observation (for the deadlines worker): `individualDeadline = 2026-10-04T09:00:00Z` on all three, while `deadline` differs per task (Audit: 2026-10-05T20:00:00+05:00; Assembly: 2026-10-05T05:00:00Z; Print: 2026-10-04T19:00:00Z). Flagging, not investigating.

## Gaps (needs an admin session or parent delegation)
1. **`email_logs` contents** — the only way to prove no 4th email attempt was logged: open `/admin/email-logs` or call `GET /api/admin/email-logs` with an authenticated `canViewEmailLogs` session (Zubair's Cloud Shell / admin browser).
2. **In-app notifications** for the assigner + validator chain — readable only as the owning user or superadmin.
3. **Gmail inbox** (ghazanmongol@gmail.com) — Gmail skill is not connected in this sandbox; the three known emails came from outside it. Search that inbox for `Submitted for Review` / `Direct Transmit` after Oct 5 20:53 to rule out later follow-ups from Maira/Huzaifah manually.
4. **`tasks/{id}/activity`** subcollections — the Audit task's 15:53:48Z post-submission edit is unexplained; readable only with auth.

## Conclusion for the parent
System design makes extra emails nearly impossible here: emails fire only on the submitter→`submitted-for-review` transition and only to the assigner; the transition happened exactly once per task (statuses never left `submitted-for-review`); all three submittedAt→email timestamps line up to the second; no approval, rejection, or feedback ever occurred. **Within everything reachable without auth, the comms record is clean: three submissions, three emails, nothing else.** The residual check is the `email_logs` collection itself (needs admin auth) plus a direct Gmail inbox search for manual follow-ups.
