# Identity (users + roles) — write-primacy inversion DESIGN

**Workstream:** IDENTITY, Supabase CUTOVER program (Option A: full data
cutover, Firestore out of the data path, Firebase Auth untouched).
**Step:** DESIGN ONLY. No production code in this step; the W4 build wave
consumes this document. No suites authored here — §5 is the pin list the
build wave's test author implements.
**Base:** `feat/supa-cutover` @ `b1c5d5bd`; design worktree
`~/workspace/fix-ab/wt-supa-cut-identity` on `feat/supa-cut-identity-design`.
**Census:** [identity-writepoints.md](identity-writepoints.md) (sibling;
every file:line below is from that census / the base tree).
**Inputs read first:** DEPLOY_READY_REPORT.md (users + roles entries:
both CLEARED TO FLIP as dual-write surfaces; roles flip condition =
chokepoint mirror port, satisfied 68329883; users = 31-pin directory
contracts), MERGE_PROGRAM_REPORT.md step 3 + R3/R11 (roles G2/G4 landed,
users G1+G2 landed, R19 shim, mirror port, R11 pin re-verified),
cluster-users reports (BUILDOUT, DECISIONS: one surface name `users`;
`searchMethod:'supabase'` only from a genuinely served path),
cluster-roles reports (BUILDOUT G2/G4, MIRROR_PORT_REPORT,
ROLES_RESOLUTION_PARITY_MATRIX R1–R21, RULING_ROLE_DEFINITIONS),
IDENTITY_DEPENDENCY_MAP.md (the bundle, the pin, failure semantics),
`src/app/api/admin/users/route.ts`, the roles seams
(`src/lib/server/supa-roles-seam.ts`, `supa-roles-route.ts`,
`supa-roles-reconcile-seam.ts`, `src/lib/supa-roles-client-seam.ts`),
`mirrorRoleWriteToSupa` in `src/lib/server/role-writes.ts`,
the identity-bundle/auth loading path (`src/lib/server/permissions.ts`,
`identity-cache.ts`, `auth-middleware.ts`), `src/lib/supa/flags.ts`.

**Read budget:** zero live Firestore reads, zero live Supabase writes
for this design (all local code reading). Canary not required: no read
stack was started.

---

## 0. Flag law as it applies to this workstream

- Foundation (W1, parallel) is building `isSupaPrimary(surface: string):
  boolean` in `src/lib/supa/flags.ts`: **true iff the token is in BOTH
  `SUPA_SURFACES` and `SUPA_PRIMARY`**. This design assumes that exact
  name/signature. On the base tree `flags.ts` contains only
  `parseSupaSurfaces` + `useSupa` — `isSupaPrimary` does NOT exist yet;
  the build wave must not start until the foundation merge lands it.
- Identity tokens: **`users`** and **`roles`** — the existing
  `SUPA_SURFACES` tokens. There is no `directory`/`picker` token
  (DECISIONS.md ruling) and no per-collection tokens. Subcollection
  notifications keep riding the **`notifications`** token for their
  existing mirror/read seam (§2.5) — identity primacy does not absorb it.
- `isSupaPrimary('users')` governs every write point in census §A + §D
  (users top-level). `isSupaPrimary('roles')` governs census §C. The two
  tokens are independent: either may flip first (§4 sequencing), and
  the both-flags rule is pinned (§5, IC-02): a token present in only one
  of the two env lists changes NOTHING — `SUPA_PRIMARY` alone (without
  `SUPA_SURFACES`) must not engage reads or writes, and `SUPA_SURFACES`
  alone is today's dual-write.
- **Default OFF = byte-identical dual-write.** With `SUPA_PRIMARY`
  unset/empty, every site below executes exactly today's code path:
  Firestore write first, existing mirrors as they exist today, adapter
  never called for a primary write. This is contract-pinned per group
  (§5, IC-01).

---

## 1. What "inversion" means here, mechanically

Today (dual-write): Firestore is the writer of record; a subset of
sites mirror to Supa best-effort after commit (census Mirror column).
The identity READS already flipped live (users directory, roles
resolution core) serve from Supa under `SUPA_SURFACES` — which means
**every unmirrored write in the census is already a live staleness bug
on a flipped read surface today** (U-03, U-04, U-28..U-35, R-06..R-12,
all of §D). Inversion is therefore not only a cutover step; its
reverse-mirror decisions below also close today's staleness, in the
OFF→ON order the parent chooses.

Under primacy (`isSupaPrimary(surface) === true`) each site becomes:

