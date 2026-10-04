# Security Model: Hierarchical Validation — Server-Side Design

**Status:** design only (read-only exercise). No code modified, no data touched, no deploys.
**Branch:** `feat/remediation-harness-complete`
**Date:** 2026-10-04
**Author:** Design Agent 8/8

This document specifies how the server enforces **"only someone above the submitter (or the assigner) may approve"** with no privilege escalation. It is grounded in the actual codebase:

- `src/lib/auth-middleware.ts` — `verifyAuthentication`, `withAuth`, `requireAuth`
- `src/lib/server/permissions.ts` — `hasServerPermission`, `resolveUserRole`, `assertChapterAccess`
- `src/lib/server/hierarchy-utils.ts` — `isManagerAbove` (BFS walk of `reporting_relationships` + legacy `users.managerId`)
- `src/app/api/tasks/route.ts` — existing hierarchy-aware review grant + assigner override (lines ~300–420)
- `src/app/api/admin/hierarchy/relationships/route.ts` — admin CRUD for `reporting_relationships` (DAG cycle detection via DFS)
- `firestore.rules` — current rule surface (no `reporting_relationships` rule exists at all)
- `src/lib/audit-logging.ts` — `logAuditEntry` interface

---

## 1. Authorization check pseudocode

Dedicated endpoint: `POST /api/tasks/[taskId]/validate` — decision is a *server-mediated
state transition*, never a client-side task-field write. (The existing `PATCH /api/tasks`
path that lets any manager flip `status: approved` stays as the fallback only when
`validate=true`; the dedicated endpoint is the canonical path and is what the UI calls.)

