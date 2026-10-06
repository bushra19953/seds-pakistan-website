# SWARM B3: Notification / Inbox Surfaces for Task Submissions - Audit Findings

Date: 2026-10-06 | Repo: ~/workspace/seds-pakistan-website, branch `feat/remediation-harness-complete`
Scope: investigation only, no code changes.

## TL;DR

1. The "Submitted for Review" email is a status ping: task title + submitter name + a "Commence Review" button linking to `/admin/tasks?taskId=<id>`. No report text, no proof links, no deadlines, no task details.
2. The in-app review-request notification is also a status ping: title + one-line body + the same link. Two paths exist (assigner email+in-app, and hierarchy validator fan-out in-app+push), neither carries submission content.
3. The Universal Inbox "Task Reviews" tab is empty because it reads the **`submissions`** collection and filters `type === 'TASK_REVIEW'`, but **nothing ever writes a TASK_REVIEW document to `submissions`**. The only TASK_REVIEW sync paths (Cloud Function `onTaskWritten` and the `/api/webhooks/firestore` Next.js route) write to a different collection, **`universal_submissions`**, which no inbox UI reads.
4. Verdict: all three surfaces are status pings. The actual submission content (report, hours) lives only on the `tasks` doc and is read by the real review surface, `/admin/tasks` (validation queue).

---

## 1. "Submitted for Review" email template

**Template code:** `src/lib/mailer.ts`, `generateEmailHtml`, case `'task_submitted_for_review'` (lines ~188-212)

**Sender code:** `src/app/api/tasks/route.ts` PATCH handler (~lines 660-690). When `updatesToApply.status === 'submitted-for-review'` and the submitter is not the assigner, it calls the local `createNotification()` (lines 128-200) with `emailOptions` = `{ emailTemplate: 'task_submitted_for_review', recipientEmail: manager.email, recipientName: manager.displayName, actorName: submitterName, taskTitle }`. `createNotification` always writes the in-app notification first, then calls `sendEmailNotification(email, template, { recipientName, taskTitle, taskLink: notification.link, actorName })` where `notification.link = '/admin/tasks?taskId=<taskId>'`.

**What the email contains:**
- Subject: `🛡️ Directive Review Requested: <taskTitle>`
- Header: "Quality Assurance Review"
- Body greeting to the recipient (manager name)
- Meta rows: `Directive: <taskTitle>` and `Submitted By: <submitter displayName>`
- CTA button "Commence Review" linking to `<BASE_URL>/admin/tasks?taskId=<taskId>` (relative `/admin/tasks?taskId=...` made absolute in `generateEmailHtml`)
- Plain-text fallback: `Review Requested: <taskTitle>\nSubmitted by: <actorName>\n\nReview now: <link>`

**What it does NOT contain:** no report text or excerpt, no proof/proof-of-completion links, no hours worked, no deadline, no task description, no points. Data passed to the template is only `recipientName`, `taskTitle`, `taskLink`, `actorName`. The template struct (lines 70-81) has an optional `dueDate` field used only by the `task_assigned` template; the review template never receives it.

**Email transport note:** `sendEmailNotification` tries Resend API first (`RESEND_API_KEY`), with attempts logged to the `email_logs` collection (visible at `/admin/email-logs`). Known standing issue: Resend key is invalid, so delivery depends on the Gmail SMTP fallback (`GMAIL_USER` / `GMAIL_APP_PASSWORD`). The parent reported review-request emails were sent; if they arrived, they carried only the content above.

## 2. Review-request in-app notification

There are two notification paths on submit-for-review, both fired from `src/app/api/tasks/route.ts` PATCH:

**Path A - assigner (in-app + push + email):** same `createNotification()` call as above writes to `users/<assignerUid>/notifications`:
- `type: 'task_status_change'`
- `title: 'Task Submitted for Review'`
- `body: '"<taskTitle>" has been submitted for your review'`
- `link: '/admin/tasks?taskId=<taskId>'`, `taskId: <taskId>`, `isRead: false`, `timestamp: serverTimestamp`
- Push via FCM multicast if the assigner has tokens and push enabled.

**Path B - hierarchy validator fan-out (in-app + push only, no email):** `src/lib/server/validation-notifications.ts`, `notifyValidatorsOnSubmission()` (~lines 84-107). Recipients = everyone in `getValidatorChainUids(submitterUid)` from the `reporting_relationships` chain, minus the submitter and the assigner (assigner already got Path A). Each gets in `users/<validatorUid>/notifications`:
- `type: 'task_status_change'`
- `title: 'Task Awaiting Your Validation'`
- `body: '<submitterName> submitted "<taskTitle>" and it is awaiting validation.'`
- `link: '/admin/tasks?taskId=<taskId>'`, `taskId: <taskId>`
- Push via FCM if tokens exist.

**Content carried:** submitter name + task title + link only. No report, no proof, no hours. Both paths are status pings.

## 3. Universal Inbox "Task Reviews" tab: why it is empty

