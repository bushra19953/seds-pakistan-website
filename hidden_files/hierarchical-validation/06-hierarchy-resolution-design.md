# Hierarchy Resolution Design — Validator Chain

**Design agent 6/8 · Read-only design · 2026-10-04**
**Status:** At design time `02-hierarchy-model.md` did not exist yet and `03-permissions.md`
appeared mid-session (sibling research agent 3/8). This design was built directly from the
codebase and cross-checked against `03-permissions.md` after it landed — the two agree:

- Data model: `src/app/api/admin/hierarchy/relationships/route.ts`
  (`reporting_relationships` collection + legacy `users/{uid}.managerId` fallback)
- Existing read-time walks: `src/lib/server/hierarchy-utils.ts`
  (`isManagerAbove`, `getDirectSubordinates`, `getAllSubordinates`)
- Role model: `src/lib/roles.ts`, `src/lib/unified-roles.ts`, `src/lib/role-definitions.ts`
- Permission model: `src/lib/server/permissions.ts` + research note
  `03-permissions.md` (cross-checked 2026-10-04 — see "Consistency with 03-permissions" below)

**Consistency with 03-permissions.md.** The sibling note confirms: there is no
`canApproveTasks` key — approval is governed by `canManageTasks`; the canonical gate is
`verifyAuthentication(request)` → 401 if unauthenticated → `hasServerPermission(callerRole,
'canManageTasks')` → 403 if denied, with `auth.user.role` read from `roles/{uid}`
(roles-first, drift-safer than `users.role`); `resolveCallerRole` (ai-task-generator) is
the fail-closed exemplar for role resolution; chapter scoping uses
`isChapterScopedRole` + `assertChapterAccess`, with only
`superadmin/admin/president_national/national_vice_president/national_marketing` being
global roles. §7's caller sketch and edge cases #10/#16 are written to that contract.

**Critical clarification (Zubair, 2026-10-04):** "hierarchy" = the hierarchy managed at
`/admin/hierarchy`, i.e. the explicit `reporting_relationships` graph. This design does
**not** build a seniority model from roles alone. A person's validator chain is the
upward walk of their reporting chain, nothing else.

---

## 1. Authoritative data model (as implemented)

| Store | Key | Fields | Role in resolution |
|---|---|---|---|
| `reporting_relationships` (Firestore) | auto-id | `subordinateId: string`, `managerId: string`, `type: 'direct' \| 'dotted'`, `createdAt`, `createdBy` | **Primary.** Zero, one, or many managers per subordinate. Multiple managers are legal (direct + dotted). |
| `users/{uid}.managerId` (legacy) | uid | `managerId: string \| null` | **Fallback, per link.** Used when `reporting_relationships` has no docs for a subordinate. The DELETE endpoint clears it when a relationship is deleted, so legacy and collection state can coexist during migration. |

Existing invariants to respect:
- **Write-time cycle prevention** (`wouldCreateCycle` in `relationships/route.ts`): refuses any
  relationship whose addition would create a cycle, via DFS from the candidate `managerId`
  upward (including the legacy field). Returns the cycle path for the 409 response.
- Self-reporting is rejected at write time (`subordinateId === managerId` → 400).
- `hierarchy-utils.ts` walks cap at depth 20 (`isManagerAbove`), depth 10 downward
  (`getAllSubordinates`), and always check the legacy field alongside the collection.
  They swallow per-link errors and keep walking — resolution should adopt the same
  "one bad read never kills the chain" posture, but must surface failures explicitly
  (see §5).

---

## 2. Design principle

> **A validator chain is the ordered upward closure of the reporting graph.**
> Given a submitter uid, repeatedly look up "who does X report to" — collection docs
> first, legacy `managerId` as per-link fallback — until there is no manager. Order is
> **nearest-first**: direct lead → their lead → … → top of chain.
>
> Roles are informational only. If the walk needs a tie-break between two managers at
> the same level, the tie-break is relationship `type` (`direct` before `dotted`), never
> role seniority.