```
handler(request, taskId):
  # ── STEP 1: AUTHENTICATE ──────────────────────────────────────────────
  # Lives in: src/lib/auth-middleware.ts :: verifyAuthentication(request)
  #   - extracts Bearer token or __session cookie
  #   - rejects dev_token outside development
  #   - admin.auth().verifyIdToken(token)  → decoded.uid is THE validator identity
  #   - parallel fetch: roles/{uid}.role (source of truth for role) +
  #     users/{uid} (isBanned check)
  #   - banned → 401
  auth = verifyAuthentication(request)      # 401 on failure

  # ── STEP 2: LOAD TASK + INPUT VALIDATION ───────────────────────────────
  # Lives in: the route handler itself (zod strict schema)
  body = parse({ decision: enum('approve','reject'), reason: string(min 1 when reject),
                 lastUpdatedAt?: string })  # optimistic concurrency, as in PATCH /api/tasks
  taskSnap = db.collection('tasks').doc(taskId).get()  # Admin SDK, bypasses rules
  404 if !exists
  task = taskSnap.data()
  409 if body.lastUpdatedAt && task.updatedAt.toISO() != body.lastUpdatedAt

  # ── STEP 3: STATE PRECONDITION ─────────────────────────────────────────
  # Lives in: the route handler
  # A validation decision is only meaningful while work is awaiting review.
  if task.status != 'submitted-for-review':  → 409
    ("decision requires status submitted-for-review; current=<status>")

  # ── STEP 4: DETERMINE SUBMITTER (server-recorded, never client-claimed) ─
  # Lives in: the route handler; written by the submission path (see §3)
  submitterUid = task.submittedBy
  if !submitterUid: → 422  # legacy task submitted before submittedBy existed;
                           # requires one-time backfill, not an approve

  # ── STEP 5: RESOLVE VALIDATOR CHAIN ─────────────────────────────────────
  # Lives in: src/lib/server/hierarchy-utils.ts
  #   isManagerAbove(managerId, subordinateId) walks UP from the submitter
  #   through reporting_relationships.subordinateId→managerId edges (direct +
  #   dotted), plus legacy users/{uid}.managerId fallback; BFS, maxDepth 20,
  #   self-exclusion built in.
  #   ALSO snapshot the exact edges traversed for the audit log (see §4, §7).
  { isAbove, chainEdges } = isManagerAboveWithPath(auth.uid, submitterUid)

  # ── STEP 6: CHECK AUTHORITY (order matters — deny-first) ───────────────
  # Lives in: the route handler, using src/lib/server/permissions.ts helpers
  allowed = false; basis = null

  # 6a. SELF-APPROVAL — always denied, even if everything else would allow it
  if auth.uid == submitterUid:                          → 403  (self-approval)
  # 6b. PEER APPROVAL — isManagerAbove already returns false for peers
  #     (managerId === subordinateId → false; same-rank peers have no
  #      upward path to each other), so no separate check is needed —
  #      but it MUST NOT be bypassed by the role-grant below.
  # 6c. HIERARCHY CHECK
  if isAbove:                         allowed = true; basis = 'hierarchy'
  # 6d. ROLE GRANT — only after 6a–6c. Must NOT be blanket canManageTasks:
  #     that permission is the admin backdoor and must not silently include
  #     "may approve anyone's work". Use a NARROW permission key:
  elif hasServerPermission(auth.role, 'canValidateTasks'):  # NEW key, off by default
                                      allowed = true; basis = 'canValidateTasks'
  # 6e. ASSIGNER OVERRIDE — the person who assigned the work may validate it
  #     (existing semantics in PATCH /api/tasks), but NEVER themselves (6a wins)
  elif task.assignerId == auth.uid:    allowed = true; basis = 'assigner'
  else:                               → 403 ("not above submitter, not assigner")

  # 6f. CHAPTER SCOPING (after authority is established, before decision)
  if basis == 'hierarchy' || basis == 'assigner':
     scope = assertChapterAccess(db, auth.uid, submitterUid)  # permissions.ts
     if !scope.allowed: → 403  # explicit mismatch denied; missing data fail-open + logged
     # note: global roles (superadmin/admin/president_national/...) bypass by design

  # 6g. ROLE-FRESHNESS GUARD (from the AI-assign audit: roles/{uid}.role and
  #     users/{uid}.role can diverge after demotions)
  validatorRole = resolveUserRole(db, auth.uid)   # users/{uid}.role first, displayRole fallback
  if validatorRole != auth.role:  # stale auth-context role → use server-resolved
     auth.role = validatorRole; re-evaluate 6d

  # ── STEP 7: APPLY DECISION ATOMICALLY ───────────────────────────────────
  # Lives in: the route handler; Firestore transaction
  tx.run():
     re-read task (status must still be submitted-for-review — TOCTOU guard)
     if decision == 'approve':
        task.status = 'approved'          # or next workflow step per flow rules
     else:  # reject
        task.status = 'changes-requested'
     task.validatedBy = auth.uid            # server-set
     task.validatedAt = serverTimestamp()
     task.validationBasis = basis           # 'hierarchy' | 'canValidateTasks' | 'assigner'
     task.validationReason = body.reason
     task.feedback_history = arrayUnion({ admin_id: auth.uid, timestamp: now(),
                                          text: body.reason, previous_status: 'submitted-for-review' })
     task.submittedBy = FieldValue.delete() # single-use token: prevents double-decision
                                            # (any further decision requires a fresh submit)

  # ── STEP 8: AUDIT + NOTIFY ─────────────────────────────────────────────
  writeAuditLog(auditEntry)   # §4 — via Admin SDK, never client-writable
  notify(submitterUid, decision, reason)  # existing notification service
  return 200 { taskId, decision, basis }
```

### Where each step lives (summary)

| Step | Concern | Home |
|---|---|---|
| 1 | Authenticate (identity = Firebase ID token) | `src/lib/auth-middleware.ts` |
| 2 | Load task, zod-strict parse, optimistic concurrency | route handler + `src/lib/input-validation.ts` |
| 3 | State precondition (`submitted-for-review`) | route handler |
| 4 | Submitter identity (server-recorded) | task doc `submittedBy`, written by submission path |
| 5 | Validator chain resolution (BFS upward walk) | `src/lib/server/hierarchy-utils.ts` |
| 6 | Authority decision (deny-first ordering) | route handler, helpers in `src/lib/server/permissions.ts` |
| 7 | Atomic state transition (transaction) | route handler |
| 8 | Audit log + notification | `audit_logs` via Admin SDK; `notification-service.ts` |

**Critical property of the ordering:** steps 6a/6b (self, peer) are evaluated *before* any
grant (role, hierarchy, assigner). A later grant can never override an earlier deny —
this is what makes the model escalation-proof rather than grant-permissive.

---

## 2. Anti-escalation analysis

### What stops a user from approving their OWN task?

