# 02 — Organizational Hierarchy Model

**Research agent 2/8 — revised per Zubair's clarification (2026-10-04 18:49 PKT)**
"Hierarchy" = the org chart managed at **`/admin/hierarchy`**, backed by the
**`reporting_relationships`** Firestore collection. It is a **per-user graph of
reporting edges**, NOT a role-rank ladder. Roles are secondary metadata.

Branch researched: `feat/remediation-harness-complete`. Read-only.

---

## 1. Core data model

### 1a. `reporting_relationships` collection (canonical source)

Each document is one reporting edge:

| Field | Type | Notes |
|---|---|---|
| `subordinateId` | string (user uid) | The person reporting |
| `managerId` | string (user uid) | The person reported to |
| `type` | `'direct' \| 'dotted'` | Direct (solid line) vs dotted-line (matrix) reporting |
| `createdAt` | Timestamp/Date | Set on creation |
| `createdBy` | string | uid/email/'system' of the admin who created it |

- Auto-generated document IDs (`db.collection('reporting_relationships').add(...)`).
- Many-to-many: a user may have **multiple managers** (e.g. one direct + one dotted).
- Queries used in code: `where('subordinateId', '==', X)` (walk up),
  `where('managerId', '==', X)` / `where('managerId', 'in', chunk)` (walk down).
- **No `firestore.rules` match block exists for `reporting_relationships`** (verified —
  429-line rules file has no mention). Rules are default-deny, so the collection is
  effectively **server-only**: all reads/writes go through the Admin SDK API routes.
- Enforced at creation: no self-reporting, both users must exist, duplicate edges
  deduped (type update only), **DAG cycle detection** before write.

### 1b. Legacy `managerId` on user docs (fallback)

- `users/{uid}.managerId`: single string (or null) — the older single-manager model.
- `users` GET at `/api/admin/hierarchy/users` merges both sources per user:
  `managerIds = [collection edges]` → if empty, fall back to
  `[{ managerId: <legacy>, type: 'direct' }]`. Legacy `managerId` is also returned
  for backward compatibility.
- Other legacy fields written by various routes: `managerUpdatedAt`, and on delete
  `managerIdClearedAt` / `managerIdClearedBy`.

### 1c. ⚠️ Source-divergence hazard (gap)

Different writers update different sources:

| Route | Writes `reporting_relationships` | Writes `users.managerId` |
|---|---|---|
| POST `/api/admin/hierarchy/relationships` (add edge) | ✅ | ❌ |
| POST `/api/admin/hierarchy/move` (reassign) | ❌ | ✅ (transaction) |
| POST `/api/admin/hierarchy/add-existing` (assign chapter/manager) | ❌ | ✅ |
| POST `/api/admin/hierarchy/user` (create user) | ❌ | ✅ (`managerId: managerId \|\| null`) |
| DELETE `/api/admin/hierarchy/relationships` (remove edge) | ✅ (batch delete) | ✅ only if it matches (cleared to `null`) |
| DELETE `/api/admin/hierarchy/user` (delete user) | ❌ | ✅ cascade-nulls reports |

Consequence: the two sources can **contradict each other**. Every read path that
matters merges both (walk-up in `wouldCreateCycle`/`isManagerAbove`, walk-down in
`workload`, `my-team`, profile, `tasks/team`), so readers are safe — but a pure
`reporting_relationships` query can miss legacy-only edges and vice versa.
Any new "who is above X" logic MUST query both, mirroring the merge pattern.

---

## 2. DAG cycle detection

**File:** `src/app/api/admin/hierarchy/relationships/route.ts` → `wouldCreateCycle()`

- Before POSTing a new edge, DFS **walks UP from the proposed `managerId`** through:
  1. all `reporting_relationships` where `subordinateId == current`, then
  2. the legacy `users/{current}.managerId`.
- If it reaches the proposed `subordinateId`, reject with **409** and the full
  cycle path (`A → B → C`).
- Immediate self-report (`subordinateId === managerId`) rejected.
- Visited-set prevents infinite loops on corrupted data.

Simpler variant in `move` and `add-existing` routes: inline upward walk of the
**legacy `managerId` chain only** (max 100 hops), rejecting `409` on "Cannot report
to your own subordinate." — note these do NOT consult `reporting_relationships`,
a second instance of the source-divergence hazard.

## 3. UI: /admin/hierarchy

- Thin page (`src/app/admin/hierarchy/page.tsx`, 54 lines) with a chapter picker →
  `HierarchyCanvas` (`src/components/admin/hierarchy/hierarchy-canvas.tsx`) →
  `HierarchyGraph` (`src/components/admin/hierarchy/hierarchy-graph.tsx`, ReactFlow).
- Canvas fetches `/api/admin/hierarchy/users?chapterId=...` (needs `canViewHierarchy`);
  creates/deletes go through the relationships API (needs `canManageUsers`).
- `direct` and `dotted` edges are both rendered; type is stored but no route
  filters by it (workload BFS traverses all edge types).
- Chapter scoping: UI and relationships GET filter by `chapterId`; edges are
  **not** chapter-constrained (a manager in one chapter can manage across chapters).

## 4. Chain-resolution options, ranked by reliability

**Question: "who is above user X?"**

### Option 1 — Walk up `reporting_relationships` (+ legacy fallback). ✅ CANONICAL
The machine-readable reporting chain. Recipe (mirrors `wouldCreateCycle`):

