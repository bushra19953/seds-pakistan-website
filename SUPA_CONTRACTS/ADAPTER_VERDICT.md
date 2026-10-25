# Adapter Contract Verdict — feat/supa-adapter

- **Adapter under test:** branch `feat/supa-adapter`, commits `9f8ff97`
  (@supabase/supabase-js 2.118.0) + `85e657f` (adapter). Files:
  `src/lib/supa/{adapter,client,flags,index}.ts` (adapter.ts = 480 lines).
- **Contracts:** branch `test/supa-adapter-contracts` (base
  feat/integration-wave3 @ 4d5a1e16). Suite:
  `src/lib/supa/__tests__/adapter-contracts.test.ts` (27 tests) against the
  faithful in-memory PostgREST fake in `src/lib/supa/__tests__/fake-supa.ts`.
  The fake reproduces real stack semantics (jsonb `->>` text extraction,
  SQL NULL handling, Postgres NULL placement on ORDER BY, the PostgREST
  ~1000-row response cap), so a red test is a failure the live stack would
  also exhibit, not a mock artifact.
- **Method:** expectations are written as the FIRESTORE behavior the
  consuming routes rely on today, derived in
  [PATTERN_INVENTORY.md](PATTERN_INVENTORY.md). Run: `npx jest
  src/lib/supa/__tests__/adapter-contracts.test.ts --ci` → **8 failed, 19
  passed** (full log: `SUPA_CONTRACTS/jest-run.log`, uncommitted).
- **Constraints honored:** zero live reads (Firestore or Supabase). No
  merge, no push. The adapter files were overlaid into this worktree
  read-only for the run and are NOT committed on this branch.

## VERDICT: GAPS — do not flip any surface to `useSupa` yet

19 of 27 contracts pass, including counts, error propagation, doc-get,
subcollection scoping, array-contains, write row shape, and client gating.
The 8 failures cluster exactly where the pattern inventory predicted
risk: document-id filters, unbounded reads, and everything touching
timestamps. Four gaps are launch-blocking for the first migration waves
(G1, G3, G4, G6).

## Gaps (each = one failing contract test)

### G1 — `__name__` / `id` WHERE filters query a data field that never exists — BLOCKING (directory)

`applyWhere` builds the column unconditionally as `data->>'<field>'`
(`adapter.ts:239`), and `in` maps values through the same column
(`adapter.ts:244`). Only ordering special-cases `id`/`__name__`
(`orderColumn`, `adapter.ts:273-274`). So the roles-overlay fetch used by
both directory surfaces — `where('__name__','in', ids)` at
`src/app/api/admin/users/route.ts:197` and
`src/app/api/users/picker/route.ts:84` — returns **zero rows** through the
adapter: every user would render with the users-doc mirror role and no
expiry, silently.
Fix: in `applyWhere`, route field `id`/`__name__` to the `id` column
(same rule as `orderColumn`).

### G2 — Unbounded listDocs silently truncates at the PostgREST row cap — BLOCKING (picker, tasks union)

`listDocs` issues a single select with no range pagination
(`adapter.ts:332-365`). PostgREST caps a response (~1000 rows by default);
Firestore `.get()` has no such cap. The picker
(`src/app/api/users/picker/route.ts:63-127`) and the tasks assignee union
(`src/app/api/tasks/route.ts:1911-1961`) are unbounded by design — the
contract seeds 1005 users and gets 1000 back, with no error. Fix:
range-loop inside `listDocs` when no explicit limit is given (or loop
until a short page whenever the returned count equals the page size).

### G3 — Timestamp range filters compare ISO filter text against dumped JSON text — BLOCKING (announcements)

The kit's dump stores every Firestore Timestamp as
`{"_seconds":…,"_nanoseconds":…}` (measured; see TIMESTAMP_CENSUS.md).
`scalarText` converts a Timestamp-like filter value to an ISO string
(`adapter.ts:215-227`), and the comparison runs against `data->>'field'`,
whose text for a stored object is its JSON text (`adapter.ts:239,255`).
`'{'` sorts after every digit, so `publish_date <= now` matches NOTHING:
past-dated published announcements vanish and the range contract
(announcements pattern A1, `src/lib/announcements.ts:235-262`) fails end
to end. The same asymmetry poisons every `<,<=,>,>=` filter on a
timestamp field. Fix: this cannot be repaired by string tricks — the
adapter (or the kit) must normalize timestamps to one comparable
representation (see "Timestamp decision" below).

### G4 — orderBy has no existence filter and no doc-id tiebreak — BLOCKING (announcements, audit tail, tasks)

Firestore `orderBy` excludes docs missing the field and tiebreaks by
document id. `listDocs` adds neither an existence predicate nor a
secondary id order (`adapter.ts:338-365`): under Postgres, a doc missing
`updated_at` sorts FIRST on DESC (nulls first) instead of being excluded
(contract: announcements orderBy). Affects A1, DB3
(`src/app/api/admin/dashboard/init/route.ts` audit tail), T1. Fix: add
`data->>'<field>' IS NOT NULL` for each ordered field and always append
`id` as the final order key.

### G5 — Sub-second timestamp ordering is inverted by storage text

With G3's representation, ordering `createdAt` desc across distinct
seconds happens to work (control test passes), but within one second the
JSON text compares `"_nanoseconds":45000000` AFTER
`"_nanoseconds":123000000` (`'4' > '1'`), so a 45 ms doc outranks a
123 ms doc (contract: tasks T1). Any same-second burst (bulk imports,
workflow fan-out) misorders. Fixed by the same normalization as G3.