1. **Step 6a is evaluated first and is unconditional.** `auth.uid == submitterUid → 403`,
   evaluated before hierarchy, role, *and* assigner overrides. This closes the hole in
   today's `PATCH /api/tasks` code, where the assigner override (`assignerId === decoded.uid`)
   has no self-check — an assigner who is also the doer can currently approve their own work.
2. **Identity comes from the verified ID token**, not from any client field; the client
   cannot claim to be someone else.
3. **`submittedBy` is server-written** (see §3); the client cannot omit it to dodge the
   self-check, because a missing `submittedBy` → 422, not "no submitter, allow".

### What stops a peer (same rank) from approving?

- `isManagerAbove(managerId, subordinateId)` returns `false` when the two IDs are equal
  (explicit `managerId === subordinateId → false` guard) and peers have no upward path to
  each other, so the BFS never connects them — no edge, no authority.
- The cycle-detection on the admin side (`wouldCreateCycle`) prevents two users from
  being made each other's manager, which would otherwise manufacture mutual authority.
- Chapter scoping (`assertChapterAccess`) adds a second layer for same-rank users who
  share a manager in *different* chapters: an explicit chapter mismatch is always denied
  for chapter-scoped roles.
- Note: the narrow `canValidateTasks` permission (6d) must remain **off by default** for
  all roles; if enabled for a role, everyone holding that role can validate anyone —
  that is a deliberate org-level grant, not a hierarchy hole, and every use is logged
  with `basis: 'canValidateTasks'` so it is auditable.

### What stops someone from forging "submitter" to widen their own authority?

- The client never supplies `submittedBy`. The update schema is `.strict()` (zod) —
  unknown keys are rejected — but belt-and-suspenders: the handler **deletes any
  client-supplied `submittedBy`/`validatedBy`/`validationBasis`** before applying updates.
- `submittedBy` is written server-side at the submission transition only, from
  `decoded.uid`, in the same transaction that flips `status → 'submitted-for-review'`.
- Why forging submitter would even matter: authority is derived *relative to the
  submitter*. A malicious client claiming "X submitted" doesn't help them approve —
  they'd need to be above X. The real attack is the reverse: an approver colluding to
  re-label the submitter so a *different* (friendly) validator becomes "above". This is
  defeated because (a) only the server writes `submittedBy`, (b) the field is deleted
  after the decision is applied (single-use), and (c) the submitter is the assignee who
  actually performed the submission transition — the route checks `auth.uid ∈
  task.assigneeIds` before allowing the submit transition, mirroring the existing
  field-level authorization in `PATCH /api/tasks`.

### Additional escalation surfaces addressed

| Surface | Mitigation |
|---|---|
| Approving via the generic `PATCH /api/tasks` (`status: approved`) instead of the validate endpoint | Both paths must share one `authorizeValidation()` helper; PATCH keeps the same 6a–6g ordering. Long-term: remove `approved`/`completed` from the generic PATCH allowlist and route all decisions through the validate endpoint. |
| TOCTOU: chain changes between check and write | Decision applied in a Firestore transaction that re-reads task status; chain re-resolved inside the transaction (read-only Admin SDK reads are fine in tx). |
| Double-decision (approve → resubmit-loop spam to farm points) | `submittedBy` deleted after decision; a second decision requires a genuine resubmission (status back to `submitted-for-review` via a server-written `submittedBy`), which is itself rate-limited (§6). Points engine already deducts on late approval. |
| Replay of the validate request | Idempotency via optimistic concurrency (`lastUpdatedAt` mismatch → 409) plus the state precondition: after the first decision, status is no longer `submitted-for-review`, so a replayed request 409s. |
| Stale roles after demotion (AI-assign audit finding) | Step 6g: `resolveUserRole` re-reads `users/{uid}.role` (falling back to `displayRole`) at request time; divergence from the auth-context role is corrected server-side before the permission grant is evaluated. |

---

## 3. Trust model for submitter identity

### Verdict: `submittedBy` does not exist yet — it must be added.

Today the codebase has no `submittedBy` field on tasks (grep confirms: `feedback_history`
uses `admin_id`, submission tracking uses status transitions only). The trust model therefore
**requires a schema addition**, specified here:

**Write rule (server-only, authoritative):**