---

## 3. Module contract

### 3.1 Proposed location

`src/lib/server/hierarchy.ts` — a new **server-only** module. Sibling of the existing
`src/lib/server/hierarchy-utils.ts`. It must live under `src/lib/server/` because it
uses the Admin SDK (`getDb()` from `@/lib/server/firebase-admin`); nothing under
`src/lib/server/` is ever imported from client components (repo convention, verified
2026-10-04).

Two companion changes (recommended, not required for v1):
1. **Move** `wouldCreateCycle` out of `relationships/route.ts` into the new module and
   re-export it from the route (or have the route import it). Read-time resolution and
   write-time prevention must share **one** cycle-detection implementation; a second
   copy will drift.
2. Leave `hierarchy-utils.ts` untouched — its boolean/flat-array helpers serve different
   call sites. The new module returns an ordered chain.

### 3.2 Signature

```ts
// src/lib/server/hierarchy.ts

export type RelationshipType = 'direct' | 'dotted' | 'legacy';

export interface ValidatorLink {
  /** The manager's uid. */
  uid: string;
  /** Distance from the submitter: 1 = direct lead, 2 = lead's lead, ... */
  depth: number;
  /** How this link was established. */
  relationshipType: RelationshipType;
  /** False when the uid has no users/{uid} doc (dangling reference). */
  userExists: boolean;
}

export interface GetValidatorChainOptions {
  /** Max upward hops. Default 20 (mirrors isManagerAbove). */
  maxDepth?: number;
  /** Include dotted-line managers in the chain. Default true. */
  includeDotted?: boolean;
}

export interface ValidatorChainResult {
  chain: ValidatorLink[];        // nearest-first
  /** The cycle path if read-time cycle detection fired (legacy/corrupt data). */
  cycleDetected?: string[];
  /** True if any Firestore read failed mid-walk and was skipped. */
  partial?: boolean;
}

/**
 * Return the ordered validator chain for a submitter by walking the
 * /admin/hierarchy reporting graph upward: nearest (direct lead) first,
 * top-of-chain last.
 */
export async function getValidatorChain(
  submitterUid: string,
  options?: GetValidatorChainOptions
): Promise<ValidatorChainResult>;

/** Thin wrapper for call sites that only need uids. */
export async function getValidatorChainUids(
  submitterUid: string,
  options?: GetValidatorChainOptions
): Promise<string[]>;
```

### 3.3 Inputs

| Input | Type | Required | Notes |
|---|---|---|---|
| `submitterUid` | `string` | yes | Non-empty, trimmed. Must be a uid the caller resolved (never a display name or email). |
| `options.maxDepth` | `number` | no | Default `20`. Guards against legacy-data cycles and pathological depth. Values < 1 throw `RangeError`. |
| `options.includeDotted` | `boolean` | no | Default `true`. When false, dotted-line managers are skipped during the walk (their subtrees still walkable above them only via direct links — see §4.4). |

### 3.4 Outputs

- `ValidatorChainResult.chain`: ordered `ValidatorLink[]`, nearest-first (`depth: 1` first).
  For the common org shape (one direct manager per person) this is a simple list;
  where a person has both a direct and a dotted manager, the direct manager sorts first
  at the same depth (see §4.4).
- `cycleDetected`: set only when a repeat visit is found despite the write-time guard
  (legacy/corrupt data). The walk stops and returns the partial chain.
- `partial`: true if any per-link read threw; the link is skipped and the walk continues
  (mirrors `hierarchy-utils.ts` resilience) — the caller sees this flag and can decide
  whether a partial chain is acceptable for validation authorization.

### 3.5 Errors (thrown, not swallowed)

| Condition | Error |
|---|---|
| `submitterUid` empty / not a string | `TypeError('submitterUid must be a non-empty string')` |
| `maxDepth < 1` | `RangeError('maxDepth must be >= 1')` |
| Admin SDK not initialized / `getDb()` returns null | `Error('Firestore unavailable')` — unlike `hierarchy-utils.ts`, the chain builder must not silently return `[]`, because an empty chain means "nobody above you" and a caller may treat it as authorization state. |

