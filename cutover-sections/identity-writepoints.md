# Identity write-point census — users + roles family

Companion to `identity-design.md` (same folder). Base tree:
`feat/supa-cutover` @ `b1c5d5bd` (= live merge tree), read in
`~/workspace/fix-ab/wt-supa-cut-identity`. All line numbers are that tree.

## Method (grep-driven, then read-verified)

1. Candidate generation, three passes over `src/**/*.{ts,tsx}` excluding
   `__tests__` and `*.test.*`:
   (a) every file containing a literal for `users`, `roles`,
   `roleDefinitions`, `permissions`, `role_permissions`, `roleHistory`,
   `role_requests` (203 files) cross-cut with every Firestore write verb
   (`.set/.update/.add/.delete`, modular `setDoc/updateDoc/addDoc/deleteDoc`,
   `batch.*`, `tx./t./transaction.*`, `writeBatch`, `runTransaction`);
   (b) every direct-ref pattern (`collection('users').doc(...).<write>`,
   `doc(db,'users',...)`, `users/{uid}/<sub>` paths, `.collection(...)`
   chains off a users doc);
   (c) every modular-SDK write in client code (`src/app`, `src/components`,
   `src/hooks`, `src/firebase`, non-server `src/lib`) with its ref resolved.
2. Every candidate was then **read at the site** and its ref variable
   resolved to a concrete collection/path before inclusion. False
   positives removed (e.g. `Map.set`, `URLSearchParams.set`, writes to
   `tasks`, `events`, `audit_logs` in files that also read users).
3. Mirror state was verified per site by reading for a post-commit
   mirror call (`mirrorRoleWriteToSupa`, `mirrorSeamSet/Delete`,
   `mirrorNotification*`, `mirrorUserSkill*`, `supaMirrorUpdate`,
   seam set/update) — never assumed from the file's cluster.

Counts (grouped rows; a row covering several lines is one logical
write point — same handler, same payload shape, same commit):
**§A 53 rows (U-01..U-53; 52 runtime + 1 ops script), §B 27 subcollection
rows (S-01..S-27), §C 25 roles-family rows (R-01..R-25), §D 17
client-direct rows (C-01..C-17, three of which cross-reference §B).**
Expanding grouped rows to individual call sites, the surface is
~140 call sites.

Mirror-state vocabulary: `mirrored` = a best-effort Supa mirror runs
after the Firestore commit today (flag-gated, non-throwing);
`unmirrored` = Firestore only today; `primary-switched` = the site
already writes Supa INSTEAD of Firestore when its surface flag is ON
(single-write switch, no dual-write); `n/a` = not a Firestore data write
(Auth plane / trigger row pointing at the real point).

Transaction vocabulary: `plain` = single awaited write; `batch` = inside
a `WriteBatch` committed by that handler/lib; `tx` = inside
`runTransaction`; `store-tx` = inside `withLifecycleStore` (real
transaction when the handle supports it, sequential awaited writes as
fallback — `src/lib/server/lifecycle-ratification.ts:108-135`).

---

## A. `users/{uid}` — server writes

