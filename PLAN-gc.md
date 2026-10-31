# PLAN-gc: Analytics vocabulary and mirrors (spec step 3)

Group: GC. Spec: BUILD_SPEC.md Sections 1 (item 9), 4.2 (analytics
track row and env row), 10 step 3, 11 tests A1 and A2 (context),
12 item 9 (context only, no GC change). Plan source: DESIGN_PLAN.md
Section 2. Audit source: STORE_AUDIT.md Section 8.
Worktree: ~/workspace/vendor_shop/wt-gc. Branch: feat/vs-gc.
Base verified in this worktree: b1ae3281dadbb2c9c70aefbf0f32c7bc26efa994
(git rev-parse HEAD at plan time). All line numbers below are at
that commit.
Skills applied: supabase-postgres-best-practices (no DDL, no new
index, no RLS change in this group; reasoning in Section 3.6) and
local-senior-qa (test isolation, mock-only proof, baseline pins kept
untouched; Section 5).
Hard limits honoured in this plan: pilot scope only; zero production
Firestore reads (every test uses mocks or injected fakes); no flag
flip is coded anywhere (Section 7, escalation E1); no jest, tsc or
build run is part of this plan document.

## 0. Verified current state at b1ae3281 (evidence)

1. Route: src/app/api/analytics/track/route.ts is the single server
   entry for both trackers. Its header (lines 5 to 13) states the
   exact starting position: previous client writes moved server
   side, and "no Supabase write mirror exists for them today:
   Firestore-only parity."
2. Auth: POST verifies the session first (verifyAuthentication);
   unauthenticated returns 401, and userId is derived from the
   token (uid), never from the body. Both arms share this.
3. Dispatch is on body.kind: 'pageVisit' (line 58) and
   'analyticsEvent' (line 86). Any other kind returns 400
   { error: 'Invalid kind' }.
