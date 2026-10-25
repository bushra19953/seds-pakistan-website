# Announcements behavior contracts + Supabase migration verdicts

Branch: `test/supa-announcements-contracts` (base feat/integration-wave3 @ 4d5a1e16).
Contract suite: `src/lib/__tests__/announcements-contracts.test.ts` (32 tests).
Verdict suite (preserved, not committed here because it imports the seam
module that only exists on the migration branch):
`~/workspace/supabase-migration/announcements-verdict/announcements-supa-verdict.test.ts`
(24 tests) + the snapshotted sibling state it ran against
(`sibling-tracked-changes.patch`, `announcements-supa.snapshot.ts`).

Zero live Firestore reads were used anywhere in this work.

## Contract inventory (recorded from the current Firestore implementation)

- C-AUD-01 Fetch tier sets: anon = public+'all'; signed-in += members;
  officer += officers+'team_leaders'. No restricted doc in a lesser
  tier's set, no duplicate ids (first split wins).
- C-AUD-02 Drafts never appear in any fetch (query layer).
- C-AUD-03 Future publish_date excluded at the query layer;
  publish_date == now is due; past-due equality holds.
- C-AUD-04 A document with no updated_at matches no split query
  (Firestore orderBy excludes it) and never reaches consumers.
- C-AUD-05 The fetch does NOT filter expiry; consumers remove expired
  docs via isAnnouncementVisibleTo.
- C-ORD-01 Merged order is split-grouped, NOT globally sorted; the
  /notifications page renders it verbatim.
- C-ORD-02 limitCount caps per split, so a fetch can return up to
  limit x tier-count docs; isFeatured filters inside each split.
- C-SHP-01 Every consumer receives exactly id + the converter's 12
  fields; stored-only fields (slug, meta_*, created_at, created_by,
  showInTicker) never surface.
- C-SHP-02 Stored defaults: priority absent -> 0; publish_date absent
  -> null (field present).
- C-SHP-03 The document id wins over any stored 'id' field.
- C-TS-01 On the Firestore path, timestamp fields pass through
  untouched (Timestamp instances, stored instants unchanged).
- C-TS-02 Migration clause: ISO-string and epoch forms of the same
  instant give identical due/visible decisions and identical consumer
  sort keys as the Timestamp form.
- C-TS-03 POISON SHAPE (hazard on record): a raw JSON-serialized
  timestamp ({ _seconds, _nanoseconds } / { seconds, nanoseconds }) is
  read as null by current normalization — a future publish_date
  becomes due immediately, a past expiresAt never expires, and the
  /announcements sort comparator yields NaN. The adapter MUST
  normalize this shape on read.
- C-MEMO-01 One underlying fetch per (tier, options) per 5 min TTL.
- C-MEMO-02 Options are separate memo entries; no cross-shape leakage.
- C-MEMO-03 A rejected fetch evicts itself; the next caller retries.
- C-MEMO-04 TTL expiry or invalidateVisibleAnnouncementsCache()
  forces a refetch.
- C-QRY-01 Split emission, per viewer: bell { limit 10 } memoized;
  /announcements and /notifications { limit 50 }; carousel + featured
  banner { isFeatured, limit 8 }.
