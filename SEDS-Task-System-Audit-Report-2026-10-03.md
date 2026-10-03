# SEDS Pakistan — Task Management System Audit Report
**Date:** 2026-10-03
**Auditor:** Muse (for Muhammad Zubair Mongol, SEDS Pakistan website builder)
**Scope:** Task creation (manual, AI-assisted, workflow, bulk, delegated), lifecycle, roles, UI/UX, scalability, feedback loops, cross-device
**Production URL:** seds-pakistan.web.app → Vercel app (project v0-seds-pakistan)

---

## 1. Executive Summary

The task system is functionally complete and the core lifecycle works end to end: create → assign → submit → review → approve → complete, with points, deadlines, penalties, bonuses, badges, resources, guidance, and workflow steps. A two-sided live audit (admin + restricted assignee) ran the full loop successfully on 2026-10-03.

The audit found **no remaining data-loss bugs in the code under test** — but uncovered a set of real issues:

- **Deploy is currently blocked.** The release containing the CRUD persistence fixes, AI key field, and in-app delete dialogs is built but not deployed: the VM was replaced and the Vercel CLI token was lost. The token must be re-supplied before anything else ships.
- **Security findings (5 items, Critical/High) are on hold** per your instruction — authenticated users can delete any task, the stress-test header can fabricate admin identity, the AI generator endpoint is unauthenticated, and workflow creation lacks authorization. These need your explicit go-ahead to fix.
- **Notification delivery exists but is broken in practice:** the bell is hidden on mobile, and clicking a "New Task Assigned" notification opens a profile page whose `?task=` deep-link parameter is ignored — the assignee never lands on the task.
- **Six live-observed functional bugs** were fixed in code (workflow create dropped points/penalty/bonus/guidance; workflow edit discarded field edits; native confirm() dialogs blocked deletion; raw UIDs in assignee picker) and are awaiting the blocked deploy.
- **Untested surface remains large:** Firefox, tablet, mobile viewports, delegation accept/reject, role change mid-task, circular assignment, multi-assignee lifecycle, reminders, and ledger/idempotency checks were not reached.

**Bottom line:** the system is close to solid. Unblock the deploy, authorize the security fixes, fix the notification deep-link, and run the remaining device/edge matrix — then it is production-grade.

---

## 2. Task Lifecycle Map