4. pageVisit arm (lines 58 to 84): path must be a non-empty string
   or 400 { error: 'path is required' }. pageId is
   path.replace(/\//g, '_') with 'home' fallback. It bumps TWO
   cumulative counter docs with update plus FieldValue.increment(1)
   and FieldValue.serverTimestamp(), falling back to set with
   merge and visits 1 on not-found: pageVisits/{pageId} carrying
   { path, visits, lastVisit } (line 81) and
   pageVisits/site_total_visits carrying { visits, lastVisit }
   with NO path field (line 82). Counter store, not a visit log.
5. analyticsEvent arm (lines 86 to 119): the type whitelist is
   exactly two values (line 88):
   type = event.type === 'click' ? 'click'
        : event.type === 'page_view' ? 'page_view' : '';
   An empty result returns 400 { error: 'Invalid event type' }
   (line 89). This is the audit Section 8 claim, still true at
   b1ae3281: every other type (add-to-cart, checkout, purchase,
   search, and the four commerce types) is rejected today.
6. Per-event store: analyticsEvents, one doc per event via
   db.collection('analyticsEvents').add(ordered) (line 117). The
   add result (the new doc ref and id) is currently discarded.
   Stored field sets are exact and pinned by the WS10 suite:
   base { type, path: cap(path, 512), userId: uid,
   timestamp: FieldValue.serverTimestamp() };
   page_view adds { referrer: cap 512, ua: cap 128 };
   click adds { targetId: cap 128, label: cap 64, href: cap 512 }.
   Stored key order is rebuilt as type, path, userId, type fields,
   timestamp. Any client-sent userId or timestamp is ignored.
   cap(v, max) returns null for a non-string and truncates strings.
7. PageVisitTracker (src/components/PageVisitTracker.tsx):
   signed-in only (useUser), visible tab only, env
   NEXT_PUBLIC_ENABLE_VISIT_TRACKING defaulting to 'true', one
   write per path per 10 minutes per session (sessionStorage key
   pv_last_<path>), sends { kind: 'pageVisit', path } through
   serverWrite from src/lib/client/server-write.ts, path first
   collapsed by collapseDynamicPath (src/components/page-visit-path.ts).
   Failures are silent outside development.
8. AnalyticsEventTracker (src/components/AnalyticsEventTracker.tsx):
   signed-in only; fires only when BOTH
   NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS === 'true' (default off)
   and the visit-tracking flag above is 'true'; the page_view
   effect also checks visible tab; the click listener does not.
   It sends page_view (referrer, ua capped client side at 128) and
   click (targetId, label capped at 64, href) through the same
   serverWrite call. Scroll depth and session duration are kept
   in memory and never flushed (unchanged from the audit).
9. Admin read path already exists and is NOT rebuilt by GC:
   src/lib/server/admin-analytics-supa.ts serves
   GET /api/admin/analytics (src/app/api/admin/analytics/route.ts)
   and the Supabase branch of src/app/admin/analytics/page.tsx.
   Gate: server SUPA_SURFACES must name 'admin-analytics'
   (adminAnalyticsSupaEnabled(), admin-analytics-supa.ts line 175)
   and the page only calls the route when the client twin
   NEXT_PUBLIC_SUPA_SURFACES names 'admin-analytics' (page.tsx
   lines 46 to 54). When the surface is off the route 404s and the
   page falls back to direct Firestore reads. The seam reads
   listDocs('pageVisits'), getDoc('pageVisits',
   SITE_TOTAL_VISITS_ID) with SITE_TOTAL_VISITS_ID =
   'site_total_visits' (line 107), and
   listDocs('analyticsEvents', orderBy timestamp desc, cap 200),
   and it normalizes ISO string timestamps to millis before any
   derivation (normalizeAnalyticsTimestampMs). It has an adapter
   injection point for tests: setAdminAnalyticsSupaAdapterForTests
   (line 192), and getAdminAnalyticsSupaAdapter() (line 216)
   returns null when the gate is off, before consulting the
   injection. Its AdminAnalyticsAdapter interface (line 35) today
   declares only listDocs, getDoc, countDocs.
10. Mirror pattern in this tree (the pattern GC follows): Firestore
    stays primary; after the primary write lands, a seam helper
    copies the same change into fs_<collection> through the
    adapter in src/lib/supa/adapter.ts
    (setDoc / updateDoc / deleteDoc over collection paths; the
    adapter builds the row { id, firebase_uid, parent_path,
    data jsonb } and the table name via tableForCollection,
    adapter.ts line 462). Seam helpers never throw, return false
    on flag off, client unconfigured, missing adapter or adapter
    error, and callers ignore the result. Evidence:
    src/lib/applications-supa.ts mirrorSetDoc, mirrorUpdateDoc,
    mirrorMergeSetDoc, mirrorDeleteDoc (section headed "Mirror
    writes (NEVER throw, Firestore is primary)"), with
    serializeForSupa converting serverTimestamp sentinels to
    new Date().toISOString();
    src/lib/server/blog-supa.ts mirrorBlogCreate and
    mirrorBlogUpdate (static import of getSupaAdapter, getSupaClient,
    useSupa from '@/lib/supa');
    src/lib/supa-events/server-events.ts mirrorDocWrite and
    mirrorDocUpdate; src/lib/server/settings-mirror.ts
    mirrorSettingsDoc (setDoc with { merge: true }).
    Gates are useSupa(surface) over SUPA_SURFACES plus
    getSupaClient() non-null (src/lib/supa/flags.ts lines 71 to 83,
    src/lib/supa/client.ts). No seam in the tree writes a mirror
    ungated.
11. Landing tables already exist: adapter.ts lines 452 to 453 record
    that pageVisits and analyticsEvents were verified on the real
    project to resolve exactly under the standard rule, so
    tableForCollection('pageVisits') = 'fs_pageVisits' and
    tableForCollection('analyticsEvents') = 'fs_analyticsEvents',
    with no alias (the only alias in TABLE_ALIASES is auditLogs).
    Both collections are already registered for backup
    (src/lib/backup/registry.ts lines 99 to 100). Audit Section 9
    read 216 fs_pageVisits rows and 1,647 fs_analyticsEvents rows
    from these tables: they are migration snapshots that stopped
    updating, which is the gap GC closes for new writes.
12. firestore.rules already permits client create on pageVisits
    and analyticsEvents and read by canViewAnalytics; GC writes go
    through the Admin SDK route and the service-role adapter, so
    GC needs no rules change.

## 1. Files to create or modify (exact)

### 1.1 MODIFY src/app/api/analytics/track/route.ts

The only route change. Changes, in file order:

a. Header comment: delete the sentence "Neither collection is a
   webhook-dispatch collection and no Supabase write mirror exists
   for them today: Firestore-only parity." Replace with a short
   paragraph stating: both arms now mirror post-commit into
   fs_pageVisits and fs_analyticsEvents through the mirror helpers
   in src/lib/server/admin-analytics-supa.ts (surface
   'admin-analytics', never throws, Firestore stays primary), and
   the analyticsEvent arm accepts four commerce types that require
   productId (Section 2 of PLAN-gc).
b. Add one import:
   import { mirrorAnalyticsEvent, mirrorPageVisitIncrement,
     SITE_TOTAL_VISITS_ID } from '@/lib/server/admin-analytics-supa';
   No other import changes. No import of the Supabase client or
   adapter in the route: routes never touch fs_ tables directly.
c. pageVisit arm: keep both Firestore bumps byte-identical,
   including the hardcoded 'site_total_visits' string on line 82.
   Immediately after the second bump succeeds and before the
   response, add exactly:
     await mirrorPageVisitIncrement(pageId, path);
     await mirrorPageVisitIncrement(SITE_TOTAL_VISITS_ID, null);
   No try/catch around these calls: the seam contract is
   never-throw (Section 3.3), the same reliance blog and
   announcements routes place on their mirror helpers. The return
   values are ignored. Response stays NextResponse.json({ ok: true }).
d. analyticsEvent arm: extend the type resolution on line 88 to a
   closed set of six. Replace the ternary with:
     const ANALYTICS_EVENT_TYPES = new Set([
       'page_view', 'click',
       'product_view', 'buy_click', 'checkout_start', 'order_created',
     ]);
     const COMMERCE_EVENT_TYPES = new Set([
       'product_view', 'buy_click', 'checkout_start', 'order_created',
     ]);
   declared at module scope, then
     const type = typeof event.type === 'string' &&
       ANALYTICS_EVENT_TYPES.has(event.type) ? event.type : '';
   The 400 { error: 'Invalid event type' } on an empty type is
   unchanged, so 'purchase', 'add_to_cart', 'search' and every
   other string stay rejected.
e. Commerce validation, immediately after the type check and
   before any document is built or written (full contract in
   Section 2): when COMMERCE_EVENT_TYPES.has(type), validate
   event.productId; on failure return 400
   { error: 'productId is required' } with no Firestore write and
   no mirror call.
f. Document build: keep the existing base and the page_view and
   click branches byte-identical. Add one branch for commerce
   types so the ordered doc is exactly
   { type, path, userId, productId, timestamp } where path is the
   existing cap(event.path, 512), userId is uid, productId is the
   validated value from step e, and timestamp is
   FieldValue.serverTimestamp(). No referrer, ua, targetId, label
   or href key may appear on a commerce doc, and no productId key
   may appear on a page_view or click doc even if the client sent
   one.
g. Capture the write and mirror it: replace line 117 with
     const nowIso = new Date().toISOString();
     const ref = await db.collection('analyticsEvents').add(ordered);
     await mirrorAnalyticsEvent(ref.id, { ...ordered, timestamp: nowIso });
   nowIso is captured in the same handler invocation, before or
   after the add (either is inside the same request); the spread
   replaces the serverTimestamp sentinel with the ISO string so
   no sentinel object ever reaches the adapter (Section 3.4).
   This applies to ALL SIX types, not only commerce: the mirror
   covers every new analyticsEvents write. Response unchanged.

### 1.2 MODIFY src/lib/server/admin-analytics-supa.ts

The mirror writers live in this file, not in a new seam file.
Reasons, all evidenced in Section 0: this file already owns the
'admin-analytics' surface gate for both collections, the adapter
resolution and test injection the mirrors need, the timestamp
normalizer the mirror payload needs, numericVisits for counter
arithmetic, and the SITE_TOTAL_VISITS_ID constant. A second seam
would duplicate the gate and could drift from the read gate.
Changes:

a. AdminAnalyticsAdapter (line 35): add ONE optional member:
     setDoc?(
       collectionPath: string,
       id: string,
       data: Record<string, unknown>,
       options?: { merge?: boolean },
     ): Promise<unknown>;
   Optional on purpose (CHOICE C6): the notifications seam uses
   the same optional-member shape, existing test fakes that
   implement only the read members keep compiling unchanged, and
   the mirror helpers treat a missing setDoc as "no adapter".
b. Add an exported pure helper:
     export function analyticsMirrorTimestampIso(
       value: unknown, now: Date = new Date()): string
   Body: const ms = normalizeAnalyticsTimestampMs(value);
   return ms === null ? now.toISOString() : new Date(ms).toISOString();
   It reuses the file's existing normalizer, so ISO strings,
   Dates, Timestamp-like values and dumped shapes convert, and
   anything unparseable (including a serverTimestamp sentinel
   object, which has no toMillis or toDate) falls back to now.
c. Add the event mirror:
     export async function mirrorAnalyticsEvent(
       id: string, data: Record<string, unknown>): Promise<boolean>
   Exact behaviour:
   - const adapter = getAdminAnalyticsSupaAdapter(); if the
     adapter is null or typeof adapter.setDoc !== 'function',
     return false.
   - Build the payload as a shallow copy of data with every
     undefined-valued key dropped and timestamp replaced by
     analyticsMirrorTimestampIso(data.timestamp).
   - try { await adapter.setDoc('analyticsEvents', id, payload);
     return true; } catch (err) { console.error with prefix
     '[admin-analytics-supa] mirror analyticsEvent failed'; 
     return false; }
   - Never throws. The adapter resolves 'analyticsEvents' to
     fs_analyticsEvents and upserts on conflict id.
d. Add the counter mirror:
     export async function mirrorPageVisitIncrement(
       pageId: string, path: string | null): Promise<boolean>
   Exact behaviour (read-modify-write; why in Section 3.5):
   - Resolve the adapter and setDoc exactly as in c; also require
     adapter.getDoc. Any miss returns false.
   - const existing = await adapter.getDoc('pageVisits', pageId);
     const visits = numericVisits(existing?.visits) + 1;
     (numericVisits is the file's existing coercion at line 224:
     non-finite or missing becomes 0, so a missing row yields 1,
     matching the Firestore set-merge fallback.)
   - Payload: path === null
       ? { visits, lastVisit: new Date().toISOString() }
       : { path, visits, lastVisit: new Date().toISOString() };
     The null-path form is only for SITE_TOTAL_VISITS_ID and must
     carry no path key, mirroring the Firestore total doc.
   - await adapter.setDoc('pageVisits', pageId, payload,
     { merge: true }); return true. Merge preserves any other
     stored keys on the snapshot rows.
   - Whole body after adapter resolution sits in try/catch that
     logs with prefix '[admin-analytics-supa] mirror pageVisit
     failed' and returns false. Never throws.
e. Nothing else in the file changes: getAnalyticsSupa, the view
   model types, the caps, the flag parser and the read derivations
   are untouched. In particular productId is NOT added to
   AnalyticsEventView or to any admin UI derivation (CHOICE C8).

### 1.3 CREATE src/lib/client/commerce-analytics.ts

The client fire helper GD and GE import. Full API contract in
Section 4. It imports useUser from '@/firebase', usePathname
from 'next/navigation', useCallback from 'react', and serverWrite
from '@/lib/client/server-write' (the same call both existing
trackers use). It contains no Firestore import and no direct
fetch: the static WS10 pin (no client Firestore write in tracker
code) stays true for the new helper.

### 1.4 Test files (create only; Section 5 gives every test name)

- CREATE src/app/api/analytics/track/__tests__/route-gc-analytics.test.ts
- CREATE src/lib/server/__tests__/admin-analytics-mirror.test.ts
- CREATE src/lib/client/__tests__/commerce-analytics.test.tsx

### 1.5 Files explicitly NOT changed

- src/components/PageVisitTracker.tsx and
  src/components/AnalyticsEventTracker.tsx: no change. Their
  behaviour, gates and throttles stay exactly as verified.
- src/app/admin/analytics/page.tsx,
  src/app/api/admin/analytics/route.ts: no change (feed the
  existing read path, do not rebuild it).
- src/components/page-visit-path.ts: no change (drift note D4).
- src/app/api/analytics/track/__tests__/route-ws10.test.ts: no
  change. Its mocks do not mock the new seam import; that is safe
  because the real admin-analytics-supa module has no top-level
  imports or side effects, its gate reads SUPA_SURFACES (unset in
  that suite), and both mirror helpers return false before any
  adapter resolution. Its pinned assertions (update and add call
  shapes) are unaffected because mirrors run after those calls.
- src/lib/server/__tests__/admin-analytics-supa.test.ts and its
  fixtures: no change (optional setDoc, CHOICE C6).
- No .env file, no .env.example, no .env.local.template change:
  the detailed-analytics flag appears in none of the templates
  today (grep evidence) and GC bakes no env value anywhere.
- No SQL file, no DDL, no firestore.rules change, no change under
  src/lib/supa/ (adapter, flags, client all untouched).
- No order, checkout or product file: order_created is fired by
  GE's client code through the helper (Section 4.4, CHOICE C7).

## 2. Event payload contract

### 2.1 Wire shape (client to POST /api/analytics/track)

Unchanged envelope for all analyticsEvents traffic:

  { "kind": "analyticsEvent",
    "event": {
      "type": "product_view",
      "path": "/store/<productId>",
      "productId": "<product document id>"
    } }

Rules that already exist and stay in force for the four types:
- kind must be exactly 'analyticsEvent'. The four types do NOT
  get a new kind, a new route, or a pageVisits path.
- Authentication is required (401 when unauthenticated) and the
  stored userId is always the token uid. A client-sent userId is
  ignored (spoof-proof, pinned by the WS10 suite).
- No client timestamp is accepted. A client-sent timestamp is
  ignored; the server stamps FieldValue.serverTimestamp() in
  Firestore and the mirror carries the same request's ISO instant.

### 2.2 Per-type stored document (Firestore analyticsEvents)

| type | stored keys, in order | notes |
|---|---|---|
| page_view | type, path, userId, referrer, ua, timestamp | unchanged |
| click | type, path, userId, targetId, label, href, timestamp | unchanged |
| product_view | type, path, userId, productId, timestamp | new |
| buy_click | type, path, userId, productId, timestamp | new |
| checkout_start | type, path, userId, productId, timestamp | new |
| order_created | type, path, userId, productId, timestamp | new |

Field rules for the four commerce types:
- productId: required, see Section 2.3. Stored verbatim (after
  the trim in 2.3), as a string.
- path: same handling as the existing types, cap(path, 512);
  a missing or non-string path stores null. Path is NOT made
  required for commerce types (DESIGN_PLAN Section 2 step 1
  records product id, path and timestamp through the existing
  pipe; tightening path would diverge from the existing arm).
- timestamp: serverTimestamp, as above.
- userId: token uid, as above.
- Nothing else is stored. In particular there is no orderId, no
  price, no quantity, no referrer or ua on a commerce doc
  (CHOICE C2). Extra keys sent by a client are dropped by the
  whitelist build, exactly as extra keys are dropped today.

### 2.3 productId validation and rejection behaviour (exact)

Validation runs for the four commerce types only, after the type
check, before any write:
- Accept: typeof event.productId === 'string', its trimmed length
  is at least 1 and at most 128. The stored value is the trimmed
  string (product document ids carry no whitespace).
- Reject with 400 and body { error: 'productId is required' }:
  missing key, null, any non-string (number, boolean, object,
  array), empty string, whitespace-only string, or a string whose
  trimmed length exceeds 128. One error string for every invalid
  case, matching the route's existing single-string style
  ('path is required', 'Invalid event type').
- A rejection is atomic: no analyticsEvents add, no mirror call,
  no pageVisits effect. The response is the only effect.
- page_view and click never require productId, and a productId
  sent with them is dropped, never stored.

### 2.4 Response summary (whole route, after GC)

- 200 { ok: true }: write landed in Firestore. A mirror that
  returned false does not change this response.
- 400 { error: 'Invalid JSON' }: unparseable body (existing).
- 400 { error: 'Invalid kind' }: kind is neither arm (existing).
- 400 { error: 'path is required' }: pageVisit without a path
  (existing).
- 400 { error: 'Invalid event type' }: type outside the closed
  six-value set (existing string, wider set).
- 400 { error: 'productId is required' }: Section 2.3 (new).
- 401 { error: 'Unauthorized' }, 500
  { error: 'Server misconfiguration' }: existing, unchanged.

## 3. Mirror mechanics, with file evidence

### 3.1 What mirrors, where to

- Every successful analyticsEvents add (all six types) mirrors to
  fs_analyticsEvents under the SAME document id Firestore minted
  (ref.id from the add). Per-event docs, one row per event.
- Every successful pageVisit bump mirrors BOTH counter docs to
  fs_pageVisits under their existing ids: the per-path pageId and
  'site_total_visits'. Counter docs, one row per path.
- Historical rows are not backfilled by GC. The tables keep their
  snapshot rows; new writes land from GC go-live onward. No census
  read, no migration script is in this group.

### 3.2 Transport

All mirror writes go through getSupaAdapter() from
src/lib/supa/adapter.ts, reached only inside
admin-analytics-supa.ts. The adapter upserts the row
{ id, firebase_uid: null, parent_path: <collection name>,
data: <payload> } into fs_<collection> (onConflict 'id' for
top-level collections). firebase_uid is null because the
adapter's firebaseUidForPath only derives a uid for paths under
a users segment; parent_path is 'pageVisits' or
'analyticsEvents'. GC code never names an fs_ table, never calls
.from() and never builds a row by hand. The adapter normalizes
Date and Timestamp-like values to ISO strings on write
(normalizeForStorage); GC additionally guarantees no FieldValue
sentinel reaches it (Section 3.4).

### 3.3 Gate (no new flag, no flip coded)

Both helpers resolve their adapter through the file's existing
getAdminAnalyticsSupaAdapter(), so a mirror write happens only
when ALL of these hold:
- SUPA_SURFACES names 'admin-analytics' (or '*'),
  case-insensitive, per adminAnalyticsSupaEnabled();
- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured
  (getSupaClient() non-null inside resolveRealAdapter);
- the adapter resolves.
Otherwise the helper returns false and the route behaves exactly
as today. GC adds no new surface token (the read seam already
owns both collections under 'admin-analytics'), no PrimaryFirst
helper, and no code reads SUPA_PRIMARY: isSupaPrimary is never
imported or called by GC code. Activating the existing token at
deploy time is a coordinator action, escalated as E1 in
Section 7. Rollback semantics stay the platform's: removing the
'admin-analytics' token returns reads and mirrors together to
Firestore-only, which is the flags.ts contract.

### 3.4 Timestamp handling

- Firestore event doc: FieldValue.serverTimestamp() (unchanged).
- Mirror event payload: the same request's new Date().toISOString(),
  substituted by the route (Section 1.1 step g), and passed
  through analyticsMirrorTimestampIso as a belt-and-braces
  conversion. Sub-second skew between the two stores is the
  accepted seam convention (applications-supa serializeForSupa
  documents the same skew; Firestore stays primary).
- Mirror counter payload: lastVisit is new Date().toISOString()
  computed inside mirrorPageVisitIncrement.
- Read compatibility is already proven in tree: the admin seam
  normalizes ISO timestamps before deriving the 7-day trend and
  recent events (its ISO hazard test), and it passes pageVisits
  lastVisit through uninterpreted, so ISO strings are safe in
  both tables.

### 3.5 Why the counter mirror is read-modify-write

Firestore bumps counters with FieldValue.increment(1), an atomic
server-side operation with no adapter equivalent: the adapter
exposes only getDoc, listDocs, countDocs, setDoc, updateDoc,
deleteDoc, rpc and tx, and no tx SQL function exists for
analytics (src/lib/supa/sql holds none). The established mirror
answer to a partial or computed update is read-modify-write:
applications-supa applyUpdateToAdapter does getDoc then setDoc,
and adapter updateDoc itself is documented as read-modify-write.
mirrorPageVisitIncrement follows it against the SUPABASE copy
(getDoc on fs_pageVisits, never a Firestore read), so mirroring
spends zero Firestore quota. Known limit, recorded as CHOICE C4:
two perfectly concurrent tracks can read the same mirror count
and both write count + 1, undercounting the mirror by one; the
Firestore counter stays exact and primary, and pilot volume
(signed-in members, 10-minute per-path tracker throttle) makes
collisions rare. A tx_analytics SQL function would remove the
race and is explicitly out of GC scope and out of the existing
mirror pattern.

### 3.6 Supabase and Postgres notes (supabase-postgres-best-practices)

- No schema change: fs_pageVisits and fs_analyticsEvents already
  exist with the adapter's row shape (id text primary key,
  firebase_uid, parent_path, data jsonb). Creating or altering
  tables for a mirror that fits the landing pattern would be
  scope creep.
- No new index: mirror writes are primary-key upserts; the read
  seam already works over these tables. A jsonb expression index
  on (data->>'productId') for the Friday per-product ratio is a
  possible later optimisation only if E4 queries measurably slow
  down; at pilot volume (at most 10 products, 30 days, member-only
  traffic) it is not warranted and GC does not add it.
- No RLS change: the only writer and reader is the server-side
  service-role adapter, which bypasses RLS by design
  (src/lib/supa/client.ts warning). No anon or browser Supabase
  client touches these tables in GC; the client helper talks to
  the app's own route only.
- Connection behaviour is unchanged: writes reuse the memoized
  service client from getSupaClient(); GC opens no new client.

## 4. Fire helper API contract for GD and GE

### 4.1 File and exports (exact)

File: src/lib/client/commerce-analytics.ts ('use client' module).

Exports:
- export type CommerceEventType =
    'product_view' | 'buy_click' | 'checkout_start' | 'order_created';
- export const COMMERCE_EVENT_TYPES: readonly CommerceEventType[]
  holding exactly those four strings, in that order.
- export function commerceAnalyticsEnabled(): boolean
  Pure gate, exported for tests; GD and GE do not call it.
  Returns true only when, in a browser environment:
  process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS === 'true'
  AND (process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING ?? 'true')
  === 'true'. These are the AnalyticsEventTracker conditions at
  its lines 19 to 22, copied verbatim in effect.
- export function useCommerceAnalytics():
    { trackCommerceEvent: TrackCommerceEvent }
  where type TrackCommerceEvent = (
    type: CommerceEventType,
    productId: string,
    path?: string,
  ) => Promise<void>;

### 4.2 Behaviour of trackCommerceEvent (exact)

Implemented with useCallback, dependencies [user, pathname],
where user comes from useUser() (@/firebase) and pathname from
usePathname() (next/navigation). On each call, in order:
1. If there is no signed-in user, return (resolve) without any
   network call. Signed-in only, as both trackers enforce.
2. If commerceAnalyticsEnabled() is false, return without any
   network call. Detailed-analytics gating exactly as it exists
   today; with the flag off the helper is a complete no-op.
3. If productId is not a string or trims to empty, return without
   any network call. (Client guard only; the route's 400 in
   Section 2.3 remains the authoritative check.)
4. Otherwise await serverWrite('/api/analytics/track', 'POST',
   { kind: 'analyticsEvent', event:
     { type, path: path ?? pathname ?? null,
       productId: productId.trim() } })
   inside a try/catch that swallows every error. The promise
   returned to callers ALWAYS resolves; the helper never throws,
   never rejects, and never surfaces a toast or console error
   outside development debug logging, matching the trackers'
   silent-failure rule.
Deliberately NOT applied (CHOICE C3): the PageVisitTracker
10-minute per-path throttle (it would collapse repeat buy clicks
and repeat product views into one, destroying the ratio A1 and
E4 exist to measure) and the visible-tab check (commerce events
are explicit gestures or completion signals, not ambient page
renders; order_created in particular can resolve while the tab
is not visible and must not be dropped for that reason).
No de-duplication is provided: firing once per logical event is
the caller's job (effect dependency on productId, a ref guard,
or a success callback), the same division AnalyticsEventTracker
uses for page_view.