**Page:** `src/app/admin/submissions/page.tsx` (gated by `AuthorizationGate permission="canManageApplications"`).

**What populates it:**
- Single Firestore listener: `query(collection(db, "submissions"), orderBy("created_at", "desc"), limit(100))`.
- Client-side tab filter: `submissions.filter(s => s.type === activeTab)`, with the tab id `'TASK_REVIEW'`.

So a row appears only if a document exists in the **`submissions`** collection with `type === 'TASK_REVIEW'`.

**What writes TASK_REVIEW documents:** exactly one writer, found by searching all of `src` and `functions`:
- `functions/src/index.ts` `onTaskWritten` (Cloud Function Firestore trigger on `tasks/{taskId}`) -> `handleUniversalSubmissionSync(..., 'TASK_REVIEW', ...)` (line ~901)
- `src/app/api/webhooks/firestore/route.ts` `handleTaskWritten` -> `executeUniversalSubmissionSync(..., 'TASK_REVIEW', ...)` (line 186), reachable only via client `firestore-wrapper.ts` -> POST `/api/webhooks/dispatch`

**Both write to the `universal_submissions` collection, not `submissions`.** The inbox page never reads `universal_submissions`. Result: the collection/tab/type triple never intersects. The tab cannot show anything, regardless of how many tasks are submitted-for-review.

**Secondary issues (would matter after the collection mismatch is fixed):**

a) **Status mapping is wrong for the real status value.** Both syncs compute `s = status.toUpperCase()` and only map `PENDING_REVIEW` -> `PENDING`. The app's actual status is `submitted-for-review` (see `src/lib/task-types.ts` line 72-74), which becomes `SUBMITTED-FOR-REVIEW` in the synced doc. The inbox's status badge colors only recognize PENDING/APPROVED/REJECTED, so a synced row would render a gray "SUBMITTED-FOR-REVIEW" badge, not a pending one.

b) **The Next.js webhook path never fires for task submissions anyway.** Task submission goes through `PATCH /api/tasks` (`src/components/profile/assigned-tasks.tsx` `handleQuickAction`, line 266), which writes via server-side Admin SDK. The webhook sync requires a *client-side* write through `firestore-wrapper.ts` to POST `/api/webhooks/dispatch`. Server writes bypass it entirely. The Cloud Function trigger would fire on any write, but it targets the wrong collection (see above), and its deploy state was not verified in this investigation.

c) **Even the index doc carries no content.** The sync payload is `{ global_id, original_ref, type, status, created_at, user_id, user_display_name, user_photo_url, chapter_id, summary_text }` only. The drawer inspector (`task-inspector.tsx` -> `generic-inspector.tsx`) re-fetches the live task doc via `original_ref`, but `task-inspector.tsx` renders "Member Submission Data" from a **`submissionData`** field that does not exist on task docs (real fields are `report`, `hoursWorked`), so it would show "N/A". `generic-inspector.tsx` line 125 also writes its optimistic approve/reject update to `universal_submissions`, consistent with the old index collection rather than `submissions`.

d) **Tab key mismatch for other writers.** The other writers to `submissions` (`src/app/api/submissions/route.ts` POST writes lowercase types `competition`/`opportunity`/`resource`/`other`; `src/app/api/contact/route.ts` writes CONTACT items) also do not match the tab ids (`SUBMISSION`, `TASK_REVIEW`), so the inbox's tab system is broadly misaligned with its writers, not just for task reviews. (Outside this task's scope, but the same class of bug.)

## 4. Are these surfaces showing submission content, or just status pings?

| Surface | Shows submission content? | What it actually shows |
|---|---|---|
| Review-request email (`task_submitted_for_review`) | No | Task title, submitter name, "Commence Review" button -> `/admin/tasks?taskId=<id>` |
| In-app notification (assigner) | No | `"title" has been submitted for your review` + link |
| In-app + push (validator fan-out) | No | `<submitter> submitted "title" and it is awaiting validation.` + link |
| Universal Inbox "Task Reviews" tab | N/A (empty) | Would show only summary text + submitter identity + status even if populated; inspector would show "N/A" for submission data due to `submissionData` field mismatch |
| Real review surface `/admin/tasks?taskId=` + `/api/tasks/review-queue` | Yes | Reads the `tasks` doc directly: full `report` (line 38, task-types.ts), `hoursWorked` (line 41), status, deadlines; review-queue returns submitter name/role, points, submittedAt, deadline |

**Bottom line:** the email, the notifications, and the inbox tab are all status pings carrying nothing but task title, submitter name, and a link to the admin tasks page. The only surface that exposes actual submission content is `/admin/tasks` (via the validation queue API, which queries `tasks` where `status == 'submitted-for-review'` directly). The Universal Inbox "Task Reviews" tab is empty because its query (`submissions` collection + `type == 'TASK_REVIEW'`) can never match: the sole TASK_REVIEW sync writes to `universal_submissions`, and the task-submit path (server-side PATCH) never triggers the client-webhook sync path at all.