| ID | File:line | Trigger | Tx | Mirror today | Hazard notes |
|---|---|---|---|---|---|
| U-01 | `src/lib/server/role-writes.ts:842` `batch.set(userRef, mirror, {merge})` | `assignRole` — THE chokepoint (routes: admin/roles/write, admin/roles/assign, discipline restore, lifecycle-probation restore, reconciliation bootstrap/repair) | batch | **mirrored** — post-commit re-read via `mirrorRoleWriteToSupa` (`role-writes.ts:571-605,982`) mirrors roles+users+roleHistory | Mirror payload is the RE-READ doc, not the batch payload (sidesteps `FieldValue.delete()`). Mirror writes `role/displayRole/roleSource/additionalRoles` only; the roles doc is R-01 in the same batch. |
| U-02 | `src/lib/server/role-writes.ts:1132` `batch.set(userRef, {role:'member_basic',…})` | `removeRole` | batch | **mirrored** (same chokepoint, `:1186`) | Roles doc is batch-DELETED in the same commit (R-03); mirror delete-mirrors it. |
| U-03 | `src/lib/server/role-writes.ts:1227` `users.doc(uid).set(mirror,{merge})` | `setMirror` — reconciliation repair path only | plain | **unmirrored** (deliberate in the port; pinned by its mirror test) | The one chokepoint-family writer with NO mirror: fs_users goes stale on every repair until another mirrored write touches the uid. |
| U-04 | `src/app/api/admin/sync-user-role/route.ts:197` `users.doc(uid).set(update,{merge})` | POST sync-user-role: custom-title update OR roles-mirror repair (repair is gated on exact match with the roles record's effective role) | plain | **unmirrored** — route comment: "the users write below … stays Firestore-primary with no mirror from this route" | Writes identity-projection fields (`role/displayRole/additionalRoles/roleSource`) — a stale fs_users here directly poisons the directory + bundle fallback. Busts identity at `:198ff`. |
| U-05 | `src/app/api/profile/[userId]/route.ts:691` `users.doc(userId).set(allowed,{merge})` | PUT profile (allow-listed fields only) | plain | **unmirrored** (the profile seam in this route is read-side; no mirror call in the handler) | Busts identity only when the payload carries chapterId (`:640`). |
| U-06 | `src/app/api/admin/hierarchy/user/route.ts:92` `newUserRef.set({email,displayName,role,displayRole,chapterId,managerId,…})` | POST hierarchy/user — creates a shell user (auto-ID, NOT a Firebase uid) | plain | **unmirrored** | Creates a doc whose id is not an Auth uid; a Supa primary write must preserve auto-ID semantics (adapter setDoc with a generated id). Its DELETE is retired (410) — no users delete exists here. |
| U-07 | `src/app/api/admin/hierarchy/add-existing/route.ts:71` `userRef.update({chapterId?,managerId?})` | POST add-existing member to chapter | plain | **unmirrored** | chapterId is an identity-projection field; busts at `:76`. |
| U-08 | `src/app/api/admin/hierarchy/move/route.ts:49` `t.update(userRef,{managerId})` | POST hierarchy/move | tx | **unmirrored** | Only identity-adjacent field is managerId (not bundle-projected). |
| U-09 | `src/app/api/admin/hierarchy/relationships/route.ts:184` `users.doc(subordinateId).update({managerId:null,…})` | DELETE relationships (legacy-field clear) | plain | **unmirrored** | Same class as U-08. |
| U-10 | `src/app/actions/chapter-applications.ts:243` `users.doc(applicantId).update({chapterId})` | Chapter approval: founder's chapterId (`.catch`-swallowed) | plain | **unmirrored** — in-code flag: "CROSS-CLUSTER … they stay on Firestore" | Swallowed failure: under inversion the primary write must NOT stay swallowed (see design §3, class P-2). Busts at `:252`. |
| U-11 | `src/app/actions/chapter-applications.ts:268` `writeBatch.update(doc.ref,{chapterId})` per team member | Chapter approval: founding-team chapterId, chunks of 30 by email lookup | batch | **unmirrored** (same flag) | Email-keyed fan-out; busts per chunk. |
| U-12 | `src/app/actions/chapter-applications.ts:383` `batch.update(doc.ref,{chapterId:FieldValue.delete()})` | Chapter delete: disassociate ALL chapter members, 500-doc chunks, looped | batch (loop) | **unmirrored** (same flag) | Unbounded fan-out (whole chapter). No per-user bust in this loop (verified: none in the delete path) — bundle staleness rides the 30 s TTL today. |
| U-13 | `src/app/api/applications/status/route.ts:334` `users.doc(caller.uid).set(usersMirror,{merge})` | PATCH applications/status — domainPreferences mirror only | plain | **unmirrored** — in-code flag: "CROSS-CLUSTER … stays on Firestore exactly as today" | Only fires when `domainPreferences` is in the body (usersMirror otherwise null). |
| U-14 | `src/app/api/admin/founder-review/route.ts:141` `tx.update(userRef, userUpdate)` | Founder review `revoke_sanction`: clears suspension, conditionally `isBanned=false`, `warningCount` recompute | tx | **unmirrored** | **Auth-critical:** writes `users.isBanned`, a bundle-projected field. Busts at `:158`. Audit write inside the same tx (governance audit, other cluster). |
| U-15 | `src/app/api/admin/founder-review/route.ts:203` `tx.update(userRef, userUpdate)` | Founder review `reinstate`: `isBanned=false`, conditionally `isBlacklisted=false`, points refund, `warningCount` | tx | **unmirrored** | Same auth-critical class as U-14. Role restore after the tx goes through role-writes (U-01/R-01). Busts at `:216`. |
| U-16 | `src/lib/server/discipline/apply-decision.ts:267` `tx.update(userRef,{warningCount})` (strike1; warning doc is S-23) | Discipline decision strike1 | tx | **unmirrored** | warningCount is NOT bundle-projected, but the same tx writes the warnings subcollection. |
| U-17 | `src/lib/server/discipline/apply-decision.ts:271-276` `tx.update(userRef,{privilegesSuspendedUntil,suspendedFrom,suspensionCaseId,warningCount})` | Discipline decision strike2 | tx | **unmirrored** | Suspension fields; not bundle-projected. |
| U-18 | `src/lib/server/discipline/apply-decision.ts:422` `tx.update(userRef,{isBanned:true,…,warningCount})` | Board-vote expulsion applied | tx | **unmirrored** | **Auth-critical:** sets `isBanned=true`. Busts at `:442`. Shadow mode writes NOTHING on users (by design). |
| U-19 | `src/lib/server/discipline/apply-decision.ts:535` `tx.update(userRef, userUpdate)` | Founder-review modification applied (strike reduction; may clear `isBanned`) | tx | **unmirrored** | Auth-critical class. Busts at `:547`. |
| U-20 | `src/lib/server/discipline/derived-counter.ts:59` `tx.update(userRef,{warningCount})` + `:115` `userRef.update({warningCount})` | (a) write-through helper used inside discipline txs; (b) nightly `reconcileWarningCounts` drift correction | tx / plain | **unmirrored** | (b) is a census-style sweep over users WITH cases. |
| U-21 | `src/lib/server/member-lifecycle.ts:186` `userRef.update({memberStatus:'departed',departedAt,departedBy,departReason})` | POST admin/users/[uid]/depart → `departUser` | plain | **unmirrored** | Also R-10/R-11 in the same flow. Busts at `:230`. |
| U-22 | `src/lib/server/member-lifecycle.ts:204` `batch.update(docSnap.ref,{managerId:null})` per direct report | depart cascade | batch | **unmirrored** | Fan-out over `users where managerId==uid`. |
| U-23 | `src/lib/server/member-lifecycle.ts:277` `userRef.update({memberStatus:'active',departedHistory:[…]})` | POST admin/users/[uid]/reinstate → `reinstateUser` | plain | **unmirrored** | Read-modify-write of the `departedHistory` ARRAY (not arrayUnion — deliberate, see code comment). A primary-side RMW must preserve this. Busts at `:295`. |
| U-24 | `src/lib/server/lifecycle-ratification.ts:537` `store.update(userRef,{role:landing})` | Board refusal revocation: mirror half (roles half is R-09) | store-tx | **unmirrored** | Writes ONLY `role` on users — **not displayRole, not additionalRoles** (asymmetric mirror; see hazard H-06). Busts at `:584` only when a revocation actually happened. |
| U-25 | `src/lib/server/governors/shared.ts:132` `batch.set(users.doc(holderUid),{role:roleKey,displayRole:roleKey,…},{merge})` (`grantGovernorRole`) | Governor seating (register.ts seat/transfer flows) | batch (caller-owned) | **unmirrored** — bypasses role-writes entirely (code comment: "Deliberately NOT Phase 1's resolver or the consent-gated assign route") | **No roleHistory, no audit-in-batch, no mirror.** Writes the identity mirror directly. Caller busts (register W14 / term-sweep W15). |
| U-26 | `src/lib/server/governors/register.ts:557` `batch.set(users.doc(holderUid),{previousRole:currentRole,…},{merge})` | Governor seating: stash prior role before grant | batch | **unmirrored** | Roles half is R-07 (`:562`). `previousRole` is the restore source for U-27/R-08 — cross-store consistency is load-bearing. |
| U-27 | `src/lib/server/governors/shared.ts:172` `batch.set(users.doc(holderUid),{role:prior,displayRole:prior,previousRole:delete},…)` (`restorePriorRole`) | Governor vacate/remove/term-sweep | batch (caller-owned) | **unmirrored** | Prior role read from users first, roles fallback, else `'member'` (not member_basic). |
| U-28 | `src/lib/server/leave-return.ts:312` `batch.update(userRef, userUpdate)` (chunk 0 only) | `returnFromLeave` ← POST user/post-vacation, universal-review leave path | batch (chunked) | **unmirrored for users** — the same function's leave_audit/leave_requests writes ARE mirrored; comment scopes the mirror to "leave-owned docs only" | Clears vacation flags. Chunked batches (tasks in later chunks) make this a multi-commit flow. |
| U-29 | `src/app/api/admin/users/restore-workload/route.ts:181` `batch.update(userRef,{isOnVacation:false,vacationMode:false,leaveRequestId:delete})` | POST admin/users/restore-workload (return path) | batch | **unmirrored for users** (leave docs mirrored, `:233-239`) | Same flag-clear class as U-28, second implementation. |
| U-30 | `src/app/api/admin/universal-review/route.ts:135` `batch.set(userRef,{skillIds:arrayUnion(…)},{merge})` | Universal review: skill extraction from an approved item | batch | **unmirrored** — route header comment: "Side-effect docs (points ledger, skills, user flags) are not mirrored here" | Creates skill docs in the same batch (skills cluster). |
| U-31 | `src/app/api/admin/universal-review/route.ts:652` `batch.set(userRef,{total_points:increment,points:increment,…},{merge})` | Universal review approve-with-points | batch | **unmirrored** (same comment) | **Increment payload** — no absolute mirror exists (see hazard H-04). |
| U-32 | `src/app/api/admin/universal-review/route.ts:784` `batch.set(leaveUserRef,{isOnVacation:true,vacationMode:true,coveringOfficerId,…,leaveRequestId},{merge})` | Universal review: leave approval side effect | batch | **unmirrored** (same comment) | Vacation flags ON. |
| U-33 | `src/app/api/submissions/route.ts:327` `batch.set(userRef,{points:increment,submissionsApprovedCount:increment},{merge})` | Submission review approve | batch | **unmirrored** — explicit in-code note (`:427-428`): "the users.points increment is likewise not mirrored (an increment has no safe absolute-value mirror)" | Increment class. |
| U-34 | `src/app/api/admin/bug-reports/route.ts:107` `batch.set(userRef,{points:increment,total_points:increment},{merge})` | Bug-report PATCH with points award (idempotent per report) | batch | **unmirrored** (no mirror call in the route for users) | Increment class; ledger doc in same batch. |
| U-35 | `src/app/api/cron/process-dlq/route.ts:206` `batch.set(userRef,{total_points:increment,points:increment,tasksCompletedCount:increment},{merge})` | Cron DLQ retry of a failed points award (ledger-existence guarded) | batch | **unmirrored** | Cron trigger; increment class. |
| U-36 | `src/app/api/tasks/route.ts:1844` `userRef.set({tasksAssignedCount:increment(1),lastTaskAssignedAt},{merge})` | POST /api/tasks create (per assignee) | plain | **unmirrored** (handler mirrors task docs + the S-09 notification only) | Counter class. |
| U-37 | `src/app/api/tasks/route.ts:718,721,749` `batch.set(users.doc(…),{tasksAssignedCount:increment(±1),…},{merge})` | PATCH /api/tasks workflow-step edit (reassign / new step) | batch | **unmirrored** | Counter class, 3 sites in one handler. |
| U-38 | `src/app/api/tasks/route.ts:788` `batch.set(users.doc(stepAssignee),counterUpdates,{merge})` | PATCH /api/tasks step deletion | batch | **unmirrored** | Counter class. |
| U-39 | `src/app/api/tasks/route.ts:839,846` `batch.set(users.doc(old/newUid),{tasksAssignedCount:increment(∓1)},…)` | PATCH /api/tasks assignee swap | batch | **unmirrored** | Counter class. |
| U-40 | `src/app/api/tasks/route.ts:2251` `userRef.set(updates,{merge})` | DELETE /api/tasks (counter decrement) | plain | **unmirrored** | Counter class. |
| U-41 | `src/app/api/tasks/batch/route.ts:94` `batch.set(userRef,updates,{merge})` (increment decrements) | POST tasks/batch delete | batch | **mirrored** — `mirrorBatchTaskDeletes` (`src/lib/supa/seam-admin-tasks.ts:328-355`) applies the decrements to fs_users as absolute RMW updates post-commit | The ONLY counter site with a mirror, and its mirror is RMW-absolute (race class H-04). Mirror is under the **tasks** surface flag, not users. |
| U-42 | `src/app/api/tasks/delegate/route.ts:182` `batch.set(users.doc(uid),{tasksAssignedCount:increment(1),…},{merge})` | POST tasks/delegate (per assignee) | batch | **unmirrored** (only its notifications mirror, S-10) | Counter class. |
| U-43 | `src/app/api/workflows/route.ts:271` `users.doc(aid).set({tasksAssignedCount:increment(1),…},{merge})` | POST /api/workflows step creation (per assignee) — **PINNED ROUTE: cited read-only, do not open beyond this** | plain | **unmirrored** | Counter class inside the pinned route; its notification (S-18) is notifications residual #2. Any change here needs the single-agent W4 slot + pin re-proof. |
| U-44 | `src/lib/supa-events/tickets.ts:452` `tx.update(userRef,{eventsAttended:arrayUnion(…)})` | Ticket issue (events cluster seam) | tx | **unmirrored** (events dual-write mirrors registrations/tickets, not this users update) | Cross-cluster writer into users; events TX workstream (W2) owns the tx primitive it rides. |
| U-45 | `src/app/api/webhooks/firestore/route.ts:190,197` `tx.update(userRef,{points:increment,totalHoursWorked:increment,tasksCompletedCount:increment,…})` (+ badges arrayUnion) | Webhook `handleTaskWritten` reward transaction | tx | **unmirrored** (only the tx's notifications mirror, S-17) | Webhook plane: the trigger source itself is Firestore events (program-level replacement question, design §4). Rewards subcollection write in same tx is S-22. |
| U-46 | `src/app/api/webhooks/firestore/route.ts:250` `users.doc(userId).update({badges:arrayUnion(…),updatedAt})` | Webhook `handleUserWritten` badge award on points increase | plain | **unmirrored** | Self-triggering class: this write is itself a users-write event (loop guard is the points-delta condition). |
| U-47 | `src/app/api/webhooks/firestore/route.ts:295` `users.doc(userId).update({email_lowercase,updatedAt})` | Webhook `handleUserWritten` email sync (skip-if-missing) | plain | **unmirrored** | Fires on nearly every users write incl. sign-up; NOT_FOUND swallowed by design. |
| U-48 | `src/app/api/skills/assign-bulk/route.ts:47` `batch.set(ref,{skillIds:arrayUnion(skillId)},{merge})` per uid | POST skills/assign-bulk | batch | **mirrored** — `mirrorUserSkillGrants` (`src/lib/server/skills-supa.ts:248-268`) RMW-unions onto fs_users post-commit | Mirror gated on the **skills** surface; RMW class. |
| U-49 | `src/app/api/skills/route.ts:206` `batch.set(d.ref,{skillIds:arrayRemove(id)},{merge})` per holder doc | Skill DELETE detach (chunked batches of 400) | batch (chunked) | **mirrored** — `mirrorUserSkillRevoke` per holder (`skills-supa.ts:273-293`) | RMW class; fan-out over all holders. |
| U-50 | `src/lib/retention/erasure.ts:121-127` `users.doc(uid).set({...TOMBSTONE_FIELDS,erasedAt},{merge})` | Erasure execution (cron/retention + admin path) | plain | **unmirrored** (compliance consumers unwired per DEPLOY_READY_REPORT) | Tombstone REPLACES profile fields by merge of tombstone constants. Auth user deletion is a separate step in the same flow (Auth plane, untouched by this program). Busts at `:164`. Roles half is R-12. |
| U-51 | `src/lib/server/push-server.ts:96` `users.doc(userId).update({…push token fields})` | Server push registration/dispatch path | plain | **unmirrored** | High-frequency, low-value fields — design §3 class P-4. |
| U-52 | `src/app/api/cron/clear-probation/route.ts:229` `batch.update(userDoc.ref, userUpdate)` (`warningCount`, `activeWarningCount`) | Cron clear-probation, per user with expired warnings | batch (per user) | **unmirrored** | Warnings half is S-25 in the same batch. |
| U-53 | `src/scripts/backfill-searchable-index.ts:27` `batch.update(doc.ref,{searchableIndex})` | One-off ops script (not a runtime path) | batch | **unmirrored** | Non-runtime; listed so the build wave does not mistake it for a live writer. Exclude from inversion; re-run story is a data note only. |

Verified negatives (users): **no production code deletes a `users/{uid}`
doc** (hierarchy DELETE is retired/410; erasure tombstones; depart
soft-deletes). `src/app/api/admin/users/route.ts` is GET-only (directory;
its `:385` hit is an in-memory response cache). Depart/reinstate routes
(`admin/users/[uid]/*`) delegate entirely to member-lifecycle (U-21..23).

---

## B. `users/{uid}` subcollections — server + route writes

Subcollection rows land in Supabase as `fs_group_<name>` rows keyed by
`(parent_path, id)` (adapter `tableForCollection`, `src/lib/supa/adapter.ts:400-439`);
`parent_path = 'users/{uid}/<name>'`. The dump reconciled the
**notifications** family only via `fs_group_notifications`; **warnings,
activity, rewards, votes have no reconciled fs_group table in the
64-file dump** (no dump file exists for them) — see design hazard H-07.

| ID | File:line | Path / trigger | Tx | Mirror today | Hazard notes |
|---|---|---|---|---|---|
| S-01 | `src/lib/server/notification-service.ts:67` `notifRef.set(payload)` | `users/{uid}/notifications` — `notificationService.send` (the platform-wide in-app notification chokepoint) | plain | **mirrored** — `mirrorNotificationCreate(userNotificationsPath(uid),…)` (`notifications-supa-seam.ts`), gated on `SUPA_SURFACES=notifications` | Mirror surface is **notifications**, not users. Under users-primacy this seam must not double-primary (design §3 N-class). |
| S-02 | `src/lib/server/notification-service.ts:91` `notifRef.update(updates)` | notifications — delivery-status updates (`deliveryStatus.push/email`, dot-path keys) | plain (fire-and-forget `.then`) | **mirrored** — `mirrorNotificationUpdate` after the Firestore update settles | Dot-path update keys are passed through to the adapter (expands them). |
| S-03 | `src/lib/server/notification-service.ts:193` `batch.set(notifRef,data)` per recipient | notifications — `broadcastByRoles` | batch (500-chunks) | **mirrored** post-commit | Fan-out. |
| S-04 | `src/lib/notification-helper.ts:133` `notificationRef.add(data)` | notifications — `createNotificationToUser` | plain (add) | **mirrored** | Auto-ID add: primary-side id generation must be preserved under inversion. |
| S-05 | `src/lib/notification-helper.ts:176` `batch.set(notificationRef,data)` per user | notifications — `createAdminNotification` (role-targeted) | batch | **mirrored** post-commit | (The same file's top-level `notifications` add at `:209` is the GLOBAL collection, not this census.) |
| S-06 | `src/lib/server/validation-notifications.ts:33` `notifRef.set(data)` | notifications — task validation notifications | plain | **mirrored** | |
| S-07 | `src/app/api/notifications/route.ts:190,205` `col.doc(id).update({isRead:true})` | notifications — PATCH mark one / mark all read | plain | **mirrored** — `mirrorNotificationUpdate` per doc | Mark-all is a Promise.all fan-out of plain writes, not a batch. |
| S-08 | `src/app/api/notifications/route.ts:252` `…collection('notifications').doc(id).delete()` | notifications — DELETE | plain | **mirrored** — `mirrorNotificationDelete` | The only subcollection DELETE in the family. |
| S-09 | `src/app/api/tasks/route.ts:169` `notifRef.set(notifData)` (ref at `:163`) | notifications — task-route notification helper | plain | **mirrored** (GAP-N1) | |
| S-10 | `src/app/api/tasks/delegate/route.ts:197` `batch.set(notifRef,notifData)` | notifications — delegation fan-out | batch | **mirrored** post-commit | Its users counter (U-42) in the same batch is NOT mirrored. |
| S-11 | `src/app/api/tasks/[id]/activity/route.ts:238` `notifRef.set(…)` | notifications — rejection-feedback notification | plain | **mirrored** (mirror call follows the set) | |
| S-12 | `src/app/api/submissions/route.ts:191` `batch.set(notifRef,notifData)` | notifications — notify admins of new submission | batch | **mirrored** post-commit | |
| S-13 | `src/app/api/submissions/route.ts:412` `batch.set(notifRef,notifData)` | notifications — notify submitter of decision | batch | **mirrored** post-commit | |
| S-14 | `src/app/api/admin/universal-review/route.ts:501` `notifRef.set(notifData)` | notifications — leave revoked | plain | **mirrored** | |
| S-15 | `src/app/api/admin/universal-review/route.ts:828` `batch.set(notifRef,notifData)` | notifications — review decision | batch | **mirrored** post-commit | |
| S-16 | `src/app/api/webhooks/firestore/route.ts:152` `batch.set(notifRef,notifData)` | notifications — task-assigned (webhook create path) | batch | **mirrored** post-commit | Webhook plane (see U-45 note). |
| S-17 | `src/app/api/webhooks/firestore/route.ts:202` `tx.set(notifRef,notifData)` | notifications — task-complete (inside reward tx) | tx | **mirrored** post-tx only | Mirror is queued in-tx, flushed after commit — the pattern inversion must generalize for tx writers (design §3 T-class). |
| S-18 | `src/app/api/workflows/route.ts:290` `…collection('notifications').doc().set(…)` | notifications — workflow assignment fan-out, **PINNED ROUTE, cited read-only** | plain | **unmirrored** — DEPLOY_READY_REPORT notifications residual #2 (no helper exists inside the pinned route) | Lands only in the W4 single-agent slot with pin re-proof. |
| S-19 | `src/app/admin/resources/page.tsx:263` `addDoc(sub, payload)` where `sub = collection(doc(db,'users',uid),'notifications')` (`:262`) | notifications — admin resources page, CLIENT-direct | plain (add) | **unmirrored** — DEPLOY_READY_REPORT notifications residual #3 | Client-direct class (design §3 C-class): no server seam exists to invert; needs an API-route or client-seam decision first. |
| S-20 | `src/components/notifications/notification-center.tsx:471` `updateDoc(ref,{isRead:true})`; `:487` mark-all `updateDoc(doc(db,'users',uid,'notifications',id),{isRead:true})` | notifications — CLIENT-direct mark-read | plain | **unmirrored** (bypasses the S-07 route entirely) | Two live writers for the same field (route + component) with different mirror states — collision hazard H-02. |
| S-21 | `src/app/api/webhooks/firestore/route.ts:118,131,220` `users.doc(uid).collection('activity').add(…)` | `users/{uid}/activity` — task deleted/created/updated feed | plain (add) | **unmirrored** | No reconciled fs_group_activity load; no reader seam serves it in the identity scope. |
| S-22 | `src/app/api/webhooks/firestore/route.ts:199` `tx.set(userRef.collection('rewards').doc(taskId),{…},{merge})` | `users/{uid}/rewards` — reward ledger (webhook tx) | tx | **unmirrored** | DEPLOY_READY_REPORT: "webhook rewards-subcollection retirement" is a gamification flip gate. The pinned gamification tx writes its own ledger to top-level `points_ledger`, not here. |
| S-23 | `src/lib/server/discipline/apply-decision.ts:249` `tx.set(warningRef,{kind:'formal_warning',…})` (ref at `:226`) | `users/{uid}/warnings` — strike1 formal warning | tx | **unmirrored** | No fs_group_warnings table in the dump. Profile route READS this subcollection (uncached) — read path stays Firestore until a table + seam exist. |
| S-24 | `src/app/api/admin/founder-review/route.ts:144` `tx.update(warningRef,{status:'revoked'})` | warnings — revoke_sanction | tx | **unmirrored** | |
| S-25 | `src/app/api/cron/clear-probation/route.ts:213` `batch.update(wdoc.ref,{isActive:false,status:'probation_cleared',…})` | warnings — expiry archival, per expired warning | batch | **unmirrored** | |
| S-26 | `src/app/profile/unified/[uid]/page.tsx:50,83` `tx.set(voteRef,{type,voterUid,…})` + `:51,84` `tx.update(targetRef,{upvotes/downvotes:increment(1)})` | `users/{uid}/votes/{voterUid}` + the target's `users/{uid}` counters — CLIENT transaction | tx (client) | **unmirrored** | Client-tx class: cannot invert without a server route (design §3 C-class). The counter half is also a users/{uid} write (increment). |
| S-27 | `src/components/community/leaderboard.tsx:206,212` `tx.set(voteRef,…)` + `tx.update(targetRef,{…increment(1)})` | votes + counters — CLIENT transaction (second implementation of the same vote) | tx (client) | **unmirrored** | Duplicate implementation of S-26; both must be handled or neither. |

---

## C. Roles family — server writes

Family scope: `roles/{uid}`, `roleDefinitions/{slug}`,
`permissions/{slug}`, `role_permissions/{slug}`, `roleHistory`,
plus `role_history` (a DIFFERENT collection — R-11) and
`role_requests` (R-23..25) as named adjacencies.

| ID | File:line | Path / trigger | Tx | Mirror today | Hazard notes |
|---|---|---|---|---|---|
| R-01 | `src/lib/server/role-writes.ts:829` `batch.set(roleRef, roleDoc, {merge})` | `roles/{uid}` — `assignRole` chokepoint | batch | **mirrored** via chokepoint re-read (`:982`) | Composes primary + additionalRoles + chapterId + expiry quintet (`expiresAt/expiresRoleKey/priorRole/priorAdditionalRoles/expiryAlertStage`, with `FieldValue.delete()` clears). Idempotency: replay path commits NOTHING and mirrors nothing (pinned). |
| R-02 | `src/lib/server/role-writes.ts:869` `batch.set(historyRef, historyPayload)` | `roleHistory` — same assign batch | batch | **mirrored** with `createdAt` rewritten to an ISO string (`:597`) | serverTimestamp has no jsonb equivalent; fs_roleHistory consumers must never expect Timestamp shapes. |
| R-03 | `src/lib/server/role-writes.ts:1131` `batch.delete(roleRef)` (conditional on existence) | `roles/{uid}` — `removeRole` | batch | **mirrored** (delete-mirror via re-read absence, `:1186`) | No-op-success branch (no doc + mirror already member_basic) commits nothing. |
| R-04 | `src/lib/server/role-writes.ts:1163` `batch.set(removeHistoryRef, removeHistoryPayload)` | `roleHistory` — remove batch (action 'delete') | batch | **mirrored** (as R-02) | |
| R-05 | `src/lib/server/role-writes.ts:829,842,869` via exported `addRoleChangeToBatch(db,batch,…)` | roles+users+roleHistory composed into a CALLER-owned batch | batch (caller) | **n/a — mirror does NOT run** (the helper cannot know when/if the caller commits; caller contract: bust after own commit, stamp claims after own commit — header at `:590ff`) | **No external caller exists today** (verified in the identity map). Any future caller silently opts out of mirroring AND, under primacy, out of primary writes. Pin it (contract IC-14). |
| R-06 | `src/lib/server/governors/shared.ts:127` `batch.set(roles.doc(holderUid),{role:roleKey,grantedBy,grantedAt},{merge})` (`grantGovernorRole`) | `roles/{uid}` — governor seating | batch (caller-owned) | **unmirrored** | Writes ONLY role/grantedBy/grantedAt by merge — additionalRoles/chapterId of any existing doc survive; a roles doc may be CREATED here with no chapterId/additionalRoles. No roleHistory entry. |
| R-07 | `src/lib/server/governors/register.ts:562` `batch.set(roles.doc(holderUid),{previousRole:currentRole},{merge})` | `roles/{uid}` — seating stash (users half U-26 at `:557`) | batch | **unmirrored** | Adds a `previousRole` field to the roles doc that role-writes never writes — shape divergence inside one collection (H-05). |
| R-08 | `src/lib/server/governors/shared.ts:162` `batch.set(roles.doc(holderUid),{role:prior,…,previousRole:delete},{merge})` (`restorePriorRole`) | `roles/{uid}` — vacate/remove/term-sweep | batch (caller-owned) | **unmirrored** | Prior defaults to `'member'`. |
| R-09 | `src/lib/server/lifecycle-ratification.ts:528` `store.update(roleRef,{role:landing,roleKey:landing,currentRoleKey:landing})` | `roles/{uid}` — Board refusal revocation | store-tx | **unmirrored** | Writes THREE role-key fields (`role`, `roleKey`, `currentRoleKey`) — role-writes writes only `role`. Shape divergence (H-05). Landing role is the post-revocation default (`member_basic` per the bust comment at `:584`). |
| R-10 | `src/lib/server/member-lifecycle.ts:106` `roleRef.update({memberStatus})` (only if the doc exists) | `roles/{uid}` — depart/reinstate status mirror | plain | **unmirrored** | Conditional update (never creates). |
| R-11 | `src/lib/server/member-lifecycle.ts:101` `db.collection('role_history').add({uid,action,actorUid,at})` | **`role_history` (underscore)** — depart/reinstate history | plain (add) | **unmirrored** | NOT `roleHistory`. Backup registry (`src/lib/backup/registry.ts:43,110`) records the rename tension: "Phase 1 renames/supersedes by role_history". The dump contains `roleHistory.json` only; there is no reconciled `fs_role_history`. Do NOT conflate (H-05). |
| R-12 | `src/lib/retention/erasure.ts:132` `roleRef.update({memberStatus:'erased'})` (only if exists) | `roles/{uid}` — erasure | plain | **unmirrored** | Pair of U-50. |
| R-13 | `src/lib/server/custom-role-expiry-sweep.ts:372` `roles.doc(uid).update({expiryAlertStage:dueStage})` | `roles/{uid}` — expiry warn-stage stamp (cron custom-role-expiry-sweep) | plain | **mirrored** — `supaMirrorUpdate('roles', uid, {expiryAlertStage})` at `:373`, via the R19 seam | The ONLY non-chokepoint roles write with a mirror today. Its expiry materialisation path goes through assignRole (R-01). |
| R-14 | `src/lib/server/consent-gate.ts:358` `db.collection(target.collection).doc(target.id).set({consentMode:'record',consentGateLoggedAt},{merge})` with target `roles/{targetUid}` (`stampTarget`, `:280`) | `roles/{uid}` — consent-gate RECORD-mode stamp for `user_role` subjects | plain | **unmirrored** | A hidden writer: fires inside `assertConsentFor` (record mode) on role routes, chapter routes, partners routes. Adds governance fields to the roles doc. Failure is caught/logged (never fails the gate). |
| R-15 | `src/lib/server/consent-gate.ts:358` (same line) with target `roleDefinitions/{slug}` (`stampTarget`, `:273`) | `roleDefinitions/{slug}` — record-mode stamp for `role_definition` subjects | plain | **unmirrored** | Same hidden-writer class; also stamps chapters + generic records (other clusters). |
| R-16 | `src/app/api/admin/role-permissions/route.ts:667` `batch.set(rdRef, updateData, {merge})` | `roleDefinitions/{slug}` — POST save (drawer or path-model payload) | batch | **mirrored** — `mirrorSeamSet('roleDefinitions', slug, updateData)` at `:676` | One batch writes all three definition stores (R-16/17/18) atomically; mirrors are three separate post-commit sets (non-atomic on the Supa side — H-03). Busts both permission-doc tiers (`:683-684`). |
| R-17 | `src/app/api/admin/role-permissions/route.ts:668` `batch.set(role_permissions.doc(slug), rolePermissionsData, {merge})` | `role_permissions/{slug}` — POST save | batch | **mirrored** at `:677` | `role_permissions` ≠ `permissions`: the client walk's second tier vs the server walk's second tier (identity map §3/R13 note). |
| R-18 | `src/app/api/admin/role-permissions/route.ts:669` `batch.set(permissions.doc(slug), permissionsDocData, {merge})` | `permissions/{slug}` — POST save (boolean-map shape incl. `_scope`, or allowedPaths shape) | batch | **mirrored** at `:678` | **`permissions/founder_patron` is written ONLY here and R-19/R-20 deletes** — there is no seed/bootstrap writer in src (grep-verified). The `_scope` field in this doc is the FD-20 surface (design H-08). |
| R-19 | `src/app/api/admin/role-permissions/route.ts:834-836` `batch.delete` ×3 | `roleDefinitions` + `role_permissions` + `permissions` — DELETE definition (holder-fenced, consent-gated) | batch | **mirrored** — `mirrorSeamDelete` ×3 at `:841-843` | Busts both tiers. |
| R-20 | `src/app/api/admin/roles/[slug]/route.ts:180,183,187` `batch.delete(roleRef/permissions/role_permissions)` (+ audit set in same batch) | All three definition stores — DELETE definition (nuclear route; holder-fenced, catalog-blocked, consent-gated) | batch | **mirrored** — `mirrorSeamDelete` ×3 at `:208-210` | Second door for the same act as R-19; both must invert identically or not at all. |
| R-21 | `src/lib/role-definitions.ts:207` `setDoc(doc(firestore,'roleDefinitions',slug),{slug,name,description,createdAt,updatedAt},{merge})` via client wrapper | `roleDefinitions/{slug}` — `upsertRoleDefinition` (client/shared lib) | plain | **primary-switched** — seam-first at `:195-205`: when the roles client flag is ON, the write goes through `/api/roles/reads` and lands in **Supabase only** (Firestore copy goes stale by design, parity matrix R12); when OFF, the Firestore setDoc at `:207` runs | **Already inverted in effect, keyed on SUPA_SURFACES only.** Under flag law this site must re-key to `isSupaPrimary('roles')` semantics or be explicitly grandfathered — design §2.3. Timestamp shape differs per backend (ISO via seam, serverTimestamp direct). |
| R-22 | `src/app/api/roles/reads/route.ts:251-259` `writeDoc()`: adapter set/update if the roles surface is ON, else Admin-SDK `ref.set/update` | Generic seam route POST — writes allowed ONLY for `roleDefinitions` (manager-gated) and `role_requests`; writes to `roles`/`permissions`/`role_permissions` are refused (400) | plain | **primary-switched** (single-write, backend chosen per request) | This is the server half of R-21/R-23..25. Its backend choice is the whole write — there is no second copy to mirror. |
| R-23 | `src/lib/role-request.ts:103` `setDoc(roleRequestRef, roleRequestData)` via client wrapper | `role_requests` — create (seam attempt precedes it at `:85-95`) | plain | **primary-switched** — seam-first via `/api/roles/reads`; Firestore setDoc is the fallback when the seam declines | Adjacent family (requests, not definitions). Lifecycle writes R-24/25 follow the same pattern. |
| R-24 | `src/lib/role-request.ts:247` `updateDoc(roleRequestRef,{status:'approved',handledBy,handledAt})` via wrapper | `role_requests` — approve | plain | **primary-switched** — `seamUpdateDoc` first; wrapper updateDoc is fallback | handledAt is ISO via seam, serverTimestamp direct (shape split, H-03). |
| R-25 | `src/lib/role-request.ts:308` `updateDoc(…{status:'rejected',…})` via wrapper | `role_requests` — reject | plain | **primary-switched** (as R-24) | |

Verified negatives (roles): the client role libs
(`src/lib/role-management.ts` assign/remove/custom/sync/delete) perform
**no direct Firestore writes** — all delegate to
`/api/admin/roles/write` or `/api/admin/sync-user-role` (read-verified).
`src/app/api/admin/roles/write` and `/assign` perform no direct writes
themselves; they delegate to role-writes (R-01..R-04).
`src/app/api/v1/roles/route.ts` is read-only. The
`roles/{uid}` `onSnapshot` listener in `src/firebase/user-provider.tsx`
is a READ (deferred seam, never-bulk) — its imported `setDoc` is unused
for identity docs; the provider's heal path calls `ensureUserProfile`
(C-02).

---

## D. Client-direct `users/{uid}` writes (browser, web SDK / wrapper)

No server seam stands between these and Firestore today. NONE of them
is mirrored (except where the wrapper/seam note says otherwise). All
are `plain` unless noted. Design class C (identity-design §3): they
cannot invert in place — the browser never writes Supabase (no-RLS
rule) — so each needs a server route or an explicit stay-Firestore
decision.

| ID | File:line | Trigger / payload | Mirror today |
|---|---|---|---|
| C-01 | `src/components/auth/google-only-auth-form.tsx:275,479` `setDoc(userDocRef, userProfileData, {merge})`; `:293,504` `setDoc(userDocRef, backfill, {merge})` | Sign-in/sign-up profile create + field backfill (two form flows, same shape) | unmirrored |
| C-02 | `src/lib/auth/ensure-user-profile.ts:50` `setDoc(ref, backfill, {merge})`; `:57` `setDoc(ref, buildNewUserProfileData(user), {merge})` | `ensureUserProfile` heal: create-if-missing / backfill, called from user-provider + auth form | unmirrored |
| C-03 | `src/components/sections/join-us-section.tsx:88` `setDoc(userDocRef, userProfileData, {merge})` | Join-us signup profile create | unmirrored |
| C-04 | `src/components/auth/mandatory-profile-check.tsx:69` `setDoc(doc(firestore,'users',uid), {…profile completion})` | Mandatory profile completion gate | unmirrored |
| C-05 | `src/app/welcome/page.tsx:96` `updateDoc(userDocRef, {university,department,profileCompletedAt})` | Welcome onboarding form | unmirrored |
| C-06 | `src/app/terms-and-conditions/page.tsx:100` `updateDoc(userRef, {termsAccepted,termsAcceptedAt,termsVersion})` | Terms acceptance | unmirrored — note the profile seam's `termsAcceptedAt` pass-through pin (users G4): shape must survive whichever backend serves the profile read |
| C-07 | `src/app/induction/page.tsx:258` `updateDoc(doc(db,'users',uid), {hasApplied:false,applicationStatus:null})` | Induction re-apply reset | unmirrored |
| C-08 | `src/app/induction/page.tsx:629` `batch.set(doc(db,'users',uid), flagUpdate, {merge})` (writeBatch at `:619`, with the applications doc) | Induction submit: `hasApplied:true, applicationStatus:'pending'` flags | unmirrored — the applications half is mirrored by the applications workstream; the users half is not |
| C-09 | `src/app/admin/applications/page.tsx:278` `updateDoc(doc(db,'users',applicationId), {applicationStatus, hasApplied:false on reject})` | Admin applications page: decision mirror to the user doc (best-effort) | unmirrored |
| C-10 | `src/components/admin/inspectors/generic-inspector.tsx:239` `updateDoc(doc(db,'users',docId), {applicationStatus,…})` | Universal-inbox inspector: same decision mirror, second implementation | unmirrored — duplicate of C-09 (H-02) |
| C-11 | `src/components/admin/users/award-badge-dialog.tsx:106` `updateDoc(doc(firestore,'users',userUid), {badges:arrayUnion(slug)})` | Admin award-badge dialog | unmirrored |
| C-12 | `src/components/notifications/notification-preferences.tsx:94,136` `updateDoc(doc(firestore,'users',uid), {vibrationEnabled})` / `{emailNotifications}` | Notification preference toggles | unmirrored |
| C-13 | `src/lib/push-notifications.ts:85,114` `updateDoc(userRef, {…})` ×2 | Client push subscription/token registration | unmirrored — pair of server U-51 |
| C-14 | `src/app/admin/resources/page.tsx:262-263` | = S-19 (client notifications add) | unmirrored |
| C-15 | `src/components/notifications/notification-center.tsx:471,487` | = S-20 (client notifications mark-read) | unmirrored |
| C-16 | `src/app/profile/unified/[uid]/page.tsx:45-51,78-84` | = S-26 (client vote tx: votes subcollection + users counters) | unmirrored |
| C-17 | `src/components/community/leaderboard.tsx:199-212` | = S-27 (client vote tx, duplicate) | unmirrored |

---

## E. Adjacent / Auth-plane writes (NOT Firestore data writes — listed so nobody "inverts" them by accident)

| ID | Site | What it is | Class |
|---|---|---|---|
| X-01 | `src/lib/server/role-writes.ts:80-120` `stampRoleClaims` (`setCustomUserClaims`, called `:857ff/917ff/1114ff` sites in assign/remove/replay) | Firebase Auth custom claims `{role, chapter_id}` merge-stamp after role commits | Auth plane — untouched by this program. Under primacy its INPUTS come from the primary write result, never from a Firestore re-read. |
| X-02 | `src/app/api/webhooks/firestore/route.ts:251-255` (chapter change claims sync) and `:296-310` (`handleRoleWritten` claims REPLACE) | Auth claims writes from webhook events | Auth plane + webhook plane. The `:296` writer REPLACES the whole claims object (vs X-01's merge) — recorded divergence in the identity map §5.2; the mirror-write half of `handleRoleWritten` is RETIRED (Phase 1 note in code) — it writes no users doc. |
| X-03 | `src/lib/retention/erasure.ts` step 4 `deps.deleteAuthUser(uid)` | Auth account deletion inside erasure | Auth plane — untouched. |
| X-04 | `src/lib/authority-refresh.ts:22,83` `setDoc(refreshRef,…)` on `authority_refresh/{uid}` | The claims-refresh signal doc that role-writes also batch-writes (`role-writes.ts:891,1177`) | NOT in the identity family scope (own collection, no fs_ table in the dump list beyond `authority_refresh.json` — it WAS dumped). Recorded here because role-writes batches it; the chokepoint mirror deliberately does NOT mirror it. Inversion of R-01/R-03 must keep writing it on the Firestore side OR replace the signal — the client listener (`authority-refresh.ts`) reads it from Firestore. Design §2.4. |
| X-05 | Pinned gamification transaction `src/lib/server/gamification-transaction.ts` — **read-only citation only, per program rules**: `t.set(userRef, uUpdates, {merge})` at `:269`, badge arrayUnions `:273,276`, notification sets `:281,439`, delegatee sets `:315,347`, chapter/parent sets `:356,375`, per-step user sets `:389,474`, activity set `:481` | `users/{uid}` points/counters/badges + `users/{uid}/notifications` writes inside the task-completion transaction | PINNED. Its users writes are unmirrored today (notifications residual #1, ×3 sites). Inversion is owned by the C-07 serialized step (W2), NOT by this workstream's build wave. Census records the surface; design §4 excludes it. |
| X-06 | `src/lib/supa/gamification.ts:216` `adapter.setDoc('users', userId, updates, {merge})` | The gamification SEAM's Supa-side counter write (claim-first award path) | Already a Supa write, gated by the gamification surface (which stays OFF). Not an identity writer; listed because under users-primacy this becomes a second primary writer into fs_users (H-01). |
| X-07 | `src/lib/supa/seam-tasks-lists.ts:397` generic `adapter.setDoc(collectionPath,…)` mirror + `src/lib/server/supa-roles-reconcile-seam.ts:313-317` `supaMirrorUpdate` helper | Generic mirror machinery that CAN write users/roles rows when other surfaces' mirrors pass those paths | Infrastructure, not a write point. The reconcile seam's mirror-update is the mechanism under R-13. |

---

## F. Census completeness notes

- **Triggers, not just sites:** every server lib above was also checked
  for its callers; delegating routes/components are named in the Trigger
  column rather than double-counted (e.g. roles/write + roles/assign →
  R-01..R-04; depart/reinstate → U-21..23/R-10/R-11; discipline routes →
  apply-decision; cron shells reconcile-roles / governors-term-sweep /
  retention / custom-role-expiry-sweep → their libs).
- **Cron shells with NO identity writes** (verified): cron/backup
  (reads Firestore as source of record by the inversion rule),
  cron/check-deadlines + cron/remind-deadlines (writes go through
  notification libs = S-01/S-06 and task libs), cron/governance
  (lifecycle libs above), cron/consent-deadlines (consent-service —
  consent collections only), cron/elections-lifecycle (election ports).
- **Excluded after verification** (files that mention the family but
  write only other collections): `src/app/api/appointments/shared.ts`
  (audit_logs), `src/lib/server/hierarchy.ts` (reporting_relationships),
  `src/lib/server/consent-service.ts` (consent/obligation collections),
  `src/lib/server/election-ports.ts`, `src/lib/finance/money-approval.ts`
  (finance workstream), `src/lib/applications-client-supa.ts`
  (inventory strings describing C-08/C-09-class writes, not code).
- **The "~60 write points" estimate** in the program brief reconciles
  as: the 52 runtime server users points (U-01..U-52) + the users
  halves of the roles chokepoint counted inside them + the §D
  client-direct users sites it likely also had in view; the full
  identity surface incl. subcollections and the roles family is
  **122 grouped write points (~140 call sites)** — the brief's number
  counted only the top-level users sites.