### 3.6 What this function does NOT decide

- **Who is *allowed* to validate** is a policy call on top of the chain (e.g. "first
  link only", "any link within depth 2", "any link"). The chain is the *candidate set*,
  ordered by proximity.
- **Chapter scoping** (can a VP of another chapter validate?) is caller policy. The
  `reporting_relationships` collection has no chapter field — cross-chapter links are
  possible and appear in the chain exactly as configured. If callers want same-chapter
  restriction, they filter `ValidatorLink`s by the manager's `chapterId` after the fact.
- **Submitter-not-found**: the chain depends only on relationship docs keyed by
  subordinateId, so a missing submitter user doc does not abort the walk; the first
  link carries `userExists: false` semantics naturally if needed. (Caller may pre-check
  the user exists before invoking.)

---

## 4. Algorithm

### 4.1 Pseudocode

```
async getValidatorChain(submitterUid, { maxDepth = 20, includeDotted = true }):
  validate inputs (TypeError / RangeError)
  db = getDb(); if (!db) throw Error('Firestore unavailable')

  chain: ValidatorLink[] = []
  visited = Set([submitterUid])          # read-time cycle guard
  queue = [submitterUid]                 # BFS frontier, one level at a time
  depth = 0
  cycleDetected = undefined
  partial = false

  while queue not empty and depth < maxDepth:
    depth += 1
    next = []
    for currentId in queue:
      if visited.has(currentId) and currentId != submitterUid??  # see 4.2
        continue
      visited.add(currentId)

      managers = []
      try:
        rels = db.reporting_relationships.where('subordinateId','==',currentId).get()
        for doc in rels:
          m = doc.data()
          if m.managerId and m.type in ('direct','dotted'):
            if m.type == 'dotted' and !includeDotted: continue
            managers.push({ uid: m.managerId, type: m.type })
      catch e:
        log(e); partial = true; continue   # one bad read never kills the chain

      if managers is empty:                # LEGACY FALLBACK (per link)
        try:
          userDoc = db.users.doc(currentId).get()
          lm = userDoc?.data()?.managerId
          if lm and typeof lm == 'string' and lm.trim():
            managers.push({ uid: lm.trim(), type: 'legacy' })
        catch e:
          log(e); partial = true; continue

      # PRECEDENCE at one level: direct, then dotted, then legacy; dedupe
      order = sortBy(managers, precedence[direct=0, dotted=1, legacy=2], then uid)
      for { uid, type } in order:
        if uid in visited or uid in queue or uid in next:
          if uid would be re-added from submitterUid path → cycleDetected = [uid, ...]
          continue                         # cycle / diamond guard, skip re-add
        exists = (await safeGet(db.users.doc(uid))).exists
        chain.push({ uid, depth, relationshipType: type, userExists: exists })
        next.push(uid)
    queue = next

  return { chain, cycleDetected, partial: partial || undefined }
```

**Why BFS, not a single-parent pointer chase:** a subordinate can have multiple
managers (direct + dotted). BFS level-order guarantees *nearest-first ordering across
the whole frontier* — every depth-1 manager precedes every depth-2 manager, which a
naive per-parent recursive walk does not guarantee when parents have different
subtree depths.

### 4.2 The read-time cycle guard (mirror, don't reinvent)

Write-time `wouldCreateCycle` prevents new cycles, but legacy `managerId` fields and
data predating the guard can still cycle. The guard above is deliberately a mirror of
the existing conventions:

- `visited` set: a uid is never enqueued twice → the walk always terminates even if
  the underlying data cycles.
- `maxDepth` (default 20): matches `isManagerAbove`'s cap.
- If a re-visit is attempted, the uid is skipped and, for auditability,
  `cycleDetected` records the repeated uid (not a full path — full-path reconstruction
  is the write-time function's job; here it signals "data needs repair").

Refactor note (§3.1): hoist `wouldCreateCycle` into the new module and keep this
read-time guard as the lightweight `visited`-set check. The heavy DFS stays the
write path's responsibility.

### 4.3 The missing-link rule

At each hop, the lookup order is strict:

1. **Collection docs** — `reporting_relationships.where('subordinateId','==',currentId)`.
   If ≥1 doc exists, they define the managers for this hop. The legacy field is
   **not consulted** for this hop (avoids double-counting when both were set).
2. **Legacy fallback** — only when the collection returned zero managers:
   `users/{currentId}.managerId`. Guarded with `typeof === 'string'` (the 2026-10-04
   `/admin/roles` crash taught us Firestore docs can be malformed).
3. **No manager** — the walk ends for this branch. A person with no manager is the
   top of their chain; the chain simply stops there.

### 4.4 Multiple managers at one level (direct vs dotted)

A person may have both a direct and a dotted manager. Ordering rule at each hop:

- `direct` (0) → `dotted` (1) → `legacy` (2); ties broken by uid for determinism.
- Dedup: if the legacy field names the same uid as a collection doc, it contributes
  one link (collection type wins).
- When `includeDotted: false`, dotted docs are skipped at that hop — but the walk
  continues upward from the remaining managers. Note: skipping a dotted manager also
  prunes that manager's ancestors from the chain (they were only reachable through
  the dotted link).

### 4.5 How deep the walk goes

- `maxDepth` caps hops at 20 by default — real orgs are 3–6 deep; 20 is a safety
  rail inherited from `isManagerAbove`, not an expectation.
- The walk stops earlier when: every frontier node has no manager (top reached),
  the queue empties, or a cycle guard fires.

---

## 5. Edge-case table

| # | Case | Behavior |
|---|---|---|
| 1 | Submitter is at top (no manager anywhere) | Chain `[]`. The caller owns policy: e.g. founder-level tasks require co-sign, or are unvalidatable. The function does not invent a validator. |
| 2 | Submitter has no collection doc but legacy `managerId` set | Legacy uid enters the chain as `relationshipType: 'legacy'`; walk continues upward from it via collection docs first. |
| 3 | Legacy field AND collection docs both set for one hop | Collection wins; legacy ignored for that hop; no duplicate link. |
| 4 | Manager uid has no `users/{uid}` doc (dangling reference) | Link is kept with `userExists: false`; walk continues upward via relationship docs keyed on that uid (user doc is not required for traversal). Legacy fallback for *that* hop is unavailable (no doc), so the branch stops if no collection docs exist. |
| 5 | Circular references (A→B→A, or longer) | `visited` set skips the re-add; walk terminates; `cycleDetected: [<repeated uid>]` returned with the partial chain. Data repair is out of scope — the write-time guard prevents new cycles. |
| 6 | Self-report (`subordinateId === managerId`) | Rejected at write time (400); if found in legacy data, treated as case 5 (immediate cycle). |
| 7 | Submitter has multiple managers (direct + dotted) | Both enter at `depth: 1`, direct first. BFS continues from both. |
| 8 | Dotted manager's own chain | Walked like any other link (unless `includeDotted: false`, which prunes that branch). |
| 9 | User with multiple roles | Irrelevant. The chain is per-uid from the reporting graph; roles are never consulted for ordering. |
| 10 | Manager in another chapter (e.g. another chapter's VP) | Appears in the chain if configured. Chapter scoping is caller policy, not chain-builder policy (the collection has no chapter field; the /admin/hierarchy GET filters by chapter only via user docs). Caller recipe per `03-permissions.md`: check `isChapterScopedRole(managerRole)` — global roles (`superadmin`, `admin`, `president_national`, `national_vice_president`, `national_marketing`) may validate cross-chapter; for chapter-scoped roles, gate with `assertChapterAccess(db, managerUid, submitterUid)`. |
| 11 | Assigner is BELOW the submitter | Assignment and reporting are independent. The chain ignores `task.assigneeIds`/`createdBy` and returns the true upward path. If the assigner is below the submitter, they simply don't appear in the submitter's chain. |
| 12 | Founder (`FOUNDER_UID`) as submitter | No special case. If the founder has no managers, chain is `[]`. Founder does not auto-appear in anyone's chain unless configured as a manager. |
| 13 | Firestore read fails mid-walk | Link skipped, `partial: true` set, walk continues (mirrors `hierarchy-utils.ts` resilience). Contrast with total DB failure → thrown error (§3.5). |
| 14 | Malformed doc (non-string `managerId`, missing fields) | `typeof` guards coerce/skip; junk never enters the chain (same junk-data guard pattern as `getRoleDisplayName`). |
| 15 | Empty chain vs DB outage ambiguity | Resolved by §3.5: DB outage throws; `[]` unambiguously means "no one above". |
| 16 | Two role stores drift (`roles/{uid}.role` vs `users/{uid}.role`) | Out of scope for chain resolution (roles unused), but noted: any future validation policy that checks *role-based* permissions must resolve roles **roles-first** (`resolveCallerRole` pattern from ai-task-generator, fail-closed → `''` → deny) and never trust `users.role` alone after demotions (confirmed 2026-10-04 AI auto-assign audit; see `03-permissions.md` §3). |

---

## 6. Caching

**Recommendation: compute per request; do not cache by default.**

- **Cost of recompute is small.** Real chains are 3–6 hops; each hop is 1 indexed
  equality query (`subordinateId ==`) plus at most 1 user-doc fetch for the legacy
  fallback — roughly 4–12 reads per resolution. At task-validation frequency this is
  negligible against Firestore quotas.
- **Cost of staleness is high.** Hierarchy edits (moves, demotions, the ongoing
  leadership changes) must take effect immediately; a cached chain could authorize
  the *wrong* validator after a demotion. The 2026-10-04 role-store drift incident
  is exactly the failure mode caching would amplify.
- **If latency ever demands it:** add an in-memory cache keyed by
  `${submitterUid}:${includeDotted}` with a **short TTL (≤ 60 s)** *and* explicit
  invalidation in the relationships POST/DELETE handlers and in the legacy-`managerId`
  write path. Both conditions — short TTL **and** write-path invalidation — are
  required; TTL alone is not acceptable given the authorization stakes.

---

## 7. How callers use the chain (non-normative sketch)

```ts
// Example: a task-validation endpoint resolves candidates, then applies policy.
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { getValidatorChain, getValidatorChainUids } from '@/lib/server/hierarchy';

// The chain answers "who is above the submitter". The permission gate stays the
// canonical one from 03-permissions.md — never replaced by the chain:
const auth = await verifyAuthentication(request);
if (!auth.authenticated || !auth.user)
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

const { chain, cycleDetected, partial } = await getValidatorChain(submitterUid);
if (cycleDetected) logAuditEntry('hierarchy_cycle_on_read', { submitterUid, cycleDetected });
if (partial) /* decide: fail closed (reject) or proceed with warning */;

// Policy examples layered on top of the chain:
//  - direct lead only:            chain.filter(l => l.depth === 1 && l.relationshipType === 'direct')
//  - any validator above:          chain
//  - same-chapter only:            isChapterScopedRole(role) ? assertChapterAccess(db, mgr, submitter) : allow
//  - permission-gated:             hasServerPermission(callerRole /* roles-first */, 'canManageTasks')
```

Authorization decisions must use the Admin-SDK-resolved chain server-side; never
trust a client-supplied manager list (the AI-auto-assign audit lesson: server builds
its own registry). The chain is the *candidate set* (ordered by proximity); `canManageTasks`
remains the permission gate, resolved roles-first per `03-permissions.md`.

---

## 8. Open questions for Zubair

1. **Dotted-line default:** included in the validator candidate set by default
   (`includeDotted: true`). Should a dotted-line manager be allowed to validate, or
   only direct leads? 
...[truncated 1337 chars]