- In the submission path (`PATCH /api/tasks` when `status → 'submitted-for-review'`, and
  any dedicated submit endpoint), the server sets:
  ```
  submittedBy  = decoded.uid        // from verified ID token, never from body
  submittedAt  = serverTimestamp()
  ```
- In the same transaction. The submit transition is allowed only when
  `decoded.uid ∈ task.assigneeIds` (doer) — assigners/managers cannot submit on someone's
  behalf; the submitter is always the person who did the work.
- Any client-supplied `submittedBy`/`validatedBy`/`validationBasis` keys are stripped
  before the update is applied (and the zod schema stays `.strict()`).
- On decision application (Step 7), `submittedBy` is **deleted** (single-use token).
  This makes the field a capability that exists only while a validation is pending,
  eliminating stale-submitter confusion entirely.

**Read rule:**

- The validate endpoint reads `task.submittedBy`; absence → **422, not a bypass**.
  Legacy tasks submitted before this field existed cannot be approved through the new
  endpoint until backfilled — this is fail-closed by design.

**Backfill (one-time, deterministic, auditable):**

- For tasks currently in `submitted-for-review` with no `submittedBy`: backfill from the
  most recent `feedback_history` submit event if attributable, else from `assigneeId`
  (single-assignee) — and mark `submittedByBackfilled: true` so the provenance is visible.
- Multi-assignee tasks with ambiguous submitter: do **not** guess — leave `submittedBy`
  empty and require the assignees to resubmit. Guessing creates the exact forgery
  surface this model exists to kill.

**Why server-recorded is the only acceptable model:** anything client-claimed lets the
requester choose the reference point their authority is measured against. The field must
be a server-issued fact about a past event (who performed the submit transition), written
in the same transaction as the event itself — it is then as trustworthy as the status
field it accompanies.

---

## 4. Audit: what gets logged per validation

**Where:** the existing `audit_logs` collection, written **server-side via Admin SDK**
(client writes to `audit_logs` are restricted to `actorId == request.auth.uid` creates;
the server path bypasses rules entirely, so no rule change is needed). No new collection
— Zubair's bar says don't build machinery the product already has, and `audit_logs`
with `canViewAuditLogs` gating already exists. Each validation also appends to the
task's own `feedback_history` (visible under the existing `tasks` read rule, §5.3) so the
submitter can see who decided what without audit-log access.

**Audit entry schema** (one doc per validation event, plus one for denied attempts):

```jsonc
{
  "action": "task.validation.approved | task.validation.rejected | task.validation.denied",
  "actorUid": "<validator uid, from ID token>",
  "targetUidOrResource": "tasks/<taskId>",
  "timestamp": "<serverTimestamp>",
  "payload": {
    "taskId": "<taskId>",
    "workflowId": "<workflowId | null>",
    "stepIndex": "<number | null>",
    "submitterUid": "<task.submittedBy at decision time>",
    "submitterRole": "<role slug at decision time>",
    "validatorRole": "<server-resolved role slug, step 6g>",
    "rankRelation": {
      "basis": "hierarchy | canValidateTasks | assigner",
      "depthAboveSubmitter": "<edges between validator and submitter | null>",
      "chainEdges": [["<uid>", "<uid>"], "..."],   // snapshot, see §7
      "edgeTypes": ["direct", "dotted", "legacy"]    // which mapping kinds were used
    },
    "decision": "approve | reject | null (denied)",
    "reason": "<validator-supplied text | null>",
    "previousStatus": "submitted-for-review",
    "deniedAtStep": "<6a|6b|6c|6d|6e|6f — which check denied, for denied events>",
    "clientIp": "<from request headers>",
    "userAgent": "<from request headers>"
  }
}
```

**Retention/query:** admins with `canViewAuditLogs` query by `action` prefix +
`targetUidOrResource`. Denied attempts are logged too — a spike in `task.validation.denied`
for one actor is the abuse signal (§6). The `chainEdges` snapshot is the forensic payload
for the malicious-admin question (§7): even if the hierarchy is later edited, the exact
edges that granted authority are preserved.

---

## 5. Firestore rules: gaps (do NOT edit `firestore.rules` here)