```
managers(X) =
  reporting_relationships.where(subordinateId == X) → [managerId, type]
  ∪ (users/X.managerId if the collection returned nothing)
chain(X) = BFS: managers(X), managers(managers(X)), ... (visited set, max depth ~20)
```

- Produces the ordered chain(s) of superiors, edge type per hop.
- Handles multi-manager (dotted-line) users — returns all lines, not one.

### Option 2 — Legacy `users.managerId` alone. ⚠️ FALLBACK ONLY
Single scalar; misses collection-only edges and multi-manager users.
Only reliable for users created before the collection existed. Always prefer
Option 1's merged read.

### Option 3 — Role-rank metadata. ❌ DO NOT USE for reporting chains
- Static `ROLE_HIERARCHY` (`src/lib/roles.ts`) has **only two entries**:
  `superadmin: 11`, `president_national: 10`. It's a **permission-gating** ladder
  (`hasSufficientRole`, `hasSiteAdminAccess` level ≥ 7), not an org chart.
- `roleDefinitions.level` / `displayOrder` exist in the type
  (`src/lib/role-definitions.ts`) but are **dead fields**: `level` is read from
  Firestore and never consumed anywhere for seniority decisions.
- Slug normalization (`unified-roles.ts`) maps variants (e.g. `president` →
  `president_chapter`) but encodes **no ordering**.
- Roles describe *what someone does*; `reporting_relationships` describes
  *who they report to*. Zubair's standing rule: roles are secondary.

### Option 4 — Chapter-lead mappings. ❌ DO NOT EXIST
No `chapterLead`/`chapter_head`/`leadId` field exists anywhere in `src`.
Chapters have no designated lead in the data model.

## 5. Existing helpers (what exists today)

| Helper | File | Direction | Use |
|---|---|---|---|
| `isManagerAbove(managerId, subordinateId, maxDepth=20)` | `src/lib/server/hierarchy-utils.ts` | ↑ (boolean check) | Task visibility (`api/tasks/route.ts:308` — manager can view subordinate's tasks); mission submit (`api/missions/[workflowId]/submit/[stepIndex]/route.ts:71`) |
| `getDirectSubordinates(managerId)` | same | ↓ one level | `api/tasks/route.ts:732` |
| `getAllSubordinates(managerId, maxDepth=10)` | same | ↓ recursive | (defined; no callers found) |
| `wouldCreateCycle()` | `api/admin/hierarchy/relationships/route.ts` | ↑ (DFS) | POST guard only |

**There is NO `getSuperiors(X)` / `getManagementChain(X)` helper today.**
The upward walk pattern exists (in `isManagerAbove` and `wouldCreateCycle`) but no
function returns the manager chain itself — that's the piece to build.

Downward consumers (all merge both sources): `api/admin/hierarchy/workload`
(BFS + live task counts), `api/profile/my-team`, `api/profile/[userId]`,
`api/tasks/team`.

## 6. Concrete examples

> Live Firestore could not be read from this sandbox (no local service-account key;
> `FIREBASE_SERVICE_ACCOUNT` not in env — see §7 gap). Answers below are structural,
> from code + standing records.

- **Muhammad Huzaifah Shujjah — role `vice_president`.** Per the standing leadership
  rule (MEMORY.md 2026-10-04): the VP stays in charge/oversight of tasks and tracks
  execution while the president (Muhammad Zubair Mongol) stays hands-off.
- **Roles above/below him are NOT determined by role.** A `vice_president` slug
  confers no automatic superiors/subordinates; his actual chain = the
  `reporting_relationships` edges where he is `subordinateId` (walk up) or
  `managerId` (walk down). Any answer naming his superiors requires a live read
  of those edges (Option 1 recipe, §4).
- **Top of the tree: Muhammad Zubair Mongol (the Founder).**
  `FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1'` (`src/lib/roles.ts`).
  `getRoleDisplayName` hardcodes: only this UID displays 'Pakistan President';
  `isPresident`/`isSuperAdmin` return true for him regardless of role string.
  The `president_national`/`superadmin` slugs display as 'Chapter Advisor' for
  anyone else — the Founder role is identity-bound, not assignable.
  A "root" user in the reporting graph = one with **no** `reporting_relationships`
  edges as `subordinateId` and no legacy `managerId` (expected: the Founder).

## 7. Explicit gaps

1. **No machine-readable "get the chain above X" function** — only the boolean
   `isManagerAbove`. Building one = reuse the merged walk-up pattern from
   `wouldCreateCycle`, returning the ordered superior list.
2. **Two divergent write sources** (§1c) — `move`/`add-existing` write only the
   legacy field; `relationships` POST writes only the collection. Readers merge,
   but any single-source query lies. Long-term: consolidate on
   `reporting_relationships`.
3. **Legacy-only cycle checks** in `move`/`add-existing` ignore the collection.
4. **`roleDefinitions.level` is dead** — looks like a seniority field, isn't one.
5. **No chapter-lead mapping** — chapters have members, no lead pointer.
6. **`dotted` vs `direct` semantics unenforced** — stored and rendered, but all
   traversal code treats them identically (e.g. workload BFS counts dotted-line
   reports as full subordinates).
7. **`reporting_relationships` has no Firestore rules entry** — server-only access
   by default-deny; fine for admin tooling, but no client-side chain read is possible.
8. **Concrete chain data unverified here** — naming Huzaifah's actual superiors /
   subordinates needs a live `reporting_relationships` read with Admin-SDK
   credentials (Vercel `FIREBASE_SERVICE_ACCOUNT`), which this sandbox lacks.