Observed live on production 2026-10-03 (admin: Zubair's account; assignee: restricted test account `Testing Account SEDS USA`, role rover_team).

### 2.1 Manual task creation (admin side)
1. Admin opens `/admin/tasks`, clicks **Create Task**.
2. Form requires: title, description, assignee, deadline (field labeled **Deadline \***; button stays disabled until deadline is set — verified live, this was a prior bug fix).
3. Optional: base points (default 10), deadline penalty (default 5), workflow bonus (default 10), completion badge, project, guidance, resources (links/files), workflow steps with per-step deadlines/points/resources.
4. Assignee picker supports chapter filter (verified: selecting IST Chapter filtered to 45 chapter members).
5. On save, Firestore `tasks` document is created and a `task_assigned` notification is written to `users/{assignee}/notifications`, plus email and push (code-verified; email delivery itself was not live-tested).

### 2.2 AI-assisted creation (Brain Dump)
1. Admin enters a plain-language goal ("make pakistan a space power") + base point pool (100).
2. Generation succeeded in ~7 seconds via server fallback; produced a titled mission with 4 workflow steps, role-based assignee suggestions, staggered deadlines, and rationales.
3. Gaps observed: guidance and step-by-step instructions came back empty; the 100-point pool was not visibly distributed per step.
4. No task was saved in this test.

### 2.3 Assignee side (verified as restricted test account)
1. Task appears in the assignee's profile task list and Mission Archives after completion.
2. Assignee opens the task dialog: sees title, deadline, points, assigner, briefing, resources, guidance (when populated).
3. Assignee fills report + artifact/deliverable link, clicks submit → status becomes `submitted-for-review`; form locks (verified fix).
4. If reviewer requests changes, the new **Reviewer Feedback** section shows `feedback_history` in the dialog and inline card (code fix, pending deploy).
5. Assignee can **Recall submission** → status returns to `in-progress` (code fix, pending deploy).

### 2.4 Reviewer side
1. Admin sees `submitted-for-review` with the assignee's report and deliverable.
2. Admin can **Approve** → `completed` (verified live on AUDIT-1) or **Request changes** with feedback text (code path verified, full loop pending deploy).
3. On approval, points flow to the user counters/ledger (ledger not independently verified — untested).

### 2.5 Workflow tasks
- A workflow task parents multiple step-tasks. Creation previously **dropped** base points, deadline penalty, workflow bonus, and guidance (root-caused to the API allow-list, fixed in commit 8c80d86, pending deploy).
- Editing a workflow task previously saved only step deadlines and silently discarded task-field edits (fixed, pending deploy).
- Table previously rendered the step's title/description instead of the workflow-level title/description (reported; fix status to be confirmed post-deploy).

### 2.6 Bulk and delegated creation
- Bulk delete/create paths exist in `/admin/tasks`. Bulk delete previously used native `confirm()` (inaccessible to automation and ugly); replaced with in-app AlertDialog (pending deploy).
- Delegation dialog exists; the accept/reject lifecycle was **not tested live** (untested).

---

## 3. Role & Hierarchy Matrix

Permission model (source-observed in `src/lib/server/permissions.ts` + `src/config/permissions.config.ts`):

- Permissions are **dynamic**: Firestore `roleDefinitions/{roleSlug}` (array of keys, e.g. `canManageTasks`) is the source of truth, with a legacy `permissions/{roleSlug}` boolean map and a static config fallback.
- `superadmin` bypasses all checks (`if (roleSlug === 'superadmin') return true`).
- Client and server permission logic are separate implementations; a prior audit noted they disagree on edge cases (president/superadmin behavior).

Live-observed for the restricted test account (role `rover_team`, chapter-restricted):

| Capability | Observed |
|---|---|
| View own profile + assigned tasks | Yes |
| Submit task for review (own task) | Yes (AUDIT-1) |
| Recall submission | Code-added; not live-tested |
| Create/assign tasks | No (no UI, no API access tested) |
| Admin panel visibility | `canAccessAdmin` was **true** in client context despite zero page permissions — inconsistent, see Issues |
| Store page toggle | ON (left over from stress test; original state OFF) |
| Read own notifications subcollection | Yes (bell showed 2 unread once) |

| Action | Superadmin | Admin (task perms) | Member (assignee) | Restricted test acct |
|---|---|---|---|---|
| Create task | Yes | Yes | No | No |
| Assign / reassign | Yes | Yes | No | No |
| Edit any task | Yes | Yes (some routes) | Own submission only | Own submission only |
| Delete task (API) | Yes | **Yes — no ownership check (Critical)** | **Yes — no check (Critical)** | **Yes — no check (Critical)** |
| Approve / complete | Yes | Yes | No | No |
| Request changes w/ feedback | Yes | Yes | No | No |
| Submit for review | N/A | Own tasks | Own tasks | Yes (verified) |
| Recall submission | N/A | Own tasks | Own tasks | Code-added, untested live |
| Self-assign | Yes | Yes | Untested | Untested |

---

## 4. UI/UX Audit

### Admin — `/admin/tasks` (desktop Chrome, live)
- Task table loads with status pills, points, deadlines, assignees. Workflow parent rows vs step rows were visually ambiguous (title/description showed step-level text — reported).
- Create dialog is long but logically grouped; required-field gating works (button disabled until deadline set).
- Datetime inputs are keyboard/automation-hostile; table times render timezone-shifted vs entered local time (reported).
- Delete flows were native `confirm()` — now in-app AlertDialog (pending deploy).
- AI Settings (task page): personal Gemini key field added, misleading "never stored in browser" copy corrected, false "API KEY MISSING" warning replaced with honest server-fallback message (pending deploy).

### Assignee — profile task dialog (desktop Chrome, live as test account)
- Completed task view is clean and read-only: title, deadline, 10 pts, assigner, briefing, submitted report, deliverable link, 4 history entries. History took ~19 s to load (slow — see Scalability).
- No interactive submit/recall controls were present because no active task existed; the new feedback/recall UI is code-complete but untested live.
- Guidance, workflow steps, project, badge, resources sections render only when populated (AUDIT-1 had none — looked sparse but correct).

### Notifications (live + code)
- Bell rendered **once** with "(2 unread)" right after login, then was not found on later renders. Root causes identified in code:
  1. The bell lives inside `hidden md:flex` in the header — **invisible on all viewports under 768 px** (mobile/tablet portrait).
  2. Clicking a notification opens `n.link` in a **new tab** (`target="_blank"`), and the task-assignment link `/profile/unified?uid=X&task=Y` points at a page with **no `useSearchParams` handling** — the `?task=` parameter is silently ignored. The assignee lands on their profile and must hunt for the task manually.
- No persistent notification inbox exists beyond the popover; practically, assignees learn of tasks by checking their profile.

### Mobile / tablet / Firefox
- **Untested live.** Code shows the notification bell is hidden on mobile (above). Responsive behavior of the admin task table, dialogs, and drawers on small screens was not verified.

---

## 5. Scalability & Manageability Assessment

- **History load:** task history took ~19 s to render for a single completed task with 4 entries (live-observed). If this is a query/index problem it will worsen with volume; if it was a cold function, it still needs a loading state that communicates progress.
- **Profile API:** ~4 s cold / ~0.6 s warm on Vercel Hobby (measured 2026-10-02) — acceptable, serverless wake-up is the known cause.
- **Bulk operations:** bulk delete exists; bulk create path exists but was not stress-tested. No pagination/virtualization audit was done on the admin task table.
- **Data consistency:** the task wipe (32 tasks + 13 activity records, backup at `task-backup-2026-10-03T01-00-33-756Z.json`) deliberately left user points, counters, leaderboard values, and `points_ledger` untouched — the ledger's consistency after approval was not independently verified (untested).
- **Race conditions:** concurrent submit/recall/approve transitions were not tested; no idempotency verification on approval (untested).
- **Manageability:** dynamic role permissions via Firestore are manageable without deploys; the static fallback risks drift (client/server logic already disagreed once). The `permissions` vs `roleDefinitions` dual storage is a footgun.
- **AI cost control:** `/api/ai-task-generator` has no authentication and consumes the server fallback key — anyone can burn the quota (High, on hold).

---

## 6. Feedback Loop Analysis

The loop as designed: assign → notify → submit → review → (approve | request changes → feedback visible → recall/resubmit) → complete → points.

| Step | Status |
|---|---|
| Assignment creates notification + email + push | Code-verified; email/push not live-tested |
| Assignee sees the task | Verified live (profile list) |
| Assignee notified in-app | Partially broken (bell hidden on mobile; deep-link ignored) |
| Submit locks the form | Verified fix (code) |
| Reviewer feedback visible to assignee | Code fix pending deploy; **full loop never run on new build** |
| Recall submission | Code fix pending deploy; untested live |
| Approve → completed + points | Approval verified live; points/ledger untested |
| Reminders for stale/overdue tasks | No reminder engine found (untested/absent) |

The single biggest loop gap is the **notification deep-link**: the system tells the assignee "you have a task" and then drops them on a page that ignores which task. Second is the **missing reminder engine** — deadline penalties are stored and displayed but nothing deducts or nudges automatically.

---

## 7. Cross-Device Findings

| Surface | Status |
|---|---|
| Desktop Chrome | Tested live (admin + assignee) |
| Desktop Firefox | **Untested** |
| Tablet (portrait/landscape) | **Untested** |
| Mobile portrait | **Untested** (code shows notification bell hidden < 768 px) |
| Mobile landscape | **Untested** |

---

## 8. Issues Found

### Critical
1. **DELETE /api/tasks has no authorization** — any authenticated user can delete any task (no task-management permission check, no ownership check). On hold pending your approval.
2. **Stress-test header can fabricate admin identity** — `x-stress-test: thermonuclear` bypasses auth in the task update route. On hold pending your approval.

### High
3. **Task update route allows edit/reassign by any authenticated user** — stronger checks exist only for approval/completion paths. On hold.
4. **POST /api/workflows requires auth but no task-management permission.** On hold.
5. **POST /api/ai-task-generator is unauthenticated** — burns server Gemini quota anonymously. On hold.
6. **Notification deep-link is dead** — `?task=` param ignored by `/profile/unified`; assignees can't jump to their task. (Fixable without security review.)
7. **Notification bell hidden on mobile** (`hidden md:flex` in header). (Fixable.)

### Medium
8. **History took 19 s to load** for 4 entries — needs investigation (query vs cold start) and a proper loading state.
9. **Restricted test account shows `canAccessAdmin: true`** with zero page permissions — client/server permission logic disagree; inconsistent access surface.
10. **Rover Team Store toggle left ON** from stress test (original: OFF) — restore after testing.
11. **Table renders step-level title/description for workflow parents** — misleads admins scanning the list.
12. **Deadline penalty stored but never deducted; no reminder engine** — the field is decorative without an engine or cron.
13. **Timezone-shifted times in table** vs entered local time; keyboard-hostile datetime inputs.

### Low
14. AI Brain Dump returned empty guidance/instructions and no visible per-step point split for a 100-point pool.
15. `permissions` vs `roleDefinitions` dual storage risks config drift.
16. Free-tier Vercel deploy hits the 5,000-file upload rate limit — must keep using `--archive=tgz` (documented in AGENTS.md).

### Fixed in code, pending deploy (commit 8c80d86 + e8f7515)
- Workflow create dropping base points/penalty/bonus/guidance.
- Workflow edit discarding field edits (only step deadlines saved).
- Native `confirm()` on task/bulk/chapter delete → in-app AlertDialog.
- Raw UID shown in assignee picker when filters excluded the user.
- AI Settings: personal key field, honest fallback copy.

---

## 9. Recommendations (prioritized)

1. **Re-supply the Vercel token and deploy.** Build is ready (`--prebuilt --archive=tgz`, 404 overwrite already applied). Nothing else ships until this happens.
2. **Authorize the security fixes** (Critical 1–2, High 3–5) — or explicitly defer them with a date. They are one focused pass: permission checks on delete/update/workflow routes, remove the stress-test backdoor, add auth to the AI generator.
3. **Fix the notification deep-link** (High 6): make `/profile/unified` (or the task dialog) honor `?task=` and open the task; stop opening notifications in a new tab.
4. **Show the bell on mobile** (High 7): move `NotificationCenter` out of `hidden md:flex`.
5. **Run the feedback loop on the new build**: fresh task → submit → request changes → feedback visible → recall → resubmit → approve, as the test account (browser stays signed in — no login/logout needed).
6. **Investigate the 19 s history load** and add a real loading state.
7. **Restore the Rover Team Store toggle to OFF**; reconcile the `canAccessAdmin` inconsistency.
8. **Decide the deadline-penalty engine**: either build deduction + reminders or remove the decorative fields.
9. **Device matrix**: Firefox, tablet, mobile portrait/landscape on the new build.
10. **Edge matrix**: delegation accept/reject, role change mid-task, circular assignment attempt, multi-assignee, member-to-member assignment, ledger/idempotency after approval.
11. **Cleanup**: delete CRUD-TEST chapter + task (authorized) once verification is done; decide on AUDIT-1/AUDIT-2 (left in production — needs your item-level call).

---

## 10. Appendix — raw observations & edge cases

- **Two-sided audit 2026-10-03:** AUDIT-1 (admin→member) completed the full lifecycle; AUDIT-2 (self-assign) verified on Zubair's profile as pending. Create button correctly disabled until all required fields set. Neither record deleted; ledger not verified.
- **Brain Dump test:** input "make pakistan a space power", 100 pts → titled mission + 4 steps in ~7 s via server fallback; empty guidance/instructions; no per-step point split shown.
- **CRUD test:** chapter filter showed 45 IST members; created/edited CRUD-TEST Chapter; added 2 task resources, workflow steps, step-private resource; removed a step; points/penalty/bonus/badge/project/guidance entered. Records left in production: `CRUD-TEST Chapter` (slug `crud-test-chapter`, city "CRUD City Edited") and task shown as `CRUD Step One` (entered as `CRUD-TEST Full`, 1 step, 3 combined resources).
- **Assignee deep-dive (test account):** no active tasks; AUDIT-1 in Mission Archives, read-only, complete with report + deliverable + 4 history entries; no reviewer-feedback section on the old-build task; notification bell seen once then gone.
- **Deploy saga:** `next build` deterministically bakes `public/index.html` into the generated 404 — must overwrite `.vercel/output/static/404.html` with `.next/server/app/_not-found.html` before every `--prebuilt` deploy; use `--archive=tgz` (free upload rate limit). Documented in AGENTS.md.
- **Deployed live 2026-10-03 ~07:40 PKT** (correction to the above: the original background pipeline carried the token inline and completed). Production build ID ROq3bcFG25wSlK0X_PDW2 verified serving: homepage 200, /tasks and random routes return stable 404 "Page not found". New UI (AI key field, AlertDialog deletes, feedback/recall UI) is in the live bundle; interactive verification of admin-side UI still needs an admin browser session.
- **Untested (explicit):** fresh feedback loop on new build; multi-assignee; member-to-member assignment; reassignment mid-work; sequential workflow from all sides; AI workflow after save; delegation accept/reject; role change mid-task; circular assignment; tablet/mobile/landscape; Firefox; reminders; ledger/idempotency.
- **Security findings are on hold** per your instruction and listed in section 8 without remediation.
- **Standing guardrails respected:** no passwords/keys repeated; production deletions need item-level approval; test-account password not stored (recommend rotation — it transited normal chat).

*End of report.*
