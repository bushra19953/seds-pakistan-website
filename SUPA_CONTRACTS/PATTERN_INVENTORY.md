# Supabase Adapter — Required Behavior Inventory

Derived 2026-10-25 by `test/supa-adapter-contracts` from the live tree
`feat/integration-wave3 @ 4d5a1e16`, the read-burn census
(`~/workspace/permissions_audit/READ_BURN_CENSUS_2026-10-25.md`), and the
migration kit (`~/workspace/supabase-migration/migrate_db.js`).

## 0. The storage shape the adapter must serve

From `migrate_db.js` (`rowFor`, `tableSql`, `push`):

- One Postgres table per Firestore collection: `fs_<collection>` with the
  collection name sanitized (`[^a-zA-Z0-9_]` → `_`). Columns:
  `id text PRIMARY KEY`, `firebase_uid text`, `parent_path text`,
  `data jsonb`, `migrated_at timestamptz`.
- Row mapping: `id` = Firestore doc id; `firebase_uid` = the uid segment
  when the doc path contains `users/{uid}` (and for top-level `users/{id}`,
  the doc id itself), otherwise `null`; `parent_path` = all path segments
  except the last, joined (`users` for a top-level user doc,
  `users/{uid}/notifications` for a notification); `data` = the full
  Firestore document body.
- **Timestamp storage fact (measured, not assumed):** `doc.data()` returns
  live `Timestamp` instances; the kit dumps with `JSON.stringify`, and
  `@google-cloud/firestore`'s `Timestamp` has **no `toJSON`**, so every
  timestamp field lands in `data` jsonb as a plain object
  `{"_seconds": <int>, "_nanoseconds": <int>}` — NOT as an ISO string.
  Verified locally 2026-10-25:
  `JSON.stringify(Timestamp.fromMillis(1761379200123))` →
  `{"_seconds":1761379200,"_nanoseconds":123000000}`.
  The adapter spec must state, in writing, which of these it returns for a
  timestamp field: (a) the raw `{_seconds,_nanoseconds}` object,
  (b) an ISO string, or (c) a rehydrated Timestamp-compatible object
  (`.toDate()`, `.toMillis()`, `.seconds`, `.nanoseconds`).
  Consumer code tolerates these unevenly (see TIMESTAMP_CENSUS.md):
  several helpers check a `seconds` property **without** the underscore,
  which matches NONE of the dumped shape's keys. Only (c) is transparent
  to all 207 call sites; (b) is transparent to a subset; (a) is
  transparent to none of them.

## 1. Pattern D1 — Admin directory browse (census C3/F6, Path A)

Source: `src/app/api/admin/users/route.ts:155-233` (at 4d5a1e16).

Firestore calls the route makes:

1. `users.where('chapterId','==',X)?.orderBy('__name__').startAfter(uidString).limit(pageSize*3).get()`
   — optional chapter equality; **document-id ordering**; cursor is a
   **doc-id string**, exclusive; window = `pageSize*3`, pageSize clamped 1..50.
2. `roles.where('__name__','in',chunk≤30).select('role','expiresAt').get()`
   — doc-id IN query, chunked at 30; **projection**: `doc.data()` exposes
   only `role` and `expiresAt`.

Result shape the route consumes:

- Snapshot: `{ docs: [{ id, data() }] }`; doc ids in `__name__` order.
- Response rows (exact keys): `{ uid, displayName, email, whatsapp, role,
  roleExpiresAt, chapterId, isBanned }` where `role` = roles-doc value
  falling back to the users-doc mirror, `roleExpiresAt` = ISO string or
  null (converted route-side), strings default to `""`, `isBanned`
  defaults `false`.
- Envelope: `{ users, nextCursor, pageSize, responseTime, searchMethod:
  "native_firestore" }`; `nextCursor` = last **returned** row's uid
  (after in-memory slicing), `""` when the page is empty.

Adapter requirements:

- Equality filter on a top-level field of `data` (`chapterId`), with
  Firestore semantics: docs where the field is **missing never match**
  an equality (in jsonb terms `data->>'chapterId' = $1`, NULL excluded —
  must not coalesce).
- Doc-id ordering = `ORDER BY id`; `startAfter(id)` = `id > $cursor`
  (strictly greater, value-based).