- C-WRT-01 Converter write shape: exactly 12 fields, defaults
  isFeatured false / priority 0 / null dates; audience stored verbatim
  (normalization is the writer's job).
- C-WRT-02 Converter read projection defaults (priority 0,
  publish_date null).
- C-WRT-03 Admin writer: audience normalized at write; publish_date =
  Timestamp.fromDate(picked) or Timestamp.now(), never null;
  updated_at = serverTimestamp() on create AND edit; created_at /
  created_by only on create; status toggle flips published<->draft;
  delete is a hard deleteDoc; expiresAt picked -> Timestamp else null.
- C-WRT-04 A writer-stored doc is visible to its own tier immediately
  and invisible below it.

## Current-tree results (base 4d5a1e16, Firestore implementation)

- announcements-contracts.test.ts: 32/32 PASS.
- Existing suites re-run alongside: announcements-visibility.test.ts
  PASS (44/44 combined). announcements-rules.test.ts untouched (its 4
  failures are the pinned baseline).

## Migration verdicts — feat/supa-announcements DRAFT snapshot

Snapshot identity (uncommitted working tree of wt-supa-announcements,
2026-10-25 ~06:17 UTC): tracked-diff sha256
409191c6b8657c6d40805bf8aaebe39a28c4cfeec495fcba1363fb7f87ef04b7;
src/lib/announcements-supa.ts sha256
00df28dc4419cd2530917eecccc42eb218743ee3b9bef60ff956bb6cc624e81c.
The branch had ZERO commits at snapshot time. The API routes
(/api/announcements/visible, /api/admin/announcements/supa) do not
exist yet; route-level verdicts used the sibling's own
selectVisibleAnnouncements as the route proxy and must be re-run when
the branch actually lands.

Flag OFF: PASS across the board. The sibling refactor
(fetchVisibleAnnouncementsSet -> extracted Firestore path) is
behaviorally byte-identical: all 32 contracts pass unmodified against
the migrated announcements.ts with the flag unset.

Flag ON (seam, both jsonb representations: Admin-dump
{_seconds,_nanoseconds} and mirror-write ISO strings):

| Contract | Verdict | Evidence |
|---|---|---|
| C-AUD-01 tier sets / leakage | PASS | set equality per tier, both reps + via mocked route |
| C-AUD-02 drafts excluded | PASS | selection filters status |
| C-AUD-03 scheduled excluded, == now due | PASS | publishMs <= now, null excluded |
| C-AUD-04 no-updated_at excluded | **FAIL — ordering/visibility drift** | selectVisibleAnnouncements INCLUDES the doc, sorted last in its split (-Infinity); merged anon sequence gains +"no-updated" before 'legacy-all'. Firestore's orderBy excludes it entirely. A doc written without updated_at becomes visible on the Supa path only. |
| C-AUD-05 expiry left to predicate | PASS | expired doc selected; isAnnouncementVisibleTo removes it |
| C-ORD-01 merged split-grouped order | **FAIL** (only via C-AUD-04) | otherwise exact: one inserted element is the whole diff |
| C-ORD-02 per-split limit / featured | PASS | limit 2 -> [pub-b, due-exact, legacy-all]; featured officer -> [featured-pub, featured-mem] |
| C-SHP-01 13-key projection | **FAIL — shape drift** | announcementDocFromSupaRow spreads the whole jsonb payload: slug, created_by, showInTicker (and, when present, created_at / meta_*) reach consumers. Not byte-identical to the converter projection. No consumer breaks today (they read named fields), but the recorded contract and the migration brief's byte-identical requirement are violated. |
| C-SHP-02 priority default | **FAIL — shape drift** | a stored doc without priority reads back undefined, not 0. Carousel sorts read `priority \|\| 0` so no visible break; strict consumers would see undefined. |
| C-SHP-02 publish_date default | PASS | always present, null when absent |
| C-SHP-03 id precedence | PASS | row id wins over stored 'id' |
| C-TS-01 instants preserved | PASS | ISO strings carrying exact stored instants, both reps |
| C-TS-02 representation equivalence | PASS | supaTimestampToIso: dump shape, {seconds}, ISO, epoch, Date, Timestamp-like all -> same ISO |
| C-TS-03 poison shape | PASS — hazard neutralized | the seam normalizes {_seconds,_nanoseconds} on read: scheduled stays scheduled, expired stays expired |
| C-MEMO-01..04 | PASS (OFF, unchanged code) / PASS (ON, mocked route) | memo wraps the set fetch on both paths; one route fetch per TTL window verified |
| C-QRY-01 consumer emission | PASS by construction | all four direct-query consumers now call fetchVisibleAnnouncementsSet with the same options ({limit 50} / {isFeatured, limit 8}); bell unchanged |
| C-WRT-01..04 primary writes | PASS | Firestore write paths untouched in the snapshot |
| C-WRT mirror serialization | PASS | serializeAnnouncementForSupa: Timestamp -> ISO, serverTimestamp sentinel -> client-instant ISO (documented sub-second skew), nested dump shapes -> ISO |

NOT YET VERIFIABLE (route/wiring absent in snapshot):
- /api/announcements/visible tier resolution + the client tier guard
  end-to-end (only the guard's client half exists).
- Admin write mirroring: mirrorAnnouncementViaRoute exists in the seam
  but the admin page did not call it in the snapshot; mirror WIRING
  unverified.
- Re-run this verdict suite at landing: copy the verdict test into the
  landed tree, run both suites, and re-file any changed verdicts.
