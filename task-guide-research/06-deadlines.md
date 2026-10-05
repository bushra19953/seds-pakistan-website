# Deadline Visibility & Notifications Audit

Date: 2026-10-05. Blunt assessment for the task how-to guide.

## 1. Where the assignee sees their deadline

| Location | File | Exact label/format |
|---|---|---|
| Profile task card | `src/components/profile/assigned-tasks.tsx:382` | `CountdownTimer` — live countdown to `task.deadline` (e.g. "2h 14m left"). Status badge flips to red **OVERDUE** once past deadline (`:358`). |
| Public mission page | `src/app/missions/[workflowId]/page.tsx` | Header bar: **"Deadline: 5 Oct 2026"**. Each step card: **"Due: 5 Oct 2026"** next to the assignee name. (Verified live via screenshots.) |
| Submit page | `src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx:198-202` | Under the step title: **"4 points · Due 05-Oct-2026, 12:00 am"** plus a PENDING status badge. |
| PDF brief | `src/lib/workflow-pdf-export.ts:568,633` | Cover page: **"MISSION DEADLINE"**. Per step card: **"T-MINUS: 5 Oct 2026 08:00 PM"**. |
| WhatsApp share text | `src/components/profile/assigned-tasks.tsx:405` | When a task link is shared: **"Deadline: 5 Oct 2026"** inline in the message. |

Bottom line: deadlines are visible in at least 5 places. Nobody can credibly claim they didn't know the date.

## 2. Notifications — what fires and what doesn't

### Task assigned: YES (with caveats)
- `POST /api/tasks` (`src/app/api/tasks/route.ts:1111`) calls `createNotification` with type `task_assigned`: in-app notification in `users/{uid}/notifications`, FCM push if the user has tokens, and email via the `task_assigned` template.
- **Caveat 1:** Workflow step tasks created through the AI/workflow generation path may not go through this route. If Task 02's steps were created via the workflow API rather than the tasks API, the assignees may never have been notified.
- **Caveat 2:** Reassignment sends nothing. Known open issue since 2026-10-04: "no notification on reassignment."
- **Caveat 3:** Email delivery depends on Resend, whose API key is invalid (verified 2026-10-05 — contact form emails 502). Push depends on FCM tokens being collected on the user's device; unverified.

### Deadline approaching (24h reminder): NO
- The code exists: `src/app/api/cron/remind-deadlines/route.ts` — "alert users 24 hours before their task is due," sends via `notificationService`, marks `reminderSent24h` to avoid dupes.
- **It is not scheduled.** `vercel.json` crons contain only `/api/cron/overdue` (daily midnight). `remind-deadlines` and `check-deadlines` exist as routes but never run. This is dead code in production.

### Deadline passed: SILENT
- `/api/cron/overdue` (runs daily at midnight) flips `pending`/`in-progress` tasks with past `individualDeadline` to status `overdue`. It optionally advances the workflow to the next step.
- **It sends zero notifications.** The assignee finds out only by opening their profile and seeing the red OVERDUE badge. No push, no email, no in-app alert.

## 3. "Your Turn" — what it is

In `src/components/profile/assigned-tasks.tsx:194`:

```ts
const isYourTurn = taskAssigneeIds.includes(String(currentUserId))
  && task.isCurrentStep
  && !isCompleted;
```

Meaning: this task is assigned to **you**, it is the **currently active step** of its workflow, and it is **not finished**. The ball is in your court.

Visual treatment (`:339-396`): the card gets a highlighted primary-color border, a Zap icon, a **"YOU"** badge next to the assignee name, and a prominent **"TRANSMIT SUCCESS"** quick-action button that submits the task for review in one click.

For the guide: tell assignees to look for the highlighted cards with the YOU badge on their profile. That's their to-do list.

## Gaps to state plainly in the guide

1. **No 24-hour warnings.** The reminder cron was written but never scheduled. Assignees get no heads-up.
2. **No "you missed it" alert.** Overdue tasks just silently turn red.
3. **Assignment notifications may not fire for workflow tasks.** If the task came from a workflow (like Task 02), verify the assignee was actually notified — don't assume.
4. **Email is broken** (Resend key invalid) and **push is unverified** — treat in-app notifications as the only reliable channel, which means the assignee must open the site to see anything.