- `__name__ in (...)` = `id = ANY($chunk)`; result order is unspecified
  in Firestore for IN queries (the route builds a map), so any order is
  acceptable, but **every** matching id must be present.
- `.select(...)` projection: returned `data()` must contain ONLY the
  selected keys (consumers read `doc.data()?.expiresAt` etc.; extra keys
  are harmless here, but missing keys are not, and other consumers rely
  on projection to distinguish "field absent" — see dashboard DB2).
- Missing roles doc for a uid is **not an error**: the uid is simply
  absent from the roles map and the route falls back to the users-doc
  mirror.

## 2. Pattern D2 — Admin directory search (Path B) + exact-email probe

Source: `src/app/api/admin/users/route.ts:236-404`.

Firestore calls:

1. `users.select(9 fields).where('chapterId','==',X)?.orderBy('__name__').limit(pageSize*3).get()`
   — same window machinery as D1, WITH projection.
2. Exact-email probe: `users.select(...).where('email','==',term).limit(1).get()`
   — fires only when the query text contains an `@` term and no window
   doc already has that exact (lowercased-compared) email.

Result shape: envelope adds `cached: false` and
`debug: { query, totalScored }`. Pagination here is in-memory over the
scored window (cursor = a user id located by findIndex), so the adapter
only owes the window fetch, not the paging.

Adapter requirements (beyond D1):

- Equality on `email` is case-sensitive at the database layer in
  Firestore; the route lowercases the search term and stored emails are
  compared lowercased in memory for scoring, but the probe's
  `where('email','==',term)` uses the term as typed from the query
  (already lowercased by `normalize(...).toLowerCase()` at route entry).
  The adapter must not add case-insensitive matching of its own.
- `limit(1)`: at most one row, arbitrary which if duplicates exist.

## 3. Pattern D3 — Member picker rows (census F2)

Source: `src/app/api/users/picker/route.ts:63-127`.

Firestore calls:

1. `users.where('chapterId','==',X)?.get()` — **unbounded** full get for
   the filter (bounded only by the route's 5-minute server cache; the
   adapter must not impose its own limit).
2. `roles.where('__name__','in',chunk≤30).get()` — NO projection (full
   roles docs; `additionalRoles` arrays are read).

Result shape: rows `{ uid, displayName, photoURL, chapterId, role,
additionalRoles: string[], isOnVacation }`, sorted by the ROUTE in JS
with `String.prototype.localeCompare` on displayName. Response:
`{ users: rows.slice(0, limit) }`, limit clamped 1..1000, default 100.

Adapter requirements:

- Full-collection reads must return **all** matching rows (no implicit
  page size — PostgREST's default 1000-row cap is a silent-truncation
  hazard here and for every unbounded pattern; see contract T-UNBOUNDED).
- `additionalRoles` must come back as a real array (jsonb array →
  JS array), never a string; absence on the roles doc means the roles
  doc's (empty) value **wins** over the users mirror — i.e. the adapter
  must let the consumer distinguish "roles doc exists without the
  field" from "no roles doc" (per-doc presence, not merged data).
- Ordering of the raw fetch is irrelevant (route sorts), but no row may
  be dropped or duplicated.

## 4. Pattern A1 — Announcements visible fetch (census L2/L4/F7)

Source: `src/lib/announcements.ts:235-262` (`visibleAnnouncementQueries`),
`:310-331` (`fetchVisibleAnnouncements`). **Client Firestore SDK**, not
Admin SDK — the adapter needs a client-side story or these consumers
stay on Firestore in phase 1; either way the semantics below are the
contract for whoever serves them.

Firestore calls, per audience value in the viewer's tier set
(anon 2 values: `public`,`all`; member +`members`; officer +`officers`,
`team_leaders`):

`announcements.where('status','==','published').where('audience','==',value).where('publish_date','<=',Timestamp.fromDate(now)).orderBy('updated_at','desc') [.where('isFeatured','==',true)] [.limit(n)]`

Result shape: merged across splits, **deduped by doc id, first split
wins**; each doc mapped through the converter:
`{ id, title, content, audience, status, isFeatured, priority (?? 0),
ctaText, ctaLink, ctaExpiredText, expiresAt, publish_date (?? null),
updated_at }`.