### RULE CHANGE NEEDED 1 — `reporting_relationships` has no rule at all
`firestore.rules` contains **zero** `match` blocks for `reporting_relationships`.
Default-deny means any client read fails. Today that is harmless (the /admin/hierarchy
UI reads through server endpoints with the Admin SDK), and for this design that is the
**recommended posture: keep client reads denied** and resolve the validator chain
exclusively server-side (Step 5). If a future "who can validate my work" UI needs the
chain client-side, the rule to add would be:
`allow read: if isSignedIn() && (resource.data.subordinateId == request.auth.uid || resource.data.managerId == request.auth.uid); allow write: if isSuperAdmin() || hasPermission('canManageUsers');`
Do **not** add a permissive read now — the whole chain lives behind the API.

### RULE CHANGE NEEDED 2 — task discovery for validators ("tasks awaiting my validation")
Current `tasks` read rule: superadmin, `canManageTasks`, `assigneeId == uid`, or
`workflowId != null` (public mission visibility). A validator who is above the submitter
in the hierarchy but holds no `canManageTasks`, is not the assignee, and the task has no
`workflowId` **cannot even list the task** to validate it. Rules cannot walk the chain
(no joins), so a rule-side fix is impossible in the general case. Two options, in
preference order:
- **(a) Server endpoint, no rule change (recommended):** `GET /api/tasks/pending-validation`
  resolves each signed-in user's chain server-side (Admin SDK) and returns the tasks
  awaiting their validation. Zero rule changes, zero over-exposure.
- **(b) Rule change (weaker):** widen `tasks` list to include tasks where the requester
  is a recorded candidate validator — but the candidate set would have to be *written onto
  the task doc* at submit time (e.g. `candidateValidatorUids`), which duplicates the
  chain into denormalized data that can go stale. Only acceptable combined with the
  §7 snapshot discipline; still inferior to (a).

### RULE CHANGE NEEDED 3 — validation history visibility for the submitter
Validation decisions are appended to `task.feedback_history` (§4) precisely so the
submitter sees them under the **existing** `tasks` read rule — no rule change needed.
Do not create a separate `task_validations` collection with its own rule surface; it
would reintroduce the discovery problem of item 2 for no benefit.

### RULE CHANGE NEEDED 4 — `audit_logs` read gating is already correct
`allow read: if isSuperAdmin() || hasPermission('canViewAuditLogs')` — validators do not
need audit-log reads (their view is `feedback_history`). No change. Server writes bypass
rules via Admin SDK — no change.

### Summary table

| # | Gap | Fix | Rule edit? |
|---|---|---|---|
| 1 | `reporting_relationships` unreadable by client (default-deny) | Keep denied; chain resolved server-side only | None (deliberate) — add scoped rule only if a client UI ever needs it |
| 2 | Validators can't discover tasks awaiting them (rule: `canManageTasks` ∨ assignee ∨ `workflowId != null`) | New `GET /api/tasks/pending-validation` (Admin SDK) | None if (a) chosen |
| 3 | Validation history for submitter | Append to `feedback_history` on task doc | None |
| 4 | Audit log visibility | Existing `canViewAuditLogs` gate suffices | None |

---

## 6. Rate / abuse limits

The state machine already provides the strongest guard: a decision is only legal from
`submitted-for-review`, and applying it deletes `submittedBy` and moves status away —
**a second approve/reject is impossible without a fresh, genuine resubmission**.
On top of that, recommend:

1. **Resubmission cooldown:** after a `changes-requested`, the same submitter may not
   re-transition to `submitted-for-review` for 60 seconds (kills accidental double-submit
   loops; also bounds reject→resubmit→reject cycling speed).
2. **Per-validator decision throttle:** max 30 validate-endpoint decisions per validator
   per rolling hour, enforced server-side (in-memory counter keyed by uid is enough on a
   single region; a `rate_limits/{uid}` doc via Admin SDK if multi-instance). Exceeding
   → 429 with `Retry-After`.
3. **Reject-storm alert:** >10 rejections by one validator against the same submitter in
   24h → write an `abuse.flag` audit entry and notify admins. Rejection is the
   harassment vector (approval spam is self-limiting — it just completes work), so the
   asymmetry is intentional.
4. **Reason requirement:** `reject` requires non-empty `reason` (mirrors the existing
   CHANGES REQUESTED MANDATE in `PATCH /api/tasks`); `approve` reason optional.
5. **Client IP + user agent on every audit entry** (§4) so automated probing of the
   endpoint is attributable.

