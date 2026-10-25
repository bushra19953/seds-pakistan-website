# G3 Admin Users Directory UI — Inventory (COMPLETE)

Branch: feat/supa-users-3
Base: 4d5a1e16
Method: full read of every in-scope file + every sibling the directory
table actually mounts, with file:line evidence. Zero live reads.

Files in scope (per brief):
- src/app/admin/users/page.tsx
- src/components/admin/users/user-table.tsx
- src/components/admin/users/user-table-columns.tsx

Siblings extended into the inventory (same file group, mounted by the
table, touching directory-adjacent data):
- src/components/admin/users/virtualized-user-table.tsx (the rendered table)
- src/components/admin/users/award-badge-dialog.tsx (row action dialog)
- src/components/admin/users/issue-warning-dialog.tsx (row action dialog)
- src/components/privacy/masked-contact.tsx (email/whatsapp cells)

---

## 1. The directory rows themselves: API-ONLY (verified, not assumed)

`fetchPage` in user-table.tsx is the ONLY source of directory rows:

- user-table.tsx:191 `fetch(\`/api/admin/users?${params}\`)` with the
  caller's ID token; params are `q`, `role`, `chapterId`, `pageSize`
  (20 idle / 200 search, user-table.tsx:185-189).
- user-table.tsx:211 consumes ONLY `json.users`. Each row is mapped to
  `{...r, chapterName}` where chapterName is resolved client-side from
  the chapters list (see R2) or falls back to the raw chapterId.

Response fields the UI NEVER reads (grep over all three in-scope files
+ virtualized-user-table.tsx, zero hits): `searchMethod`, `nextCursor`,
`pageSize`, `responseTime`, `cached`, `debug.totalScored`.

Consequence for the flag flip (DECISIONS.md: flag ON returns
`searchMethod: "supabase"`, flag OFF `"native_firestore"`): the UI
cannot render differently between modes, because nothing branches on,
or even reads, the field. Parity is pinned by test, not by inspection:
`src/components/admin/users/__tests__/user-table-supa-parity.test.tsx`
feeds both response shapes through the real component (API layer
mocked) and asserts byte-identical rendered output.