### 4.3 What the helper never sends

No userId (server derives it), no timestamp (server stamps it),
no referrer, ua, targetId, label or href, no price or order data.
The body is exactly the Section 2.1 envelope.

### 4.4 Fire points GD and GE wire (GC defines, GD and GE build)

| event | owner | fire point | productId source | call style |
|---|---|---|---|---|
| product_view | GD | /store/[productId] product page, in an effect keyed on the product id, once per product shown | the route product id | void trackCommerceEvent('product_view', productId) |
| product_view | GD | alternatives rail click: the clicked product, per spec Section 4.3 last bullet | the clicked product's id | void, in the click handler before or alongside navigation |
| buy_click | GD | every Buy button (catalogue card, product page, any other surface GD adds one to) | the button's product id | void, in the click handler; navigation must not wait on it |
| checkout_start | GE | /checkout when a SHOP checkout renders, once per mount per product (ref guard is GE's) | the checkout productId (page.tsx already resolves searchParams productId) | void, in the render effect |
| order_created | GE | on successful order creation only (the createOrder action or POST /api/store/orders success path on the client), never on validation failure, rejection or cancel | the ordered product's id | void, after success is known; checkout flow must not block on it |

House checkouts (donations, tickets, fees with no shop product)
fire none of the four: checkout_start and order_created are shop
events in spec Section 4.2, and a missing productId would be
rejected by the route in any case. GD and GE import the hook
from '@/lib/client/commerce-analytics' and hold it at component
top level like every other hook; they do not import the route,
the seam, or serverWrite for these events.

## 5. Tests mapped to A1 (local-senior-qa method)

Method: three new suites, each fully isolated. Firestore is
mocked at the firebase-admin boundary, auth is mocked, the
mirror seam is mocked at the module boundary in the route suite
and driven through its real test injection point in the seam
suite, and serverWrite is mocked in the helper suite. No suite
imports the real Supabase client, opens a network call, or reads
Firestore: the A1 requirement that mirror proof spends no
Firestore reads is met by construction, and the running Firestore
read total for GC tests is 0. The coordinator or test author runs
the suites; this verifier ran none.
A1 mapping key: [vocab] the four types are accepted and stored
with the right productId; [mirror] the rows land in the
fs_analyticsEvents mirror; [counter] pageVisits mirroring that
feeds the same read path; [gate] the client helper's rules.

### 5.1 CREATE src/app/api/analytics/track/__tests__/route-gc-analytics.test.ts

Environment: @jest-environment node, following route-ws10.test.ts.
Mocks: @/lib/server/firebase-admin (fake db: pageVisits doc
update/set capture, analyticsEvents add capture returning
{ id: 'e1' }), firebase-admin/firestore FieldValue sentinels as
the strings '__ST__' and '__INC_1__', @/lib/auth-middleware with
a switchable authenticated state, and
@/lib/server/admin-analytics-supa as a jest.mock factory
exporting mirrorAnalyticsEvent (jest.fn resolving true),
mirrorPageVisitIncrement (jest.fn resolving true) and
SITE_TOTAL_VISITS_ID: 'site_total_visits'.

describe 'GC POST /api/analytics/track commerce vocabulary':
- it.each over the four types:
  'accepts %s and stores a per-event doc with productId, token
  userId, capped path and server timestamp' [vocab]
  Asserts: status 200; one add to 'analyticsEvents'; stored keys
  exactly ['type','path','userId','productId','timestamp'];
  userId is the token uid 'user-1'; timestamp is '__ST__'.
- it.each over the four types:
  'mirrors %s to fs_analyticsEvents under the Firestore doc id'
  [mirror]
  Asserts mirrorAnalyticsEvent called exactly once with 'e1' and
  a payload whose keys match the stored doc except timestamp,
  which is an ISO string (matches /^\d{4}-\d{2}-\d{2}T/), never
  the '__ST__' sentinel.
- it.each over the four types and over the invalid productId set
  (missing, null, 42, '', whitespace only, 129 characters):
  'rejects %s with invalid productId (%s) with 400 and writes
  nothing' [vocab]
  Asserts: status 400; body { error: 'productId is required' };
  zero adds; mirrorAnalyticsEvent not called.
- 'still rejects purchase, add_to_cart and search event types
  with 400 Invalid event type' [vocab]
- 'page_view and click do not require productId and never store
  a sent productId' [vocab, regression against Section 2.3]
  Asserts stored key sets equal the WS10 pinned sets.
- 'commerce events ignore a spoofed userId and a client
  timestamp in the payload' [vocab]
- 'mirrors page_view and click events as well as commerce
  events' [mirror]
- 'returns 200 when the mirror reports false' [mirror]
  (mock both mirror helpers to resolve false; both arms still
  return { ok: true }.)
- 'returns 401 and writes nothing when unauthenticated'
  [existing auth posture, rechecked for the new types]

describe 'GC POST /api/analytics/track pageVisit mirror':
- 'mirrors both counter docs after the Firestore bump, page doc
  first with its path, total doc with a null path' [counter]
  Posts { kind: 'pageVisit', path: '/store' }; asserts the WS10
  update shapes are unchanged, then mirrorPageVisitIncrement
  calls exactly [['_store', '/store'],
  ['site_total_visits', null]] in order.
- 'does not mirror when the pageVisit write is rejected'
  (missing path returns 400; mirror not called.) [counter]

### 5.2 CREATE src/lib/server/__tests__/admin-analytics-mirror.test.ts

Environment: @jest-environment node. Drives the REAL seam
functions from @/lib/server/admin-analytics-supa with a fake
adapter injected through the existing
setAdminAnalyticsSupaAdapterForTests, reset after each test.
The fake adapter implements getDoc and setDoc over an in-memory
map (setDoc honours { merge: true } by shallow-merging) plus the
read members as stubs, and records every setDoc call. Env:
SUPA_SURFACES is set to 'admin-analytics' in the on-cases and
deleted in the off-cases, saved and restored around the suite
(the flags and chapter-applications suites' pattern).

describe 'admin-analytics mirror writers':
- 'mirrorAnalyticsEvent writes one fs_analyticsEvents row via
  setDoc(analyticsEvents, id, payload) when the surface is on'
  [mirror] Asserts collection argument, id passthrough, payload
  equality including productId for a commerce payload.
- 'mirrorAnalyticsEvent returns false and writes nothing when
  admin-analytics is not in SUPA_SURFACES' [mirror]
- 'mirrorAnalyticsEvent returns false and writes nothing when
  the injected adapter is null' [mirror]
- 'mirrorAnalyticsEvent returns false and writes nothing when
  the adapter has no setDoc' [mirror, CHOICE C6 guard]
- 'mirrorAnalyticsEvent never throws when setDoc rejects; it
  returns false' [mirror]
- 'analyticsMirrorTimestampIso converts an ISO string, a Date
  and a Timestamp-like value to the same ISO instant, and falls
  back to now for a serverTimestamp-shaped sentinel' [mirror]
- 'mirrorPageVisitIncrement creates a missing counter at visits
  1 with path and an ISO lastVisit' [counter]
- 'mirrorPageVisitIncrement increments an existing counter from
  41 to 42' [counter]
- 'mirrorPageVisitIncrement writes the total doc with no path
  key' [counter] (pageId 'site_total_visits', path null;
  asserts the payload has no 'path' property.)
- 'mirrorPageVisitIncrement merges and preserves unrelated
  stored keys on the snapshot row' [counter]
- 'mirrorPageVisitIncrement returns false and writes nothing
  when the surface is off' [counter]

### 5.3 CREATE src/lib/client/__tests__/commerce-analytics.test.tsx

Environment: default jsdom from jest.config.js. renderHook from
@testing-library/react. Mocks: @/firebase useUser (switchable),
next/navigation usePathname returning '/store/p1', and
@/lib/client/server-write serverWrite (jest.fn). Env flags are
set per test and restored after each.

describe 'useCommerceAnalytics (GC fire helper)':
- it.each over the four types:
  'fires %s with productId and the current path through
  serverWrite when signed in and detailed analytics is on'
  [gate] Asserts the exact body of Section 4.2 step 4.
- 'sends no userId and no timestamp; the server derives both'
  [gate]
- 'uses the explicit path argument over usePathname when one is
  given' [gate]
- 'is a silent no-op when signed out' [gate]
  (serverWrite not called; the returned promise resolves.)
- 'is a silent no-op when NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS
  is not true' [gate] (unset and 'false' cases.)
- 'is a silent no-op when NEXT_PUBLIC_ENABLE_VISIT_TRACKING is
  false' [gate]
- 'is a silent no-op for an empty or whitespace productId'
  [gate]
- 'resolves and never rejects when serverWrite rejects' [gate]

### 5.4 How these suites prove A1, and what they do not prove

A1's live proof (coordinator, on the deployed pilot) is: view a
product page, click Buy, reach checkout, create an order, then
confirm analyticsEvents holds the four events with the right
productId and that the rows appear in fs_analyticsEvents without
a Firestore read by the checker. The suites above prove every
code-level clause of that sentence with fixtures: acceptance and
field shape [vocab], the mirror call with the right id and
payload [mirror], the counter feed [counter], and the client
firing rules [gate]. They do not prove the live deploy has the
flags set; that is E1 in Section 7 and is checked at deploy time,
not in jest. A2 context: A2 (notFoundText on the order, visible
in admin order detail) is GE and GG scope. GC neither stores nor
blocks it; order_created carries no notFoundText and no orderId
(CHOICE C2), so no GC test asserts anything about A2.

## 6. Drift versus the audit at b1ae3281

- D1. Audit Section 8 says the route rejects every type except
  page_view and click, pageVisits are cumulative counters, and
  analyticsEvents are per-event docs. All three verified TRUE at
  b1ae3281 (route lines 88, 58 to 82, 117). No drift; GC extends
  exactly at the line 88 whitelist and nowhere else.
- D2. Audit Section 8 says neither collection has a Supabase
  write mirror and the fs_ copies are frozen snapshots. Verified
  TRUE at b1ae3281 (route header lines 5 to 13; zero code
  references to fs_pageVisits or fs_analyticsEvents in src).
  This is gap 13; GC closes it for new writes only.
- D3. The audit was read at tree 85c75ccc and describes the
  trackers in collection terms ("records into Firestore
  analyticsEvents"). At b1ae3281 both trackers already post to
  the server route through serverWrite (the WS10 conversion) and
  userId is token-derived server side. The audit's behavioural
  claims (signed-in only, detailed flag default off, 10-minute
  pageVisit throttle, visible tab) all still hold verbatim.
- D4. New since the audit: PageVisitTracker collapses dynamic
  paths through collapseDynamicPath, so pageVisits holds one doc
  per route pattern for listed dynamic routes. '/store' and
  '/store/<id>' are NOT in DYNAMIC_PARENTS, so each product page
  still mints its own counter doc. GC does not change this (the
  per-product demand signal lives in analyticsEvents by design);
  recorded here so nobody reads a per-product pageVisits doc as
  a GC defect.
- D5. Audit Section 8 says the admin dashboard derives its
  aggregates from the latest 200 events. At b1ae3281 that is true
  only on the Supabase seam (cap 200); the page's Firestore
  fallback path caps at 40 events (page.tsx read-bleed comment).
  Commerce events therefore appear in the seam's recent-events
  window at up to 200, and GC does not touch either cap.
- D6. Audit Section 8 engagement claim still holds: scroll depth
  and session duration are computed and never flushed, and the
  track route still cannot accept time_on_page or scroll_depth
  types after GC (they are outside the spec's four). The
  engagement card stays at 0 in practice; fixing it is not spec
  step 3 and GC does not widen the vocabulary for it.
- D7. The detailed-analytics flag is absent from .env.example
  and .env.local.template at b1ae3281 (grep: the only references
  are AnalyticsEventTracker.tsx and src/firebase/index.ts, where
  the same flag also enables Firebase Analytics initialisation
  in production). Turning it on is therefore purely a deploy
  environment action (Section 7), and its Firebase Analytics
  side effect already exists in code today; GC introduces
  neither the flag nor the side effect.

## 7. Choices and escalation

Choices (the implementer follows the stated default; a
coordinator ruling before implementation overrides it):

- C1. productId validation is strict: non-string, empty,
  whitespace-only or over 128 trimmed characters all reject with
  the single 400 { error: 'productId is required' }, and the
  trimmed value is stored. The looser alternative (truncate at
  512 like path, via cap) was rejected for a required identifier:
  a silently truncated productId would corrupt the per-product
  ratio that A1 and E4 exist to produce. The 128 bound matches
  the route's existing identifier cap for targetId.
- C2. order_created stores no orderId. Spec Section 4.2 and
  DESIGN_PLAN Section 2 step 1 fix the payload at productId,
  path and timestamp ("Nothing else"), so GC keeps the whitelist
  closed. Consequence, stated plainly: pilot reporting joins
  orders to events by product and time, not by order id. If the
  coordinator wants exact order correlation, the spec must be
  amended before GE wires its fire point; the helper signature
  can then grow an optional field without breaking GD.
- C3. The helper applies neither the 10-minute throttle nor the
  visible-tab check. Rationale in Section 4.2. It applies the
  two rules the task names: signed-in only and detailed-analytics
  gating, plus the global visit-tracking flag that
  AnalyticsEventTracker itself also requires.
- C4. The pageVisits mirror is read-modify-write against the
  Supabase copy (Section 3.5), accepting a rare concurrent
  undercount in the mirror only. The alternative (a new
  tx_analytics Postgres function for atomic increments) is a
  larger, pattern-breaking change and is not in spec step 3.
- C5. Mirrors reuse the existing 'admin-analytics' surface token
  for both collections instead of inventing an 'analytics'
  token: the read seam that consumes these tables already gates
  both collections on that one token, and a second token would
  let writes and reads be switched independently, which no seam
  in the tree allows.
- C6. setDoc is an OPTIONAL member of AdminAnalyticsAdapter,
  guarded at runtime. This keeps every existing fake and the
  read suite compiling unchanged, and mirrors the optional-member
  precedent in the notifications seam.
- C7. order_created is fired from GE's client code through the
  helper after a successful creation, per this group's tasking
  (a client fire helper for GD and GE). It is NOT fired inside
  createOrder or POST /api/store/orders. Accepted limit: if the
  client disconnects between the order landing and the fire, the
  event is lost; the order itself is never affected. A
  server-side fire would be more reliable and is a coordinator
  decision to move into GE's plan, not a GC change.
- C8. productId is stored in fs_analyticsEvents data but is NOT
  surfaced in the admin analytics view model or UI. The tasking
  is explicit: feed the existing read path, do not rebuild it.
  E4's Friday ratio is read from the fs_analyticsEvents rows
  directly (Supabase query on data), which needs no UI change.

Escalation (needs a coordinator decision; GC code does not
decide it):

- E1. Flag activation is required for the mirrors and the
  Supabase read path to run at all, and GC ships no flag change.
  Precisely: at deploy time the coordinator must ensure
  SUPA_SURFACES includes 'admin-analytics' (server env) AND
  NEXT_PUBLIC_SUPA_SURFACES includes 'admin-analytics' (client
  twin, build-time inlined, so it needs a rebuild to take
  effect), with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
  already configured. If these are not set, GC behaves exactly
  as the site does today (Firestore-only analytics, route 404 on
  the Supabase read path, page on its Firestore fallback) and
  the Supabase half of A1 and all of E4 cannot pass. This is the
  one place the mirror pattern needs a flag decision; per the
  group ruling it is escalated, not coded. SUPA_PRIMARY is not
  part of this: it must NOT gain 'admin-analytics' for GC, and
  no GC code consults it.

## 8. Deploy-time env actions for the coordinator (no code)

1. NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS=true for the pilot
   window only (spec Section 4.2 env row). Because it is a
   NEXT_PUBLIC_ variable it is inlined at build time: set it in
   the deploy environment BEFORE the pilot build, and unset it
   (or set false) and rebuild when the pilot window closes.
   Every pilot report must be read as member demand, never
   market demand: trackers and the helper see signed-in users
   only (spec and plan both carry this limit).
2. E1's two surface tokens for the admin-analytics read path and
   mirrors (same build, for the client twin).
3. Leave NEXT_PUBLIC_ENABLE_VISIT_TRACKING unset (it defaults to
   'true' in both trackers and the helper). Setting it to 'false'
   would silence all analytics, including the four events.
4. No SUPA_PRIMARY change, no new env variable, no secret change.

## 9. Launch order note and non-goals

Spec Section 10 step 3 carries the STOP AND CHECK: no listing
until this step is live (counters before listings). GC ships
independently of the catalogue and listings work in GA, GB and
GD: nothing in Sections 1 to 5 imports a product, store or
vendor module, and the helper's fire points are consumed by GD
and GE when their pages land. GC non-goals, restated so they are
not re-litigated at review: no backfill of the frozen snapshot
rows, no admin UI change, no new event types beyond the four, no
anonymous tracking (the signed-in limit is a platform rule, not
a GC bug), no engagement (scroll or time) events, and no change
to A2's surface (order notFoundText belongs to GE and GG).
