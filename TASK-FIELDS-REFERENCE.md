# Task Assignment — Complete Field Reference

Source: `src/components/admin/tasks/task-form.tsx` (Create Task dialog, `/admin/tasks`)
Date: 2026-10-03

## How to read this

- **Required** = the Create button stays disabled until it is set
- **Default** = pre-filled value if you touch nothing
- **Stored as** = the field key in the Firestore `tasks` document

---

## 1. AI Assistance (top of the form)

| Field | Type | Required | Default | Stored as | Notes |
|---|---|---|---|---|---|
| Brain Dump | textarea | No | empty | — (not stored) | Plain-language goal; AI generates title, description, steps, assignees |
| Your Gemini API Key | password | No | from localStorage `gemini.apiKey` | — (not stored) | Personal key, sent with the request; empty = server fallback key |

## 2. Points & Scoring

| Field | Type | Required | Default | Stored as | Notes |
|---|---|---|---|---|---|
| Base Points | number | No | 10 | `points` | Pool awarded on completion; split evenly across workflow steps if set |
| Deadline Penalty | number | No | 5 | `penaltyPoints` | Displayed only — nothing deducts it automatically (no engine) |
| Workflow Bonus | number | No | 10 | `workflowBonusPoints` | Bonus for workflow completion |

## 3. Core Task Fields

| Field | Type | Required | Default | Stored as | Notes |
|---|---|---|---|---|---|
| Title | text | **Yes** | empty | `title` | |
| Description | textarea | **Yes** | empty | `description` | |
| Deadline * | datetime-local | **Yes** | empty | `deadline` | ISO-like string; Create disabled until set |
| Status | select | No | `pending` | `status` | Options: `pending`, `in-progress`, `submitted-for-review`, `completed`, `overdue` |
| Assignees | multi-select user picker | **Yes** | empty | `assigneeIds` | Array of user UIDs; supports multiple assignees |
| Chapter (optional) | select | No | none | `chapterId` | Filters the assignee picker to chapter members |
| Project | select | No | none | `projectId` | Links the task to a project |

## 4. Guidance

| Field | Type | Required | Default | Stored as | Notes |
|---|---|---|---|---|---|
| Task Guidance (How to Complete) | rich text | No | empty | `guidance.description` | Free-form guidance for assignees |
| Step-by-Step Instructions | textarea (one per line) | No | empty | `guidance.steps[]` | Each line becomes one instruction |
| Estimated Time | number | No | empty | `guidance.estimatedTime` | Minutes (optional) |

## 5. Badges

| Field | Type | Required | Default | Stored as | Notes |
|---|---|---|---|---|---|
| Badge Awarded on Completion (optional) | select | No | none | `completionBadgeId` | Badge doc id/slug; awarded to assignee(s) |
| Team Badge (workflow) | select | No | none | `finalWorkflowCompletionBadgeId` | Awarded to everyone on workflow completion |

## 6. Resources & Logistics (optional, repeatable)

Each resource:

| Field | Type | Required | Stored as | Notes |
|---|---|---|---|---|
| Title | text | Yes (per row) | `resources[].title` | |
| URL | url | Yes (per row) | `resources[].url` | |
| Type | select | No | `resources[].type` | Options: `link`, `drive`, `github`, `doc`, `video`, `other` |

## 7. Workflow Plan (optional, repeatable per step)

Each workflow step:

| Field | Type | Required | Stored as | Notes |
|---|---|---|---|---|
| Step Title | text | Yes (per step) | `steps[].title` | |
| Step Description | textarea | Yes (per step) | `steps[].description` | |
| Override Deadline (optional) | datetime-local | No | `steps[].individualDeadlineIso` | If empty, deadline is staggered/calculated |
| Assignee | user picker | No | `steps[].assigneeId` | Single user per step |
| Role | text | No | `steps[].role` | Suggested role (often AI-filled) |
| Step Badge | select | No | `steps[].stepSpecificBadgeId` | Awarded to the assignee on step completion |
| Step Resources | repeatable (title + URL + type) | No | `steps[].resources[]` | Private to this step's assignee |
| Step Guidance | description + steps[] | No | `steps[].guidance` | Same shape as task guidance |

AI-generated steps may also carry `reason` (why this assignee was picked) and
`aiSelected` (flag highlighting AI suggestions). These are informational only.

## 8. Fields set automatically (not in the form)

| Field | Stored as | Notes |
|---|---|---|
| Assigner | `assignerId` / `createdBy` | UID of the admin creating the task |
| Created timestamp | `createdAt` | Server timestamp |
| Report | `report` | Filled by the assignee on submission, not by the creator |

---

## Validation rules

1. Create button is disabled until **Title**, **Description**, **Assignees** (min 1), and **Deadline** are set.
2. Workflow steps are optional; a task with zero steps is a single standalone task.
3. `assigneeIds` is an array — the same form creates multi-assignee tasks.
4. Deadline penalty and workflow bonus are stored and displayed but have no automatic engine behind them.