### G6 — startAfter(Timestamp) cursor on a data field returns an empty page — BLOCKING (tasks)

For a data-field primary order, `startAfter` becomes
`lt/gt(column, scalarText(cursor))` (`adapter.ts:347-357`) — the same
ISO-vs-JSON text mismatch as G3, so the tasks list's tier-1 cursor
(`src/app/api/tasks/route.ts:1887-2042`, cursor = last createdAt millis)
yields `[]` on page 2: pagination silently truncates after page 1.
Fixed by the same normalization as G3.

### G7 — Equal order values have no deterministic order (consequence of G4)

Two tasks with identical `createdAt` come back in storage order, not
Firestore's id-ascending tiebreak (contract: tasks T1 tiebreak). Any
cursor scheme built on top inherits the instability. Fixed by G4's
secondary id order.

### G8 — `field == null` also matches docs missing the field — minor

`== null` becomes `IS NULL` on the text extraction (`adapter.ts:250`),
and jsonb extraction yields NULL both for an explicit null and for an
absent key, so the two Firestore-distinct states collapse (contract:
null equality). No top-burn pattern depends on the distinction today;
recorded so nobody builds one on the adapter unknowingly.

## Passing contracts (19) — the sound core

- D1 browse paging (chapter equality + `__name__` order + id cursor +
  limit) — exact page contents.
- D2 equality exactness (email probe is case-sensitive, matching
  Firestore `==`).
- D3 array passthrough (`additionalRoles` returned verbatim).
- A1 string-equality composition (status + audience).
- DB1 counts: exact with filters, missing-field docs excluded,
  parallel counts independent.
- Error semantics: `countDocs` and `listDocs` reject with
  `SupaAdapterError` (`query-failed`) on backend errors — the routes'
  per-name degradation (dashboard) and tier ladders (tasks) depend on
  this and it holds.
- T1 cross-second `createdAt` ordering (control — passes only by the
  accident documented in G5).
- T2 `array-contains` → jsonb `cs` translation (array holders only;
  missing/non-array fields excluded).
- Doc get: missing → `null` (never throws, never `{}`); present →
  `{id, ...data}`; subcollection reads scoped by `parent_path`
  (`users/u2/notifications` cannot see u1's rows).
- Write fidelity: `setDoc` stamps the kit's row shape (`firebase_uid`,
  `parent_path`, group table for subcollections); `updateDoc` rejects
  `not-found` on missing docs and expands dot-path keys.
- `tableForCollection` / `resolveTarget` match the kit
  (`migrate_db.js` sanitization, `fs_group_<sub>` for subcollections,
  bad paths throw).
- Client gating: null client → `SupaUnavailableError` on every op, so
  the documented Firestore-fallback pattern works.

## Spec gaps the contracts could not even express

- **No projection support.** `ListOptions` has no field selection;
  `listDocs` always selects `id, data`. Two census patterns project on
  purpose (roles overlay `.select('role','expiresAt')`, D1; dashboard
  pending-sample `.select('created_at','createdAt')`, DB2). Through the
  adapter those reads return full docs — behavior-compatible for shape,
  but the read-cost contract of the burn fixes is silently dropped.
- **Read results return stored jsonb verbatim.** `toDoc`
  (`adapter.ts:311`) spreads `data` untouched, so every timestamp field
  arrives as a raw `{_seconds,_nanoseconds}` object. What consuming code
  does with that is enumerated in TIMESTAMP_CENSUS.md: of the 8
  hand-verified sites, 3 fail silently under this shape (dashboard audit
  tail stamps "now" on all rows; tasks cursor math zeroes out;
  announcements date logic misclassifies), and unguarded `.toDate()` /
  `.toMillis()` calls crash. Census scale: 207 `.toDate()`/`.toMillis()`
  call sites across 121 files (full enumeration:
  TIMESTAMP_SITES.txt, 208 lines as regenerated).

## Timestamp decision (the #1 migration bug source — needs one ruling)

Three representations are in play and the kit + adapter currently mix
two of them asymmetrically (ISO on the filter side, dumped JSON on the
storage side):

- (a) Raw `{_seconds,_nanoseconds}` (what the kit writes; what the
  adapter returns): breaks guarded `{seconds}` consumer arms silently,
  breaks all range/order/cursor comparisons (G3/G5/G6).
- (b) ISO strings end to end (kit converts on dump; adapter converts on
  write): comparisons and ordering become correct, but unguarded
  `.toDate()`/`.toMillis()` call sites crash — 207 sites to audit.
- (c) Rehydrated Timestamp-compatible objects on read (adapter wraps
  `{_seconds,_nanoseconds}` into an object exposing
  `toDate()/toMillis()/seconds/nanoseconds`): transparent to all 207
  consumer sites; must be paired with (b)-style storage normalization
  for comparisons to work.

Recommendation: (b) for storage + (c) for reads. Either way the decision
belongs in ONE place (kit dump + adapter) before any cluster flips a
surface; per-cluster improvisation guarantees the silent-failure class
the census documents.

## Bottom line for the merge planner

- Adapter core (shapes, counts, errors, writes, scoping): **sound**.
- Flip readiness by surface: dashboard counts **ready** (exact + loud
  errors); picker/directory **blocked on G1 + G2**; announcements
  **blocked on G3 + G4**; tasks list **blocked on G4 + G6** (G5/G7 ride
  along).
- The four blocking fixes are all inside `adapter.ts` (plus the
  timestamp ruling, which may touch the kit). None requires consumer
  rewrites. Re-run this suite after the fix wave; it should go 27/27.