Adapter requirements:

- **Range filter on a timestamp field**: `publish_date <= now`. Docs
  where `publish_date` is missing or null match NO split (Firestore
  range filters exclude missing/null). In the dumped jsonb the field is
  a `{_seconds,_nanoseconds}` object (see §0): the adapter must compare
  chronologically, not lexicographically and not by object identity.
- **`orderBy('updated_at','desc')` excludes docs missing `updated_at`**
  (Firestore orderBy implies existence). Postgres `ORDER BY
  data->>'updated_at' DESC` includes NULL rows (and sorts them FIRST by
  default on DESC) — the adapter must add the existence filter and the
  Firestore tiebreak: orderBy ties resolve by document id ascending.
- Multiple equality + one range + ordering must compose in one query
  (this is the shape Firestore needed a composite index for; in
  Postgres it is one scan over `fs_announcements`).

## 5. Pattern DB1 — Dashboard scoped counts (census C1/F1)

Source: `src/app/api/admin/dashboard/init/route.ts:84-102, 192-244`.

Firestore calls:

- `scoped(collection).count().get()` → `{ count }`, where `scoped`
  applies the caller's effective chapter filter
  (`applyEffectiveChapterFilter`).
- Filtered counts: `.where('memberStatus','==','departed').count()`,
  and per-status task counts: `.where('status','==',s).count()` for
  s ∈ {completed, pending, in-progress, submitted-for-review, overdue}.

Result shape: response `metrics` is all plain integers
(`users, projects, blogs, events, announcements, applicationsPending,
applicationsShortlisted, applicationsRejected`); `indicators` adds
`usersDeparted`, `medianDaysWaiting` (number|null), `tasksCompleted`,
`tasksOverdueRate`. Per-collection failures are caught per name and
degrade to 0 with an entry in `errors[]` — so the adapter's count must
**throw on failure** (the route catches), never return a fake 0 or a
partial count silently.

Adapter requirements:

- Count semantics = Firestore aggregation: number of docs matching the
  equality filters; docs missing the filtered field do not match;
  counts are exact integers (not estimates — `pg_class.reltuples`-style
  estimates are a contract breach).
- Counts over the chapter scope and over each status value must be
  independent: no shared mutable query state between the parallel calls
  (the route fires ~11 counts in one `Promise.all`).

## 6. Pattern DB2 — Dashboard pending-applications sample

Source: `src/app/api/admin/dashboard/init/route.ts:147-190`.

Firestore call: `applications.where('status','==','pending')` split into
`.count().get()` and `.select('created_at','createdAt').limit(100).get()`.

Result shape: from the capped fetch, ONLY the two timestamp spellings
are read; docs whose timestamps don't parse still count in the count
but are excluded from the median; median is `null` when no fetched doc
has a parseable timestamp.

Adapter requirements:

- Projection must return docs whose `data()` has ONLY `created_at` /
  `createdAt` keys present per doc (a doc may carry either spelling;
  absence of both is representable and required — the median logic
  depends on distinguishing "no timestamp" from "timestamp = epoch").
- The route's `timestampMillis()` tolerates Timestamp / Date /
  `{seconds}` / string / number / `{toDate}` — see TIMESTAMP_CENSUS for
  why the dumped `{_seconds}` shape still falls through every arm.

## 7. Pattern DB3 — Dashboard audit tail

Source: `src/app/api/admin/dashboard/init/route.ts:238-258`.

Firestore call: `audit_logs.orderBy('timestamp','desc').limit(20).get()`
(scoped). Result rows: `{ id, action, targetUidOrResource, timestamp }`
with `timestamp` emitted as an ISO string route-side.

Adapter requirements: orderBy-desc + limit with the §4 existence and
tiebreak semantics; `doc.id` and the three fields pass through
unchanged. The route-side timestamp conversion is a census item
(guarded `.toDate` with a **wrong fallback**: any non-Timestamp value
is stamped with the CURRENT time — under every adapter timestamp
option except rehydration this silently corrupts all 20 rows).

## 8. Pattern T1 — Tasks list, main branch (census C2/F3)