1. **Supa primary write first**, through the surface's existing seam
   machinery extended with primary-write helpers (§2.1), using the
   adapter's `setDoc/updateDoc/deleteDoc` over the same collection
   paths the mirrors use today. The write is **authoritative**: its
   failure fails the operation (unlike today's mirrors, which swallow).
2. **Then exactly one of:**
   - **(a) Reverse mirror to Firestore** — best-effort, post-commit,
     non-throwing (a failure logs and never un-commits the primary),
     carrying the post-write primary state; **or**
   - **(b) No reverse mirror** — with the per-group reason stated in §3.
     Every (b) is a decision that the named Firestore readers are either
     already gone, are being flipped in the same wave, or are Auth-plane
     / client-listener surfaces that the decommission wave (W5) removes.
3. **Cache/claims side effects unchanged in position:** identity-cache
   busts (`bustIdentity`, `bustPermissionDoc`) and `stampRoleClaims`
   fire after the primary commit, exactly where they fire after the
   Firestore commit today. Busts are in-process and backend-agnostic;
   claims are Auth-plane and read their inputs from the write result.

**Shape rule (applies to every primary write):** the payload that lands
in `fs_*` data jsonb must be the JSON-plain shape the adapter + dump
established — Dates/Timestamps/serverTimestamp sentinels become ISO
strings, `FieldValue.increment/arrayUnion/arrayRemove/delete` have **no
jsonb equivalent** and must be resolved before the write (§3 class
INC/RMW). The R19 precedent (§4, H-03) governs all translations: they
live in the seam, never at call sites.

**Atomicity rule:** no site gains or loses atomicity silently.
Firestore `batch`/`tx` groups that span identity + another cluster's
collection cannot be made atomic across two stores; §3 marks each such
group **split-commit** and states the commit order (identity primary
first, then the foreign write, then reverse mirrors) and the failure
semantics. Single-collection identity batches (R-01..R-04,
R-16..R-20) are re-expressible as sequential adapter writes ONLY
because their read-side consumers tolerate per-doc visibility (they
already do today on the mirror side); the design keeps them grouped so
the build wave can swap in the foundation tx primitive if it proves
necessary — it is not required for correctness of the read paths in §2.4.

---

## 2. Architecture the build wave implements

### 2.1 Primary-write helpers (new, seam-side only)

Extend the existing seams; do NOT create a third identity seam:

- **Roles:** `src/lib/server/supa-roles-seam.ts` gains primary helpers
  beside `supaMirrorSet/Update/Delete` (working names:
  `supaPrimarySet/Update/Delete`), differing from the mirror helpers in
  exactly two ways: (i) gated on `isSupaPrimary('roles')` (via the
  seam's existing `supaEnabledFor` path extended with the primary check),
  (ii) they **throw** on adapter error instead of returning `false` —
  a failed primary write must fail the operation. The R19 shape
  translation stays inside `loadAdapter()`; call sites never see
  flattened docs. `supa-roles-route.ts` gains the route-facing wrappers
  (`primarySeamSet/Delete`) with the same `toMirrorData` Date→ISO
  normalization the mirror wrappers carry — renamed in effect, not in
  behavior: under primacy that normalization is the PRIMARY payload
  rule, so the build renames the helper's contract, not its code.
- **Users:** users has no server seam module of its own today (its reads
  live in the directory/picker/profile seams). The build adds primary
  helpers to the same place the users mirrors already pass through —
  the adapter directly via a thin `src/lib/server/supa-users-primary.ts`
  whose ONLY job is: gate on `isSupaPrimary('users')`, translate
  sentinels (ISO), throw on error. It owns no reads. (Naming is the
  build wave's to finalize; the contract is this paragraph.)
- **Reverse mirrors** reuse today's mirror helpers unchanged
  (`mirrorSeamSet/Delete`, `mirrorNotification*`, the notifications
  seam) with the direction swapped: they read the post-write state
  from the PRIMARY (Supa) — never re-read Firestore to build a
  Firestore payload. For the chokepoint (R-01..R-04/U-01/U-02) this
  inverts `mirrorRoleWriteToSupa`'s re-read: under primacy it becomes
  a re-read of the adapter rows (or, preferably, the already-composed
  payloads — the build wave chooses; the pin is behavioral: the
  Firestore copy after a primacy write deep-equals the pre-cutover
  Firestore doc for the same operation, modulo timestamp representation
  §5 IC-09).

### 2.2 The already-switched sites (R-21, R-22, R-23..R-25)

`role-definitions.ts` upsert and the `/api/roles/reads` writeDoc path
already select ONE backend by `SUPA_SURFACES` alone (Supa-only when ON).
Under flag law that is a latent violation: with `SUPA_SURFACES=roles`
live today, these writes are already Supa-primary in production, while
their sibling definition writes (R-16..R-20) are dual-write. The build
wave must, as its first roles step:

- re-key R-22's backend choice to `isSupaPrimary('roles')`: primary →
  adapter; not-primary → Firestore (today's OFF behavior, and today's
  ON behavior when `SUPA_PRIMARY` is unset becomes dual-write via
  R-21's fallback path gaining the R-16-style mirror — i.e. the seam
  upsert acquires a best-effort Firestore→Supa mirror so OFF-state is
  the uniform dual-write the flag law promises);
- state the grandfathering explicitly in code comments: these three
  sites were the program's first primary writes (parity matrix R12
  recorded the stale-Firestore-by-design behavior); the re-key is a
  behavior CHANGE under `SUPA_SURFACES`-only and must ride the same
  deploy note as the users/roles primacy flips, not slip in silently.

### 2.3 What does NOT get a primary helper

- Client-direct writes (§D, S-19/S-20, S-26/S-27): no browser→Supa path
  exists or may be built (no-RLS rule: no browser ever writes Supabase
  directly). Their inversion is a ROUTE migration (§3 class C), owned
  as prerequisites, not as flag flips.
- The pinned gamification transaction (X-05): excluded; C-07 owns it.
- `authority_refresh` (X-04): stays a Firestore write in both modes
  until the client listener leaves Firestore (listeners/decommission
  scope). Role primacy writes keep emitting it on the Firestore side
  as part of the reverse-mirror commit (§3 G-ROLE-1 note).

### 2.4 Read paths — the identity-bundle pin, stated exactly

**This design changes no read path.** Specifically:

- The bundle loader (`loadIdentityBundle`, `permissions.ts:218-255`)
  keeps loading through the existing identity cache + roles seam
  exactly as merged. Its users half stays on its current source; its
  roles half stays seam-served as today. Write inversion does not
  touch `permissions.ts`, `identity-cache.ts`, or
  `auth-middleware.ts`.
- **The pin holds by construction:** POST /api/workflows cold 2 / warm 0
  counts the caller's identity reads on the AUTH+PERMISSION portion.
  No write point in this census is on that portion (the route's own
  users/notification writes, U-43/S-18, happen after the gate, on
  assignees, and are excluded from this wave — §4). No design element
  adds, removes, or re-orders a bundle or permission-doc read, a bust,
  or a TTL. The bust SET is unchanged: every writer that busts today
  busts under primacy, at the same post-commit position (§1.3).
- Directory/picker/profile reads keep serving exactly as flipped
  (users surface). Their correctness under primacy depends only on
  fs_users being written primarily — which is the point of §3 — and on
  the stale-mirror rule (§4, H-06): once `isSupaPrimary('users')`, a
  reverse-mirrored Firestore users doc is NEVER again a source for a
  Supa-served answer; holder resolution continues to decide from the
  roles store with the users doc as mirror, on the primary side.
- `resolveEffectiveScope`'s uncached `permissions/{role}` read
  (identity map §5.2, the measured warm-gap of 1) is a READ with its
  own decision history (FD-20); untouched here. R-16/R-18 primacy makes
  `fs_permissions` the writer of record for the doc it reads — the
  read path itself is not modified in this wave.

### 2.5 Surfaces that stay dual-write even when identity flips

- **Notifications subcollection (S-01..S-18):** the notifications seam
  is a complete, separately-flipped surface (GAP-N1 closed; its mirrors
  are gated on `SUPA_SURFACES=notifications`). Identity primacy does
  NOT re-gate it. When the parent later flips
  `SUPA_PRIMARY=notifications`, that workstream inverts S-01..S-18
  using this census as its write list. Until then they remain
  Firestore-primary + mirrored, INCLUDING inside identity-primacy
  transactions (split-commit note in §3 T-class).
- **Warnings / activity / rewards / votes subcollections
  (S-21..S-27):** no seam, no reconciled table. They stay
  Firestore-primary in BOTH modes during this wave (§3 class SUB),
  which is safe for the pin and the bundle (none is bundle-projected)
  but is an explicit decommission blocker, recorded in §4.

---

## 3. Inversion per write point (grouped where truly uniform)

Group rule: sites are grouped ONLY when trigger shape, tx context,
payload class and reverse-mirror answer are all identical. Every
census ID appears exactly once. **(a)** = reverse mirror to Firestore;
**(b)** = no reverse mirror, reason stated.

### G-ROLE-1 — the role-writes chokepoint — (a) reverse mirror
**Points:** R-01, R-02, U-01 (assign batch); R-03, R-04, U-02 (remove
batch); U-03 (`setMirror`).
**Target:** under `isSupaPrimary('roles')`, assign/remove compose the
roles doc + users mirror + roleHistory entry as adapter writes
(roles surface owns all three rows; the users mirror row is written
through the roles primary path exactly as the chokepoint mirror writes
it today — cross-surface write, already the landed pattern). Commit
order: roles row, users row, roleHistory row. `audit_logs` +
`authority_refresh` stay Firestore writes, executed after the primary
commit (they are the reverse direction's native docs, not mirrors of
identity data).
**Reverse mirror (a):** after primary commit, write the same three
docs to Firestore (roles set/delete, users mirror set, roleHistory
set with serverTimestamp restored as the timestamp representation) —
best-effort, logged, non-throwing. **Reason a Firestore copy must
exist during transition:** the bundle's users half and the
`assertChapterAccess` mirror derivation still read Firestore (identity
map §§1–2, FD-19), the client `roles/{uid}` onSnapshot listener reads
Firestore, and every not-yet-flipped consumer of `roleHistory`
(reconciliation report mode) reads Firestore. `setMirror` (U-03)
inverts identically and GAINS the reverse mirror it lacks today in
mirror form — under primacy its primary write is Supa and its reverse
mirror is the Firestore set it does today.
**Failure semantics:** primary failure = the operation fails with the
same RoleWriteError surface (adapter errors map to the existing 500
class); reverse-mirror failure = log only, operation succeeds, and the
reconciliation job (G-ROLE-4) is the named healer.
**Idempotency:** unchanged — the `roleHistory` idempotencyKey lookup
reads the PRIMARY store under primacy (fs_roleHistory), Firestore
otherwise; a replay commits nothing on either store (pin IC-07).

### G-ROLE-2 — definition stores via admin routes — (a) reverse mirror
**Points:** R-16, R-17, R-18 (role-permissions POST batch);
R-19 (role-permissions DELETE); R-20 (roles/[slug] DELETE).
**Target:** the three-store batch becomes three adapter writes under
`isSupaPrimary('roles')` (set for POST, delete for DELETE), then the
audit write stays Firestore, then **(a)** reverse mirror: the same
three sets/deletes applied to Firestore best-effort. **Reason:**
`hasServerPermission`'s permission-doc walk falls back to Firestore
per-doc when the seam is unavailable, `resolveEffectiveScope` reads
`permissions/{slug}` from Firestore uncached, and the client definition
walk reads Firestore when its client flag is off — all three must see
the same definition the primary holds, or permission answers split by
reader. Busts (`bustPermissionDoc` ×2) fire post-primary-commit,
unchanged.
**Founder/patron docs:** `permissions/founder_patron` and
`roleDefinitions/founder_patron` are ordinary slugs on this path (they
have no other writer — census R-18 note). No special-casing in the
inversion; their hazard is semantic, H-08.

### G-ROLE-3 — already-switched definition/request writes — re-key, then (b)
**Points:** R-21 (upsertRoleDefinition), R-22 (roles/reads writeDoc),
R-23, R-24, R-25 (role_requests lifecycle).
**Target:** §2.2's re-key. Once `isSupaPrimary('roles')` is the gate,
these remain single-write **(b) no reverse mirror** in primary mode —
**reason:** in primary mode their read side is already exclusively
the seam (the client seam reads through the same route), and a reverse
mirror would re-create the stale-Firestore-by-design split R12
recorded, in the opposite direction; the Firestore copy is allowed to
go stale in primary mode because NO flipped reader consults it for
these two collections ahead of the seam (definition reads are
seam-first with Firestore fallback ONLY on seam unavailability — the
fallback risk is accepted and named: if the adapter dies in primary
mode, definition reads fall back to a stale Firestore copy rather than
failing; that is today's R19 fail-safe posture, preserved).
In NON-primary mode they dual-write like everything else (§2.2).

### G-ROLE-4 — reconciliation + expiry sweep — (a) via the chokepoint / direct
**Points:** R-13 (expiry stage stamp); the sweep's materialisation and
the reconciliation repairs (triggers into G-ROLE-1).
**Target:** R-13's plain update becomes adapter-primary
(`supaPrimaryUpdate`) + **(a)** its existing Firestore update becomes
the reverse mirror (today's pair simply swaps roles: the
`supaMirrorUpdate` at `:373` is promoted, the Firestore update at
`:372` demoted to best-effort). Repairs keep flowing through
assignRole/setMirror (G-ROLE-1) — under primacy the reconciliation
READS (already seam-served) and the repairs' primary writes are the
same store, closing the G4 freshness dependency by construction.
**Cron shells unchanged** (C-15: shells land with their surfaces).

### G-ROLE-5 — governors' direct role writes — (a) reverse mirror
**Points:** R-06, U-25 (grantGovernorRole); R-07, U-26 (previousRole
stash); R-08, U-27 (restorePriorRole).
**Target:** these batch composers keep composing into the CALLER's
batch shape, but under `isSupaPrimary('roles')` the build converts
them to compose ADAPTER writes into a parallel primary batch object
(the build wave designs the dual-batch shim inside governors/shared;
callers register.ts/term-sweep.ts keep their commit+bust positions).
Primary commit first, then the caller's Firestore batch commits as
the **(a)** reverse mirror. **Reason for (a):** same bundle/listener
readers as G-ROLE-1. **Reason this group is separate from G-ROLE-1:**
it bypasses role-writes by design (no roleHistory, no consent gate) —
inversion must NOT reroute it through assignRole (that would add
history entries, validation and consent semantics the governors spec
deliberately excluded). The `previousRole` pair (R-07/U-26 →
R-08/U-27) must invert as one unit: the restore reads its source from
the PRIMARY store under primacy (pin IC-11).

### G-ROLE-6 — lifecycle ratification revocation — (a) reverse mirror
**Points:** R-09, U-24.
**Target:** inside `withLifecycleStore`, under primacy the store
abstraction gains a Supa-backed implementation for the roles+users
refs only (the ratification/audit refs stay Firestore); primary
updates land via the store, Firestore updates become the **(a)**
reverse mirror executed in the same store call's fallback leg.
**Reason for (a):** as G-ROLE-1. The asymmetric users payload
(`role` only — H-06) is preserved verbatim in BOTH directions; fixing
the asymmetry is out of scope and would change FD-19 behavior.

### G-ROLE-7 — member-lifecycle + erasure role halves — (a) reverse mirror
**Points:** R-10, U-21, U-22, U-23 (lifecycle); R-12, U-50 (erasure).
**Target:** plain writes become adapter-primary + **(a)** Firestore
reverse mirror (the current writes demoted to best-effort). U-23's
array read-modify-write reads from the PRIMARY under primacy.
**Reason for (a):** `memberStatus` on users is read by directory and
lifecycle readers still on Firestore fallbacks; the roles memberStatus
is read by lifecycle adapters from Firestore. Erasure is additionally
ordered: the tombstone primary write must precede the Auth deletion
step exactly as today (Auth untouched, order preserved).

### G-ROLE-8 — `role_history` (underscore) — (b) no reverse mirror, stays Firestore-primary this wave
**Point:** R-11.
**Decision:** NOT inverted in this wave. **Reason:** there is no
`fs_role_history` table and no reconciled load; the collection is a
Phase-1 parallel store whose supersession of `roleHistory` is
unresolved (backup registry note). Creating the table + load is a
data-program task, not a write inversion. Under roles primacy R-11
keeps writing Firestore only, and the design records it as a named
decommission blocker: roles cannot be declared fully cut over while
R-11 lives. Do not rename it into `roleHistory` as part of inversion
(H-05).

### G-ROLE-9 — consent-gate stamps — (a) reverse mirror by construction
**Points:** R-14 (`roles/{uid}` stamp), R-15 (`roleDefinitions/{slug}` stamp).
**Target:** `stampTarget` gains a primary leg: under the relevant
token's primacy, the stamp writes the adapter first, then Firestore
best-effort **(a)**. **Reason:** the stamp's fields
(`consentMode/consentGateLoggedAt`) ride the SAME doc the flipped
readers serve; a stamp that only reached Firestore would be invisible
to a Supa-served definition/role read, silently un-recording the
gate's record-mode act. The stamp stays failure-swallowed in both
directions (it must never fail the gate — today's contract).

### G-USER-1 — identity-projection writes by admin routes — (a) reverse mirror
**Points:** U-04 (sync-user-role), U-05 (profile PUT), U-07
(add-existing), U-10, U-11, U-12 (chapter association/disassociation),
U-13 (applications/status mirror).
**Target:** plain/batch writes become adapter-primary under
`isSupaPrimary('users')` + **(a)** Firestore reverse mirror.
**Reason:** these write bundle-projected or directory-served fields
(role mirror, chapterId, profile fields); Firestore readers during
transition = the bundle's users half, `assertChapterAccess`, the
profile route's uncached warnings-adjacent reads' sibling doc reads,
and every client that still getDocs users directly. U-10's swallowed
`.catch` is REVERSED under primacy: the primary write's failure must
surface (the catch moves to the reverse-mirror leg only) — a behavior
change the build wave must flag in its report, since a swallowed
primary failure = silent chapter non-assignment on the serving store.
U-12's looped batches invert chunk-wise (primary chunk, then mirror
chunk), preserving the 500 bound.

### G-USER-2 — hierarchy manager writes — (b) no reverse mirror
**Points:** U-08 (move, tx), U-09 (relationships DELETE clear),
U-22 (depart reports cascade), and the managerId half of U-07 is in
G-USER-1 (its chapterId half governs).
**Target:** adapter-primary under users primacy, **(b)**.
**Reason:** `managerId` is not bundle-projected, not directory-served
from fs_users (hierarchy reads resolve through
reporting_relationships + users reads that are route-served), and its
Firestore readers are the hierarchy routes themselves, which read
through the same server layer the build inverts. Accepting Firestore
staleness for this single field family is safe BECAUSE the canonical
edge store (reporting_relationships) is separately written by
`syncDirectRelationship` in the same flows and is not part of this
surface. Flagged honestly: if any un-inventoried Firestore reader of
users.managerId exists, it sees stale edges until decommission —
the build wave's acceptance audit must grep-verify the reader set
against census §F before flipping.

### G-USER-3 — shell user creation — (a) reverse mirror
**Point:** U-06.
**Target:** adapter-primary with a generated id (adapter setDoc with
a client-generated id, preserving auto-ID semantics), **(a)** reverse
mirror creates the Firestore doc with the SAME id. **Reason:** the
shell must be claimable on sign-in by flows that still read Firestore
(ensureUserProfile/backfill family, §D), and an id split between the
stores would create two shells for one person.

### G-USER-4 — auth-critical + discipline/lifecycle users writes — (a) reverse mirror, transaction-split
**Points:** U-14, U-15 (founder-review txs), U-16, U-17, U-18, U-19
(discipline txs), U-20 (derived counter), U-52 (clear-probation).
**Target:** these live inside transactions whose OTHER docs are
disciplinary_cases / audit (other clusters, Firestore). Under users
primacy they become **split-commit**: (1) primary adapter update of
fs_users, (2) the Firestore transaction runs as today with its users
update DEMOTED to the **(a)** reverse mirror inside the same tx (so
the tx's atomicity for case+audit+users-mirror is preserved on the
Firestore side), (3) busts as today. **Reason for (a), non-negotiable:**
`users.isBanned` is bundle-projected and `verifyAuthentication` folds
bundle state into 401s; a banned member whose ban existed only in
Supa while any bundle load still sources Firestore would be
authenticated against a stale not-banned mirror (and the reverse for
reinstatement). Until the parent flips the bundle's users half (a
READ decision outside this wave), the Firestore copy of
isBanned/isBlacklisted/warningCount must be transactionally fresh —
hence the mirror stays INSIDE the tx, not post-commit.
**Atomicity honesty:** primary-first + tx-second means a tx failure
after a primary success leaves fs_users ahead by one sanction field
until the tx's retry/reversal; the design accepts this because every
one of these flows is retryable/idempotent at the case level and the
discipline verifier checklist (§5 IC-12) pins the divergence window
as observable in tests. The alternative (tx first, primary second)
reintroduces today's unmirrored-staleness on the SERVING store, which
is strictly worse.

### G-USER-5 — points/counter increments (INC class) — primary RMW, (a) reverse mirror
**Points:** U-31 (universal-review points), U-33 (submissions points),
U-34 (bug-reports points), U-35 (process-dlq), U-36..U-43 (task
counters incl. delegate + workflows POST), U-45 (webhook reward tx
users half), U-41 (tasks/batch — already mirrored, RMW).
**The increment problem:** `FieldValue.increment(n)` has no adapter
equivalent; today's mirrors either skip these writes (the explicit
"an increment has no safe absolute-value mirror" note at
submissions:427) or RMW-absolutize them (U-41, U-48). Under primacy
there is no Firestore original to increment against, so EVERY INC
site converts to: **read primary row → compute absolute → adapter
updateDoc**, executed in the site's existing commit grouping where
one exists (batch sites accumulate their RMW values and apply them
at the batch's commit point, in site order).
**Reverse mirror (a):** the Firestore leg keeps its NATIVE increment
(same batch/tx as today) — i.e. under primacy the Firestore write
stays byte-identical and simply changes status from primary to
reverse mirror, while the Supa leg is the new RMW. **Reason:** the
Firestore increment is the only race-safe representation on that
side, and directory/dossier readers still on Firestore need true
counts.
**Race honesty (H-04):** RMW on the primary loses increments under
true concurrency where Firestore's increment did not. This is a
known, accepted cutover cost for counter fields ONLY, bounded by:
single-writer reality for most counters (one reviewer/assignee flow
at a time), the ledger docs (points_ledger etc.) remaining the
auditable source from which counters can be recomputed, and U-41's
landed RMW precedent. Sites whose payload mixes increments with
identity-projection fields in one set (none in this class — verified)
would have been excluded; all INC payloads are counters/points only.
**U-43 (workflows POST)** is in this class mechanically but is
**excluded from the W4 identity build** and lands only in the pinned
-route single-agent slot (W4's workflows residual item) with the pin
re-proof — §4.
**U-45** additionally carries the webhook-plane caveat: its trigger
is a Firestore write event; under full cutover the webhook's reason
to exist changes. This design inverts its users write as above and
records the trigger question as a program-level blocker (§4), it
does not redesign the webhook.

### G-USER-6 — vacation/leave flag writes — (a) reverse mirror
**Points:** U-28 (leave-return), U-29 (restore-workload), U-32
(universal-review leave approval).
**Target:** adapter-primary + **(a)** Firestore reverse mirror (the
Firestore batch/update stays, demoted). **Reason:** vacation state is
read by task-assignment validation (`validateUserStatus`) from
Firestore in routes not yet flipped at identity-flip time, and by the
profile UI; a stale not-on-vacation mirror would let assignments land
on a member the primary knows is away (and vice-versa on return).
The leave-owned docs in these flows keep their existing leave-surface
mirrors, unchanged and un-duplicated (the build must not mirror the
users doc through the leave seam — wrong surface, H-01).

### G-USER-7 — skillIds array writes (RMW class) — primary RMW, (a) native array op as mirror
**Points:** U-30 (universal-review skill extraction), U-48
(assign-bulk), U-49 (skill-delete detach).
**Target:** U-48/U-49 already have RMW mirrors (`mirrorUserSkillGrants/
Revoke`); under users primacy those RMW bodies become the PRIMARY
write and the Firestore batch keeps its native
arrayUnion/arrayRemove as the **(a)** reverse mirror. U-30 joins the
same pattern (primary RMW union; Firestore batch unchanged, demoted).
**Reason for (a):** skills readers are split (skills surface reads
fs_users for holders; unflipped readers read Firestore), and
arrayUnion/arrayRemove are idempotent set ops — the RMW primary and
the native mirror converge even under retries, unlike INC (H-04 does
not apply; set-union is commutative).

### G-USER-8 — events-attended + push + misc plain writes — (a) reverse mirror
**Points:** U-44 (tickets eventsAttended arrayUnion — RMW on primary,
native op as mirror, as G-USER-7), U-51 (push-server token fields),
U-46 (webhook badge arrayUnion), U-47 (webhook email_lowercase).
**Target:** adapter-primary + **(a)**.
**Reason:** badges/eventsAttended are profile-served fields (profile
read path is users-surface served; its Firestore fallback must not
serve a badge-less copy), and email_lowercase is the directory's
email-probe field on the Firestore fallback path — a stale probe
field breaks the exact-email lookup the directory ruling depends on.
U-47's skip-if-missing contract is preserved on the primary leg
(adapter update on a missing row is a no-op-skip, never a create).

### G-USER-9 — client-direct users writes (C class) — NO flag flip; route migration prerequisites
**Points:** C-01..C-13 (§D), S-19, S-20, S-26, S-27.
**Decision:** `isSupaPrimary('users')` changes NOTHING for these
sites. A browser cannot write Supabase (no-RLS rule), so under users
primacy these sites would keep writing the NON-primary store — the
one outcome primacy cannot tolerate for the fields they own
(profile creation!, terms acceptance, badges, application flags,
votes). Therefore each is a **prerequisite route migration**, sequenced
BEFORE the users token may flip (§4):
- C-01/C-02/C-03/C-04 (profile create/heal): route through a server
  endpoint that performs the G-USER-1-class primary write (the
  natural home is the profile route family; the endpoint must preserve
  create-if-missing + backfill semantics and fire-and-forget posture).
- C-05/C-06 (welcome/terms): fold into the same profile-write endpoint
  (allow-listed field sets already exist server-side at U-05).
- C-07/C-08 (induction flags): the induction submit already has a
  server-adjacent batch in the applications workstream; the users
  flag half moves to the applications/status-class server write.
- C-09/C-10 (decision mirror): the mirror already exists server-side
  in universal-review's domain; the client copies are best-effort
  duplicates — the prerequisite is to DELETE the client writes once
  the server path is proven to cover both decision routes (H-02), not
  to re-route them.
- C-11 (badge dialog): server award endpoint (bug-reports U-34 shows
  the server award pattern) or accept the dialog moving to the
  existing admin users API family.
- C-12/C-13 (prefs/push): low-value fields; EITHER a tiny
  preferences endpoint OR an explicit Zubair decision that these two
  field families stay Firestore-only past the flip (they would be the
  last Firestore writers in the surface — the decommission gate must
  list them by name if so).
- S-19/S-20 (notifications client writes): notifications workstream's
  residuals, unchanged by this design; S-20's mark-read can move to
  the existing S-07 route with no new endpoint.
- S-26/S-27 (vote transactions): need a server vote endpoint
  (transaction → primary RMW + mirror increment); until it exists the
  votes feature is a named users-primacy blocker.
**Until its prerequisite lands, each site stays Firestore-primary in
both modes** — which is precisely why §4 sequences them before the flip.

### G-SUB-1 — notifications subcollection — stays dual-write (see §2.5)
**Points:** S-01..S-18 (S-18 excluded from any change in this program
wave; it lands with the workflows slot). No inversion, no re-gating.
The identity build wave touches NONE of these.

### G-SUB-2 — warnings / activity / rewards subcollections — stays Firestore-primary this wave
**Points:** S-21 (activity), S-22 (rewards), S-23, S-24, S-25 (warnings).
**Decision (b)-equivalent:** no primary write and no mirror — they
stay Firestore writes in both modes. **Reason:** no reconciled
fs_group table and no serving reader exists for any of them; inventing
tables is the data program's work, and none of these fields is
bundle-projected or directory-served, so their staleness cannot poison
a flipped read. They are recorded as decommission blockers (§4): a
Firestore with ONLY warnings/activity/rewards writers is still a
Firestore dependency.

---

## 4. Hazard register

- **H-01 — Name/surface collisions (mirror vs primary both writing).**
  fs_users is written today by mirrors gated on FOUR different tokens:
  `roles` (chokepoint), `skills` (U-48/U-49), `tasks` (U-41), `users`
  (directory-era mirrors), plus the gamification seam (X-06, OFF).
  Under `SUPA_PRIMARY=users`, every one of those mirror paths must be
  re-pointed or stood down for the rows the primary now owns, or two
  writers race the same row with different payload shapes (full-doc
  re-read vs field RMW). Rule for the build: **exactly one primary
  writer per (collection, field-family)**; other surfaces' mirrors of
  users fields become reverse-direction or no-ops when users is
  primary, decided per site in §3 (U-41's mirror is tasks-owned: when
  users is primary, its RMW becomes the primary leg and the Firestore
  batch is the mirror — the seam's flag check must consult
  `isSupaPrimary('users')` in addition to its own surface). Same rule
  for fs_roles: `roles`-gated mirrors (chokepoint, R-13) vs any future
  primary.
- **H-02 — Duplicate implementations of the same write.** C-09 = C-10
  (decision mirror, two client copies); S-07 = S-20 (mark-read, route
  + component, DIFFERENT mirror states today); S-26 = S-27 (vote tx,
  two client copies); U-28 = U-29 (vacation clear, two server paths);
  R-19 = R-20 (definition delete, two routes). Inverting one copy and
  not its twin is the single most likely cutover defect in this
  surface; §5 pins each pair (IC-15).
- **H-03 — The R19 shape-translation precedent.** The roles seam
  exists because group 1's seam silently never engaged against the
  real adapter (flattened `{id,…fields}` vs `{exists,data}`), fail-safe
  but invisible. Primacy raises the stakes: a primary helper with the
  same class of mismatch would silently write WRONG SHAPES (id field
  embedded in data jsonb, timestamps as sentinel objects) into the
  serving store. Rules carried from R19: (i) all translation inside
  the seam's adapter binding, never at call sites; (ii) every primary
  helper gets a real-adapter-shaped fake in its tests (flattened docs,
  null-for-missing), never a Firestore-shaped fake; (iii) `data.id`
  must never be written from a payload that carries its own `id`
  field (the adapter id-clobber caveat from the announcements merge
  applies to users/roles payloads verbatim — several users payloads
  DO carry no id, but roleHistory/governor payloads must be checked).
  Timestamp split: the same logical write stores ISO on Supa and
  serverTimestamp on Firestore (R-02, R-24 already live this split);
  consumers of fs_roleHistory must never expect Timestamp shapes.
- **H-04 — Increment/RMW race (INC class, G-USER-5).** RMW primaries
  can lose concurrent increments. Accepted for counters/points only,
  for the reasons in §3; NEVER acceptable for identity-projection
  fields, and no §3 group applies RMW to them. The build must not
  "optimize" G-USER-1/G-USER-4 writes into RMW.
- **H-05 — Shape divergence inside `roles/{uid}`.** Three writers
  write three shapes: role-writes (role + catalog additionalRoles +
  chapterId + expiry quintet, schemaVersion 2), governors (role +
  grantedBy/grantedAt + `previousRole`), ratification (role +
  `roleKey` + `currentRoleKey`). Merge-writes mean all three shapes
  coexist in one doc today and will in fs_roles. Inversion preserves
  each writer's exact field set (§3 groups are deliberately separate);
  "normalizing" the shapes during inversion is forbidden — the
  resolution core reads `role` only, and a normalization that dropped
  `previousRole` would break governor restores (IC-11). Plus the
  `role_history` vs `roleHistory` naming split (R-11/R-08 decision):
  two collections, one of which has no table — conflating them in the
  adapter (whose table mapping lowercases nothing but derives
  `fs_<collection>` verbatim) would write history into the wrong table.
- **H-06 — additionalRoles semantics + the stale-mirror override rule.**
  Semantics (identity map §2.2, verified): on the mainstream path ONLY
  `custom_` slugs in additionalRoles confer anything, via
  `resolveHolderRoles`, uncapped on the server; catalog additionals
  confer nothing there (they matter to offices/reconciliation/client
  rules-cap 0–2, a rules artifact). The users-mirror additionalRoles
  are read ONLY when the roles primary is missing/blank (wholesale
  record win, never merged). **Stale-mirror override rule (from the
  directory role-filter fix, carried into primacy):** the RESOLVED
  role decides; a stale users mirror confers nothing — holder
  resolution is exact against the roles store, and a mirror that
  disagrees with the roles doc is data to be repaired (setMirror /
  sync-user-role), never an answer. Under primacy this rule applies
  on the Supa side identically, AND its dual: a reverse-mirrored
  Firestore users doc must never be allowed to "repair" or override
  the primary — reverse mirrors are write-only shadows; no primary
  write may source its payload from the Firestore copy (the
  chokepoint's re-read inverts to a primary re-read, §2.1). Two §3
  asymmetries are pinned, not fixed: U-24 writes users `role` without
  displayRole/additionalRoles; removeRole deletes additionalRoles
  from the mirror while assignRole writes them — both are live
  semantics.
- **H-07 — Unreconciled subcollection tables.** warnings/activity/
  rewards/votes have no dump file and no fs_group table (§B preamble).
  Any build step that assumes `fs_group_warnings` exists will fail at
  runtime, not at build. G-SUB-2 keeps them off the primary until the
  data program lands tables + loads + a reader decision.
- **H-08 — Founder/patron permission docs.** `permissions/{slug}` and
  `roleDefinitions/{slug}` for founder_patron/superadmin are written
  ONLY via G-ROLE-2 (no seed writer exists). Hazards: (i) the blanket
  in `hasServerPermission` (`permissions.ts:84`) fires BEFORE any doc
  read, so a botched primary write to these docs cannot lock the
  founder out of the permission path — but the static-config fallback
  and the client walk DO read them; (ii) `permissions/founder_patron`
  may carry `_scope` — the FD-20 demotion surface: `resolveEffectiveScope`
  honors a stored `_scope` override on an uncached Firestore read. Under
  roles primacy the doc's writer of record is fs_permissions while that
  reader still reads Firestore — the G-ROLE-2 reverse mirror is what
  keeps them the same doc; dropping the mirror for "just this slug"
  is forbidden; (iii) founder recognition is a UID in
  `src/config/founder.ts` and a STRING in the permission path — inversion
  changes neither, and must not "fix" FD-15/FD-19 (SPEC-FAIL designed
  failures stay exactly 5).
- **H-09 — `chapter_president` open semantics question — FLAGGED, NOT RESOLVED.**
  The directory role-filter work parked this question (DEPLOY_READY_REPORT
  morning list item 3): whether a `chapter_president` role filter (and,
  by extension, holder resolution for that slug) matches primary-role
  holders only, or also holders via additionalRoles / the users mirror,
  was never ratified — the founder-alias pin (founder_patron resolves
  without an equality query) is the adjacent precedent, not an answer.
  This design takes NO position and changes NO holder semantics:
  inversion reproduces today's exact-resolution behavior on the
  primary store, whatever it is, and §5 pins parity (IC-16) rather
  than an outcome. The build wave must not settle it incidentally —
  any diff that changes chapter_president matching is out of scope and
  blocks the flip until Zubair ratifies.
- **H-10 — The bundle failure fold.** A throwing bundle load folds to
  401 for EVERYONE (identity map §1.5d) — under primacy, an adapter
  outage on a primary WRITE path is loud (operation fails), but the
  design must ensure no write path converts an adapter failure into a
  fabricated success or a swallowed primary error (U-10's catch is the
  one existing pattern that would do this; §3 G-USER-1 reverses it).
  No founder shelter is added anywhere in this wave (§6.3 of the
  identity map: reproduce today's fold; the shelter is a separate
  decision).
- **H-11 — Split-commit ordering across clusters.** Identity batches
  that also write tasks/audit/leave docs (§3 T/G-USER-4/U-28/U-30..33)
  become two commits. The order is fixed (identity primary → foreign
  Firestore writes incl. demoted identity mirror → other surfaces'
  mirrors) so a mid-flow crash leaves the SERVING store correct and
  the shadow store repairable, never the reverse.
- **H-12 — Bust coverage asymmetry.** Writers that bust today are
  enumerated in the identity map §1.4; primacy adds NO new busts and
  removes none, but two census writers never busted (U-12 loop, most
  INC-class writers — counters are not bundle-projected, so no bust is
  owed) — the build must not "fix" bust coverage opportunistically:
  a new bust on a hot path changes read counts the pin measures
  (warm-0 is measured on POST /api/workflows, whose writers are out
  of this wave, but the discipline is general).

---

## 5. Contract pin list (the build wave authors these suites)

Naming: `IC-##` (identity cutover). Each pin = one named test (or one
parameterized family) with the stated assertion. Suites live beside the
existing families (`supa-roles-*`, `supa-users-*`, `identity-cache-*`)
and reuse their fakes; adapter fakes must be REAL-adapter-shaped
(H-03). No pin may be satisfied by a Firestore-shaped fake.

**OFF-state byte-identity pins (flag law, §0):**
- IC-01 `off-state-byte-identity` — for EACH §3 group, with
  `SUPA_PRIMARY` unset: the Firestore writes (collection, doc, payload,
  commit grouping) deep-equal the pre-cutover writes for a fixture
  operation, AND the adapter receives ZERO primary calls (mirror calls
  exactly as today). Parameterized over: assign, remove, setMirror,
  definition POST, definition DELETE ×2 routes, expiry stamp,
  governor grant/restore, ratification revoke, depart, reinstate,
  erasure, sync-user-role, profile PUT, chapter approve/disassociate,
  founder-review revoke/reinstate, discipline strike1/strike2/expel,
  universal-review points/leave/skills, submissions points, tasks
  counters (POST/PATCH/DELETE/batch/delegate), leave-return flags.
- IC-02 `both-flags-rule` — token in `SUPA_PRIMARY` only (not in
  `SUPA_SURFACES`): behavior identical to IC-01 for both surfaces.
  Token in `SUPA_SURFACES` only: identical to today's dual-write.
  Both: primary mode (the IC-03..IC-13 states). Case/whitespace
  variants parse like `useSupa`.
- IC-03 `primary-failure-is-loud` — adapter throws on the primary leg
  of assign / definition POST / profile PUT / discipline expel: the
  operation returns its error surface, NO Firestore write occurs
  (no shadow-first commit), and no success response is produced.

**Primary-mode behavior pins:**
- IC-04 `chokepoint-primary-order` — assign under roles primacy:
  adapter writes occur in order roles → users → roleHistory; the
  Firestore reverse mirror carries docs deep-equal to the primary
  rows modulo timestamp representation; audit_logs +
  authority_refresh are written to Firestore only, once.
- IC-05 `remove-delete-parity` — remove under primacy: fs_roles row
  deleted, Firestore roles doc deleted by the mirror, users mirror =
  member_basic with additionalRoles REMOVED on both stores.
- IC-06 `definition-three-store-coherence` — POST + both DELETE
  routes under primacy: all three stores (roleDefinitions,
  permissions, role_permissions) agree on both backends after the
  operation; a mirror failure on one store leaves the other two
  primary-correct and is logged (named, not silent).
- IC-07 `idempotency-replay-writes-nothing` — replayed assign/remove
  under primacy: zero adapter writes, zero Firestore writes, claims
  re-stamp still fires (X-01 unchanged).
- IC-08 `expiry-quintet-round-trip` — assign with a custom grant +
  expiry, then expiry sweep materialisation, under primacy: the five
  expiry fields land in fs_roles in ISO/JSON shapes
  `expiryInstantOf` accepts (never-expires regression guard from the
  identity map §6.1), and the sweep's stage stamp (R-13) is
  primary-first.
- IC-09 `timestamp-representation` — every primary payload in §3:
  no serverTimestamp sentinel, no FieldValue sentinel, no Date object
  reaches the adapter (deep-scan assertion); Firestore mirror payloads
  carry the native sentinels as today.
- IC-10 `increment-rmw-equivalence` — for each INC site: N sequential
  awards under primacy produce the same fs_users counter as N
  Firestore increments produce in Firestore; a mixed payload site
  (points + submissionsApprovedCount) updates both fields atomically
  in one adapter update.
- IC-11 `governor-previousrole-round-trip` — seat → vacate under
  primacy: previousRole is stashed on BOTH stores' roles+users docs,
  restore reads it from the primary, and the restored role matches
  the pre-seat role on both stores; the grant writes NO roleHistory
  row on either store.
- IC-12 `split-commit-tx-mirror-inside` — discipline expel + founder
  reinstate under primacy: the Firestore tx still contains the users
  update (mirror-inside-tx), the primary update precedes it, and a
  forced tx failure leaves a NAMED, test-observable divergence
  (primary ahead) that a retry of the same case closes.
- IC-13 `consent-stamp-primary` — record-mode gate on a role route
  under primacy: roles doc carries consentMode fields on BOTH stores;
  a stamp failure in either direction does not fail the gate.

**Pin-preservation pins (the pinned read path):**
- IC-14 `caller-batch-helper-contract` — `addRoleChangeToBatch`
  (R-05) under primacy still composes Firestore-shaped batch ops and
  performs no adapter call (its contract is unchanged); a suite-level
  grep/assertion that no production caller exists remains green.
- IC-15 `duplicate-pair-parity` — for each H-02 pair (C-09/C-10 —
  post-prerequisite state, S-07/S-20, S-26/S-27, U-28/U-29,
  R-19/R-20): the same operation through either copy yields identical
  primary + mirror writes; if a pair is unified by its prerequisite,
  the pin asserts the retired copy performs no identity write.
- IC-16 `chapter-president-parity-flagged` — directory role filter
  for `chapter_president` under users primacy returns EXACTLY the
  holder set the dual-write tree returns on the same fixture corpus
  (parity pin only; the semantics question H-09 stays open and this
  pin must be re-ratified, not edited, if Zubair settles it).
- IC-17 `workflows-pin-under-identity-primacy` — with
  `SUPA_PRIMARY=users,roles` (and the workflows token as live), the
  full identity pin family re-runs green UNMODIFIED:
  `identity-cache-integration` T-A1 (POST /api/workflows cold 2 /
  warm 0, incl. 0 roleDefinitions/permissions gets warm),
  `route-assignment-notifications` (creator users doc never fetched),
  and the T-A3 write-invalidation family (every mapped writer's bust
  still lands post-commit under primacy).
- IC-18 `bundle-shape-under-primacy-writes` — after a primacy assign
  + remove + governor grant + ratification revoke against one uid,
  a cold bundle load deep-equals the bundle the dual-write tree
  produces for the same operation sequence (incl. isBanned coercion,
  additionalRoles slicing, expiry fields) — the §6 drop-in contract
  of the identity map, exercised through WRITES this time.
- IC-19 `stale-mirror-never-overrides` — hand-corrupt the Firestore
  users mirror (stale role/additionalRoles) after a primacy write:
  directory holder resolution and bundle fallback answers are
  unchanged (roles store decides); hand-corrupt fs_users instead:
  answers follow the primary (the corruption is visible — proving
  which store served).
- IC-20 `client-direct-untouched-by-flag` — with users primacy ON,
  every §D site still performs its Firestore write and ZERO adapter
  calls originate from client code (structural pin over the
  prerequisite state: until a site's route migration lands, its row
  in this pin is the current behavior; the pin is updated site-by-site
  as prerequisites land, never deleted).

---

## 6. Sequencing for the build wave (W4) + flip order

1. **Prerequisites (before any identity token flips):** foundation's
   `isSupaPrimary` merged; G-ROLE-3 re-key (§2.2) merged BEHIND the
   flag (behavior change under SURFACES-only, deploy-noted);
   G-USER-9 route migrations for C-01..C-08 at minimum (profile
   creation + induction flags) — the remaining C-class items may flip
   only with their names on the decommission blocker list (§4 of the
   program report), by Zubair's call.
2. **Build order inside the wave:** G-ROLE-1 (chokepoint) → G-ROLE-2
   → G-ROLE-4 → G-ROLE-5/G-ROLE-6/G-ROLE-7 (parallel-safe, disjoint
   files) → G-USER-1/G-USER-4 → G-USER-5/G-USER-7 (INC/RMW) →
   G-USER-6/G-USER-8/G-USER-2/G-USER-3. Pins IC-01/IC-02 land with the
   FIRST group, not at the end.
3. **Flip order (parent's env decision, recommended):** `roles`
   first (smaller writer set, chokepoint-dominated, R11 pin already
   proven in dual-write), soak, then `users`. The two flips are
   independent by design (§0); if users must go first, G-USER-4's
   mirror-inside-tx is the reason it can.
4. **Rollback:** remove the token from `SUPA_PRIMARY` → dual-write
   resumes on the same build; the reverse mirrors have kept Firestore
   transactionally fresh for every (a) group, so rollback loses
   nothing except (b)-group fields (managerId family, R-22-class
   definition writes in primary mode) — named in §3, accepted there.
   Remove from `SUPA_SURFACES` too → full Firestore fallback as today.
5. **Explicit non-goals of the wave:** no bundle/read-path change
   (§2.4), no FD-15/FD-19 fix (SPEC-FAIL stays 5), no chapter_president
   semantics decision (H-09), no gamification transaction (X-05/C-07),
   no workflows POST change (U-43/S-18 ride the separate pinned slot),
   no `role_history` table creation (R-11), no warnings/activity/
   rewards/votes tables (G-SUB-2), no claims change (X-01/X-02),
   firestore.rules untouched.

## 7. Open questions for the parent / Zubair (do not block the build)

1. H-09 chapter_president holder semantics — ratify or keep parity
   (IC-16) indefinitely. (Already on the morning list via the
   directory fix; this design adds nothing new.)
2. C-12/C-13 (preferences/push client fields): route them, or name
   them as permanent Firestore stragglers at decommission?
3. Webhook plane (U-45..U-47, S-16/S-17/S-21/S-22): when Firestore
   events stop, what triggers the reward/badge/email-sync flows —
   a program-level decision the decommission workstream needs before
   W5's kill-switch proof.
4. `role_history` (R-11): table + load, or fold depart/reinstate
   history into `roleHistory` as a product decision?