Pagination/totals assumptions tied to the old API window behaviour
(noted per brief; NOT changed — API semantics are G1's):
- user-table.tsx:479 renders `{rows.length} Active Profiles Processed`
  and virtualized-user-table.tsx:292 `Showing {rows.length} records`:
  the returned page length is presented as the total. The API clamps
  pageSize to 50 (route.ts) and, on the search path, slices from a
  bounded candidate window; `debug.totalScored` — the only true total —
  is ignored. If G1's corrected exact-holder role resolution changes
  how many rows a role filter returns, this label stays exactly as
  (in)accurate as today in BOTH modes. Pre-existing, flag-independent.
- Cursor pagination is vestigial in the UI: fetchPage always calls
  `setPageCursor(null)` (user-table.tsx:230) and never sends
  `startAfter`, so `handleNext` can never fire. Flag-independent.

Dead row fields (pre-existing, flag-independent): the API returns
neither `customTitle`, `isOnVacation`, nor `memberStatus`, yet
UserRow (user-table-columns.tsx:56-84) and the cells render all three.
They are always undefined via the API in both modes. Not a migration
divergence; not fixed here (would change API semantics — G1's call).

## 2. Every direct client Firestore read in the file group

### R1 — roleDefinitions (custom role definitions) — STAYS, roles-cluster owned
- user-table.tsx:313 `getUnifiedRoleOptionsForChapter(firestore, uid, chapterId)`
  per chapter, filtered to `custom_` keys -> custom options for the
  Change Role menu / inspector.
- user-table-columns.tsx:146 `getCustomRoleDefinitions(firestore, {chapterId})`
  per actions cell (inspector default-term prefill).
- Both funnel to src/lib/role-definitions.ts:53
  `getDocs(collection(firestore, 'roleDefinitions'))` inside
  `getAllRoleDefinitionsCached` (5-min module cache, shared).
- The base role filter options do NOT come from this read:
  user-table.tsx:278 calls `getUnifiedRoleOptions(firestore)` with no
  chapterId, which is catalog-only in-memory (src/lib/unified-roles.ts:
  40-46; the roleDefinitions read at :48-49 runs only with a chapterId).
  So the directory's role FILTER dropdown slugs = static ROLE_CATALOG.
- Ruling: NOT migrated by G3. `src/lib/role-definitions.ts` is owned by
  the roles cluster (CLUSTER_MAP merge plan C-13; roles parity matrix
  R12 pins this exact list read). Editing it here would collide with
  the roles branches. The read is client-side Firestore in both flag
  modes today and stays so until the roles cluster moves it; the
  directory renders identically either way because it consumes only
  the {key,label,defaultTermDays} projection.

### R2 — chapters list — STAYS, chapters-cluster owned
- user-table.tsx:291 `getDocs(collection(firestore, "chapters"))`,
  mapped to `{id, name: data.name || id}`. Feeds (a) the chapter filter
  dropdown and (b) the chapterName enrichment of every row (§1).
- Ruling: NOT migrated by G3. `chapters` belongs to merge-plan residual
  O (Chapters + hierarchy). The only existing server route,
  GET /api/v1/chapters, is still Admin-SDK Firestore (not seam-consumed)
  and is NOT a drop-in: it sorts by name (client read is doc-id order)
  and its name fallback is `name || slug || id` vs the client's
  `name || id` — switching would change option order and labels, i.e.
  NOT byte-identical rendering. Flagged for the chapters owner; the
  directory's chapters read flips with that cluster's seam, and the UI
  needs no change when it does (it consumes {id,name} only).

### R3 — leave_audit realtime listener — STAYS (listeners sweep A14)
- user-table.tsx:337-339 `onSnapshot(query(collection(firestore,
  'leave_audit'), orderBy('timestamp','desc'), limit(1)))`. First
  snapshot ignored; any later snapshot only triggers `fetchPage()`
  refetch of the API page. It feeds NO rendered value directly.
- Ruling: STAYS as a listener on this branch. Listeners sweep A14
  grades it (c) "already a trigger hack, not a data feed; the honest
  port is bounded polling" — that port is a listeners-cluster decision
  and must not happen silently inside G3. Until that cluster rules and
  implements it, removing or polling-ifying it here would change the
  directory's auto-refresh behaviour in both modes. Presence pinned by
  the parity test (asserts onSnapshot is still subscribed).

### R4 — badges list (sibling dialog) — STAYS, out of G3 scope
- award-badge-dialog.tsx:62-63 `getDocs(query(collection(firestore,
  "badges"), orderBy("name")))`. Not directory data; the dialog is a
  row action owned by the badges/gamification surfaces. Inventoried
  because it is mounted from user-table-columns.tsx; no G3 action.

## 3. Writes in the file group (inventoried; none are G3 reads)

- assignRole (user-table.tsx:379) / revokeRole
  (user-table-columns.tsx:294) via src/lib/role-management.ts — roles
  cluster owns that module (CLUSTER_MAP); it already routes its
  canonical write through an authed API fetch (role-management.ts:32-52)
  with client doc reads at :142/:159/:387-404. Not touched.
- POST /api/admin/sync-user-role (user-table.tsx:401) — API, roles-owned.
- POST /api/admin/users/restore-workload (user-table.tsx:444) — API;
  DECISIONS.md assigns this route to the merge planner's residual
  inventory; stays Firestore in both modes. UI consumes only
  `restoredCount` for a toast.
- POST /api/admin/users/[uid]/depart|reinstate
  (user-table-columns.tsx:42) — API only.
- award-badge-dialog.tsx:106 `updateDoc(users/{uid})` badge write —
  badges surface, not directory data.
- masked-contact.tsx: unmask writes an audit entry via logAuditEntry
  (audit_logs collection) — a write side-effect of a read cell;
  privacy/audit surface, not directory data. Its displayed value comes
  from the row prop; it performs NO data read.

## 4. No-data-read components

- src/app/admin/users/page.tsx: zero data reads. Tab shell only
  (directory tab = UserTable; roles tab = RoleRegistry, roles cluster).
- virtualized-user-table.tsx: zero reads; pure rendering of props.
- issue-warning-dialog.tsx: zero reads/writes; deep link only.
- role-power-matrix.tsx (mounted by user-table.tsx): zero reads;
  static permissions config.
- useUser/useAuthorization context (session role, roles/{uid} listener
  in src/firebase/user-provider.tsx:262): identity/session plumbing,
  owned per merge plan C-11; not directory data, not G3.

## 5. Verdict

The directory's data plane is the G1 API; the UI-side migration is a
proof + parity pin, plus three flagged stays (R1 roles-owned, R2
chapters-owned, R3 listeners-owned) — each with its owner named so the
merge planner can sequence them. No UI code change is required for
flag-ON responses to render identically, and none was made to data
paths. The only code added is the parity test suite.