Source: `src/app/api/tasks/route.ts:1887-2042`.

Firestore calls:

- Tier 1: `tasks.where('status','==',lower)? .where('projectId','==',x)?
  .orderBy('createdAt','desc') [.startAfter(Timestamp.fromMillis(cursorMs))]
  .limit(clamp(1..500, default 100)).get()`
- Tier 2 (on tier-1 throw): same equality filters + `limit` only;
  route sorts in memory.
- Tier 3 (on tier-2 throw): `orderBy('createdAt','desc').limit(n)` only.
- Hard invariant (read-burn F3): **no tier may degrade to an unbounded
  read**, and a total failure must propagate as an error (route 500s).

Result shape: `{ ok: true, items, nextCursor, count }`. Items are
`{ id, ...data }` with seven timestamp fields
(`deadline, individualDeadline, createdAt, updatedAt, completedAt,
releasedAt, submittedAt`) serialized route-side to ISO strings (or
null); any OTHER fields pass through raw. `nextCursor` = the last
doc's `createdAt` in epoch millis as a string, or `null`;
`count` = items length.

Adapter requirements:

- Value-cursor pagination: `startAfter(ts)` is exclusive and
  value-based; with duplicate `createdAt` values straddling a page
  boundary Firestore skips all docs equal to the cursor value
  (document-id tiebreak applies within the ordering, but startAfter on
  the orderBy value alone skips equals). The faithful Postgres form is
  `created < $cursor` on the extracted timestamp with `ORDER BY
  created DESC, id ASC` for intra-page order — contract tests pin both
  the equal-value skip and the tiebreak order.
- `orderBy('createdAt','desc')` excludes docs missing `createdAt`.
- Timestamp comparison/extraction must handle the dumped
  `{_seconds,_nanoseconds}` shape chronologically (numeric seconds,
  then nanoseconds), not string comparison — unless the adapter
  normalizes the shape first (§0 decision).
- The response cursor is derived from the last doc's `createdAt`
  millis: the adapter must return `createdAt` in a form from which the
  route can obtain millis (Timestamp-like, Date, ISO string, or
  `{seconds}` — see census; `{_seconds}` alone breaks it → cursor null
  → pagination silently truncates after page 1).

## 9. Pattern T2 — Tasks list, assignee union branch (Bug 3)

Source: `src/app/api/tasks/route.ts:1911-1961`.

Firestore calls (both **unbounded**):
`tasks.where('assigneeId','==',uid).get()` and
`tasks.where('assigneeIds','array-contains',uid).get()`, run in
parallel; results unioned with dedupe by doc id (primary branch wins
ordering), then filtered (status, projectId), sorted, cursor-filtered
(`createdAtMs < cursorMs`, strict), and sliced in memory.

Adapter requirements:

- **`array-contains` on a jsonb array field**: `assigneeIds` is a JSON
  array of strings; membership test = `data->'assigneeIds' @> '["uid"]'`
  (or equivalent). A doc whose `assigneeIds` is missing, null, or not
  an array matches nothing and must not error the query.
- Both branches unbounded: all matches returned (PostgREST row cap
  hazard as in D3).
- Dedupe/ordering is route-side; the adapter owes completeness, not
  order, for these two queries.

## 10. Cross-cutting doc-get semantics (missing docs)

Evidence: `dashboard/init` `userDoc.data() || {}` (:58-59);
picker/directory roles fallback (missing roles doc → users mirror);
tasks GET role check `roleSnap.exists ? ... : ''` (:1869-1871).

Contract: a single-doc get for a missing doc must resolve with
`exists === false` and `data() === undefined`. It must NOT throw, must
NOT return an empty-object doc with `exists === true`, and must NOT
return another doc. A doc that exists with an empty body returns
`exists === true` and `data()` = `{}`.

## 11. Cross-cutting error semantics

- Query failure must reject/throw so route-level degradation ladders
  (T1 tiers, dashboard per-name catches, directory warn-and-continue)
  can run. A silently-empty result on error would defeat the F3
  bounded-ladder design and the census F1 error accounting.
- Partial failure inside the directory roles overlay is tolerated
  route-side (warn + continue) — but only because the route wraps the
  call; the adapter must still throw so the route can decide.
