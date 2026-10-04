# Permissions System — Research Findings
_Research agent 3/8 · read-only · repo `~/workspace/seds-pakistan-website` (branch `feat/remediation-harness-complete`) · 2026-10-04_

## 1. `hasServerPermission` — canonical permission check

**Location:** `src/lib/server/permissions.ts`

```ts
export async function hasServerPermission(
  role: UserRole | string | null | undefined,
  permission: PermissionKey
): Promise<boolean>
```

- Takes a **role slug string**, not a uid — role resolution is the caller's job (see §5).
- `superadmin` short-circuits to `true` before any lookup.
- Role lookup order for the *permission grants* (this is the grant side, not the user's role side):
  1. **`roleDefinitions/{roleSlug}`** — if the doc exists and `permissions` is an array, it is **authoritative**: grant returns `true` iff the array contains the key; an explicit boolean field `data[permission]` is also honored; anything else → `false` (no fallthrough, so stale legacy entries can't contradict the configured role).
  2. **`permissions/{roleSlug}`** (legacy) — boolean map; honored only if `roleDefinitions` had no array.
  3. **Static fallback** — `hasPermissionForRole` in `src/config/permissions.config.ts`, where every key is granted to `['superadmin']` only by default (the "role-privileges" drawer writes the real grants into `roleDefinitions`/`role_permissions` via `/api/admin/role-permissions`).

**Companion helpers in the same file:**
- `resolveUserRole(db, uid)` → reads `users/{uid}.role`, falling back to `displayRole`. Returns `null` if unset.
- `isChapterScopedRole(role)` → global roles bypass chapter scoping: `superadmin`, `admin`, `president_national`, `national_vice_president`, `national_marketing`. Everything else is chapter-scoped.
- `assertChapterAccess(db, actorUid, targetUid)` → denies cross-chapter actions for chapter-scoped roles; fail-open (logged) when chapter data is missing on either side.

## 2. `verifyAuthentication` — auth entry point

**Location:** `src/lib/auth-middleware.ts`

```ts
export async function verifyAuthentication(request: NextRequest): Promise<AuthMiddlewareResult>
```

Token extraction: `Authorization: Bearer <token>` header, or `__session` cookie. Verifies with `admin.auth().verifyIdToken(token)`.

**What it returns** (`AuthContext`):
| field | source |
|---|---|
| `userId` | `decodedToken.uid` |
| `email` | `decodedToken.email` |
| `displayName` | `decodedToken.name` |
| `emailVerified` | `decodedToken.email_verified` |
| **`role`** | **`roles/{uid}.role` from Firestore** (the `roles` collection — *not* `users`), defaults to `'member'` |
| `user` | the raw decoded token |

Plus a ban check: `users/{uid}.isBanned === true` → rejected with redirect to `/banned`.

**Related middleware wrappers** (same file): `withAuth` (401 redirect/JSON), `requireAuth` (API wrapper), `requireRole(request, requiredRole, handler)` (403 on `hasSufficientRole` failure), `withOptionalAuth`.

## 3. Role resolution order and the two-store drift caveat

**Two role stores exist:** `roles/{uid}.role` and `users/{uid}.role` (+ `users/{uid}.displayRole`).

| Reader | Reads first | Fallback |
|---|---|---|
| `verifyAuthentication` (auth-middleware) | `roles/{uid}.role` | `'member'` |
| `resolveCallerRole` (ai-task-generator route) | `roles/{uid}` (via pre-built map) | `users/{uid}.role` |
| `checkPositionManagementPermission` (positions route) | custom claims, then `roles/{uid}.role` | — |
| `resolveUserRole` (server/permissions.ts) | **`users/{uid}.role`** | `users/{uid}.displayRole` |
| `sync-user-role` route comment | calls `roles/{uid}.role` the **source of truth**; `users.role` a mirror that "repairs" the sync | — |

**Drift caveat (confirmed by the 2026-10-04 AI auto-assign audit, AGENTS.md):** `revokeRole` and the `onRoleWritten` Cloud Function (firestore webhook) never write `users.role`, so the two stores diverge — particularly after demotions. Any permission check that goes through `resolveUserRole` (i.e., reads `users.role`) honors the **stale** role after a demotion. The standing rule is: role changes must write **both** stores and be verified in both after any demotion. The firestore webhook `handleRoleWritten` (in `src/app/api/webhooks/firestore/route.ts`) *does* mirror `roles → users.role/displayRole` on write, but delete paths and revocation flows can skip it, so treat `users.role` as untrustworthy until verified.

## 4. roleDefinitions & permission grant model

- `roleDefinitions/{roleSlug}` docs: `{ role, slug, name, label, allowedPaths: string[], canAccessAdmin: boolean, permissions: PermissionKey[], updatedAt }` — the `permissions` **array** is what `hasServerPermission` reads.
- Legacy `role_permissions/{roleSlug}` merged as fallback; the role-permissions API writes to **both** collections on every update (dual-write during migration).
- Static baseline: `src/config/permissions.config.ts` (`permissionsConfig`) and the key union in `src/config/permission-registry.ts` — both list only `superadmin` by default; real grants live in Firestore.

**Permission keys relevant to task/mission approval:**
- `canManageTasks` — create/edit/delete/approve tasks (used by task APIs, universal-review)
- `canManageWorkflows` — workflow/mission management
- `canManageRoles` — role assignment/demotion (needed to change who approves)
- `canManagePermissions` — edit roleDefinitions grants
- `canAccessAdmin` — admin panel access gate
- `canManageUsers`, `canViewAuditLogs`, `canManageProjects`, `canViewHierarchy` — supporting oversight keys

There is **no `canApproveTasks` key** — approval is governed by `canManageTasks` (plus workflow-step assignee checks and the VP-in-loop convention).

## 5. Canonical server auth-gate pattern (copy this)

The standard pattern across routes — three representative examples quoted below:

### Pattern (used in `/api/admin/sync-user-role`, `/api/admin/role-permissions`, `/api/admin/universal-review`)

```ts
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageTasks'))) {
    return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
  }
  // …handler logic with getDb()
}
```

Notes: `auth.user.role` comes from `verifyAuthentication` → `roles/{uid}.role` (roles-first, drift-safer). The 401/403 split is consistent: 401 unauthenticated, 403 lacks permission. `ensureAdminInitialized()` + `getDb()` from `@/lib/server/firebase-admin` guards DB availability (500s otherwise).

### Example 2 — AI task generator (fail-closed role resolution)

```ts
// Resolve the caller's role the same way the registry does: roles collection
// first, users/{uid}.role as fallback.
const callerRole = await resolveCallerRole(auth.uid, registry.rolesByUid);
if (!(await hasServerPermission(callerRole, 'canManageTasks'))) {
  return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
}
```

`resolveCallerRole` returns `''` when the role can't be resolved, so the permission gate denies safely (fail-closed).

### Example 3 — tasks route (claims → role fallback layering)

```ts
if (!canManage) {
  const roleSnap = await db.collection('roles').doc(claims.uid).get();
  const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
  canManage = await hasServerPermission(role, 'canManageTasks');
}
```

Layers: identity-level check first (assignment/ownership claims), then the granular role-permission check as fallback.

## 6. Custom claims

Yes — Firebase Auth custom claims carry identity-level data, but **not** granular permissions:

| Claim | Value | Set by |
|---|---|---|
| `role` | role slug string | `handleRoleWritten` in `src/app/api/webhooks/firestore/route.ts` (fires on `roles/{uid}` write) |
| `chapter_id` | chapter id string | same handler; also updated on `users/{uid}.chapterId` change |

No `permissions` array lives in claims; `positions/route.ts` defensively checks for `claims.permissions.managePositions` etc., but nothing in the current codebase *sets* those claim keys — they're dead checks against a legacy convention. Claims are read via `admin.auth().getUser(uid).customClaims` (server) or the decoded token.

**Refresh (`authority_refresh`):** `src/lib/authority-refresh.ts` — "Instant Power Refresh":
1. On a role change, the changed user gets a signal: if it's the current client session, `user.getIdToken(true)` directly; otherwise a doc is written to `authority_refresh/{targetUid}` (`requestedAt`, `type: 'FORCE_REFRESH'`).
2. The target user's client listener (`setupAuthorityListener`, on `onAuthStateChanged`) watches that doc and force-refreshes their ID token when the request is <30s old, then marks it processed.
3. Best-effort everywhere — refresh failures never throw into the role-write flow.

The actual claims-sync work happens server-side in the firestore webhook's `handleRoleWritten` (`auth.setCustomUserClaims(userId, { role, chapter_id })`); the `authority_refresh` docs just tell the client to fetch a fresh token.

## Summary for hierarchical approval

- **Gate to copy:** `verifyAuthentication(request)` → 401 if unauthenticated → `hasServerPermission(callerRole, 'canManageTasks')` → 403 if denied. `auth.user.role` (from `roles/{uid}`) is the role source.
- **Resolve roles roles-first:** prefer `roles/{uid}.role` over `users/{uid}.role` (which can be stale post-demotion); `resolveCallerRole` in ai-task-generator is the fail-closed exemplar (returns `''` → deny).
- **Approval keys:** `canManageTasks` (primary), `canManageWorkflows` (missions), `canManageRoles` (who approves whom). No separate approval key exists.
- **Chapter scoping:** use `isChapterScopedRole` + `assertChapterAccess` — only `superadmin/admin/president_national/national_vice_president/national_marketing` are global; everyone else may only act within their chapter.
- **Custom claims** carry `role` + `chapter_id` only — do not gate granular permissions on claims; the `claims.permissions.*` reads in positions/route are legacy dead checks.