No CAPTCHA, no per-task lock beyond the state machine — the design goal is to make
abuse *impossible by construction* (state precondition + single-use `submittedBy`),
with throttles as defense-in-depth, not as the primary control.

---

## 7. Request-time resolution vs. snapshot — recommendation

Zubair's clarification: the validator chain derives from `reporting_relationships`
(admin-managed at `/admin/hierarchy`, subordinateId→managerId, DAG cycle detection in
`relationships/route.ts`, legacy `users.managerId` fallback).

**The threat:** whoever can edit `reporting_relationships` can widen their own validation
authority — e.g. an admin inserts themselves as the manager of a submitter's chain right
before approving, then removes the edge.

**Recommendation: resolve at request time from LIVE data, and snapshot the used edges
into the audit log.** Justification:

1. **Stale authority is the worse failure.** A snapshot-at-submission freezes authority
   at submit time. If the org changes between submit and review (a manager is demoted,
   a chapter is restructured — both real, recent events on this platform), the snapshot
   grants power to someone who no longer holds it, and denies it to the person who does.
   Live resolution always reflects the admin's current intent, which is the single
   source of truth the whole hierarchy UI is built around.
2. **It matches the determinism bar.** "Same code + same inputs → same state." The
   hierarchy is an admin-managed input; the correct behavior is defined against its
   current value, not a hidden historical copy nobody can see in the UI.
3. **The malicious-admin risk is real but misattributed.** Editing
   `reporting_relationships` already requires `canManageUsers` (per
   `relationships/route.ts`) — the same permission that can already edit roles,
   demote users, and reassign tasks. Someone holding it doesn't *need* to forge a
   hierarchy edge to abuse the system; the edge is not the escalation path, the
   permission is. The fix is not snapshotting (which wouldn't stop a `canManageUsers`
   holder anyway — they'd just snapshot-shop by submitting at a convenient time) but
   **attribution**:
   - All `reporting_relationships` writes must go through `logAuditEntry`
     (verify the admin route does this; if not, add it — writes today record
     `createdBy` on the doc, which is necessary but not sufficient as an audit trail).
   - Every validation decision snapshots `chainEdges` + `edgeTypes` into its audit
     entry (§4), so any "approve under a freshly-inserted edge" is permanently
     attributable to the admin who inserted the edge *and* the validator who used it.
   - Recommend a lightweight anomaly signal: if a `reporting_relationships` edge is
     created and a validation using that edge occurs within 24h, flag it in the audit
     trail (`hierarchy.edge_used_fresh`). This catches the attack shape without
     blocking legitimate reorgs.
4. **The legacy `managerId` fallback is the weakest link in the chain data.** It's a
   plain field on the user doc with no cycle detection and no `createdBy`. Treat it as
   the same trust level as the collection (both admin-managed), but record
   `edgeTypes: ["legacy"]` in the audit snapshot so legacy-edge approvals are
   distinguishable, and recommend the eventual migration: backfill legacy edges into
   `reporting_relationships` and remove the fallback.

**What this means for the pseudocode:** Step 5 resolves live (inside the transaction
in Step 7), and the traversed edges are captured into `payload.rankRelation.chainEdges`.
No `validatorChainSnapshot` field is stored on the task at submit time — storing one
would create a second, divergent source of authority truth that the UI cannot display
and admins cannot reason about.

---

## 8. Open questions / follow-ups for the implementation agent

1. Should `canValidateTasks` be a new granular permission key (default off everywhere),
   or is the hierarchy + assigner model sufficient with superadmin as the only
   backdoor? (This design assumes the new key exists but unused by default.)
2. The existing `PATCH /api/tasks` approve path must be brought under the same
   `authorizeValidation()` helper — or `approved`/`completed` removed from its
   allowlist. Decide before implementation.
3. Confirm `relationships/route.ts` (and DELETE/PUT siblings) emit `logAuditEntry`
   on every write; add if missing.
4. Backfill strategy for legacy `submitted-for-review` tasks without `submittedBy`
   (§3) needs Zubair's sign-off on the "do not guess multi-assignee" rule.
5. `GET /api/tasks/pending-validation` (Rule Gap 2, option a) — new endpoint design
   is out of scope for this doc but blocks the validator UX.

---

*Design complete. No code modified. No data touched. No commits, no deploys.*
