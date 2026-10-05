# 05 - How to Review a Task (the reviewer side)

This is the "where do I go to review someone's work" answer.

## 1. Where does a reviewer go?

Go to **your own profile page** (click your avatar/name, top right).

Near the top of your profile, above everything else, a highlighted box appears
called **"Awaiting Your Validation"** with a shield icon and a count badge.
It only shows up when there is at least one submission waiting for you.
If the box is not there, nobody is waiting on you.

Inside the box, each waiting task shows:
- The task title
- Who submitted it (name and their role)
- Why it is YOURS to review ("Your role: Assigner", or "Your role: 2 levels
  above submitter", or "Your role: Task manager")
- How many points the task is worth
- When it was submitted and its deadline

Each item has a **"Review Submission"** button. Clicking it opens the task's
detail dialog on the Mission Report tab, where you see everything the
submitter sent.

## 2. What does a pending submission look like?

When you open a submitted task for review, the top of the detail dialog shows
an **"AWAITING REVIEW"** banner. The **Mission Report** tab shows:

- The submitter's written report (called a SITREP)
- How many hours they logged (if any)
- Their deliverable links (Drive files, GitHub links, etc.) as clickable cards

This is everything you need to judge whether the work is done.

## 3. What can the reviewer do?

There are exactly two buttons at the bottom of the review section:

1. **"Approve Mission"** (big filled button)
   - Marks the task as completed.
   - The submitter is awarded the task's points (gamification points).
   - The submitter gets a notification: "Task Approved".

2. **"Request Revision"** (outlined red button)
   - Opens a text box where you MUST write what needs to change.
   - The "Send Revision Request" button stays disabled until you type feedback.
   - Sends the task back to the submitter with your feedback attached.
   - The submitter gets a notification: "Changes Requested" with your note.
   - The submitter sees your feedback in a highlighted box on their task card
     and can re-submit after fixing it.

If someone else already made a decision on the task before you, you get a
message saying "A decision was already recorded for this task" instead of
double-processing it.

## 4. Who is allowed to review?

You can validate a task if you are ANY of these:

- **The person who assigned it** (the assigner), OR
- **Anyone above the submitter in the reporting chain** (their manager, their
  manager's manager, and so on up the chain), OR
- **Someone with task-management permission** (canManageTasks)

Your own submissions never appear in your own queue.

The system figures this out from the reporting chain stored in the
`reporting_relationships` collection, NOT from who has a fancier job title.
If you are 2 levels above the submitter, the queue tells you so.

## 5. What happens after approve / reject

**On approval:**
- Task status changes to `completed`.
- Points are awarded to the submitter (added to their profile score).
- The submitter gets an in-app notification: "Task Approved".
- If there was a separate assigner who is not you and not the submitter,
  they get notified too.
- The item disappears from your validation queue.

**On revision request:**
- Task status changes back so the submitter can edit it (`changes-requested`).
- Your written feedback is saved and shown to the submitter in a highlighted
  "Latest reviewer feedback" box on their task card.
- The submitter gets an in-app notification: "Changes Requested" with your
  note included.
- The submitter fixes the work and re-submits; it comes back to your queue.

**Technical notes (for the guide appendix):**
- Queue data comes from `GET /api/tasks/review-queue` (server-side check,
  because Firestore rules cannot walk the reporting chain).
- The review decision is a `PATCH /api/tasks` call setting status to
  `completed` or `changes-requested`.
- Notifications are written to `users/{uid}/notifications` (in-app only).
- Component: `src/components/profile/validation-queue.tsx`, rendered in
  `src/components/profile/optimized-profile.tsx` (only on your own profile).
- Review actions live in `src/components/profile/task-detail-dialog.tsx`
  (`handleApprove`, `handleRequestRevision`).
