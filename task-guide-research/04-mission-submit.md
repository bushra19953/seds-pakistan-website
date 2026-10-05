# 04 — Submitting work through the mission page (personal submit link)

Research source: `src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx`
Written for non-technical users (team members, reviewers, managers).

## What this page is

Every mission step has its own private submit link, shaped like:

```
https://sedspakistan.live/missions/<workflowId>/submit/<stepNumber>
```

Each assignee gets their own link (and a personal QR code printed on their PDF brief). Opening the link shows the full step and a form to submit the finished work. You do **not** need to go through the admin panel — this page works for anyone with the link.

---

## 1. What an assignee sees (logged in, and this step is theirs)

**While loading:** a spinner with the text "Loading your mission step..."

**Top of the page:**
- Small gold heading: "SEDS PAKISTAN"
- The task title in large text
- Under the title: the points for the task and the deadline, e.g. "4 points • Due 05-Oct-2026, 12:00 am" (date shown in Pakistan format)
- A pill-shaped status badge, e.g. "Status: PENDING" (or IN PROGRESS / SUBMITTED FOR REVIEW)

**Mission Brief card:** the full task description (what to do, how, standards, resources, how it will be verified).

**"Transmit Mission Update" panel** (only the assignee sees this):
- **Work Report** — a text box. Placeholder says: "Describe what you completed, key decisions, and anything the reviewer should know..." If you typed a report before, it is already filled in.
- **Hours Worked** — a number box (halves allowed, e.g. 6.5). Placeholder: "e.g. 6"
- **Deliverable Links** — a text box for links. Placeholder: "Drive / video links"
- **Upload Deliverables** — a file picker (you can select several files). Note under the label says: "(goes straight to SEDS Drive)". While uploading you see a green progress bar; finished uploads are listed in green with their size in MB.
- Two buttons at the bottom:
  - **"Save Progress"** — saves what you typed and marks the step "in progress". Success message: "Progress saved. Your mission control is updated."
  - **"Transmit for Review"** — sends the step for review. Success message: "Mission update transmitted for review. Your manager has been notified."
- If something fails you see a red message instead, e.g. "Upload failed: ..." or "Transmission failed. Try again."
- While a save/transmit is running the buttons show "Saving..." / "Transmitting..." and are disabled so you cannot double-submit.

**Bottom of the page:** a link "← View live mission status" back to the public mission page.

**Good to know:** your previously saved report, hours, and links are pre-filled when you reopen the link, so you can finish your work across several visits.

---

## 2. What a logged-out visitor sees

If you open the link without being signed in, you see a sign-in screen:

- Heading: "Submit Your Mission Work"
- Text: "Sign in to submit your work for this mission step."
- A big gold button: **"Sign In to Submit"** — after signing in you are taken straight back to this submit page (your place is not lost).
- A smaller link: "← View mission status" (goes to the public mission page).

**Discrepancy note (needs verification):** the code shows the sign-in screen above for logged-out visitors. A live check of the production site once showed the full step brief plus the manager notice instead (see section 4), which suggests the test browser may have had a leftover login session, or the deployed code differs from this branch. Worth re-testing with a clean browser session.

---

## 3. What a non-assignee sees

If you are signed in but the step cannot be opened for you (you are not the assignee, the step does not exist, or the link is wrong), you see:

- A satellite emoji 🛰️
- Heading: "Cannot Open Submission"
- The reason in grey text (or "This mission step could not be loaded.")
- A gold button: **"View Mission"** (back to the mission page)

---

## 4. What a manager sees (logged in, but not the assignee)

Instead of the submit form, a manager sees a grey box with this exact text:

> "You are viewing this step as a manager. The assignee submits through their own personal link."

Everything else (title, deadline, status badge, Mission Brief) is still visible. Managers review submitted work from the **validation queue in their own profile page**, not from this link.

---

## 5. Mission submit page vs. submitting from your profile — which to use?

Both end at the same place (the task is marked "submitted for review"), but they are different tools:

| | Mission submit page (this page) | Profile task list |
|---|---|---|
| Where | Your personal link / QR code | Your profile → assigned tasks |
| Best for | A proper submission: written report, hours logged, deliverable links, files uploaded straight to SEDS Drive | Quick actions across many tasks |
| Report | Free-text "Work Report" box (pre-filled with earlier drafts) | Quick transmit uses a canned default report ("Objective reached. Direct Transmit.") unless you edit the task card |
| File upload | Yes — direct to SEDS Drive with progress bar | Not on the quick action |
| Save without submitting | Yes — "Save Progress" keeps status "in progress" | Status dropdown on the task card |
| Recall a submission | No recall button here | "Submission recalled — back to Active." button exists on the profile card |

**Rule of thumb for the guide:**
- Finished the work and want to hand it in properly (report + files/links)? Use your **personal submit link**.
- Just flipping a task to "in review" quickly, or managing several tasks at once? Use your **profile**.

**Deadline visibility on this page:** the deadline appears under the title ("• Due 05-Oct-2026, 12:00 am"). It uses the step's individual deadline when one is set, otherwise the workflow deadline.

---

## Technical notes (for the guide author, not for end users)

- Data comes from `GET /api/missions/<workflowId>/submit/<stepIndex>` with a Firebase Bearer token; returns `isAssignee` / `isManager` flags that drive which view renders.
- Submitting sends `PATCH /api/tasks` with `{ taskId, updates: { status, report, hoursWorked, resourceLinks, deliverableFiles[] } }`.
- `status` is `submitted-for-review` on "Transmit for Review", `in-progress` on "Save Progress".
- File uploads go through the Drive upload client with `kind: 'document'` and context `task-<task.id>`; each file stores `fileName`, `driveFileId`, `downloadUrl`, `sizeBytes`, `contentType`.
- Success/error feedback is a single inline message line; buttons disable while submitting.
