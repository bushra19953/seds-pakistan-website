# Cutover Section Report — APPLICATIONS write primacy (apps-1) + mirror completeness

Branch: `feat/supa-cut-apps` off `feat/supa-cutover` @ fa9866fc.
Worktree: `~/workspace/fix-ab/wt-supa-cut-apps`.
Firestore reads/writes against live data: **0**. Live Supabase writes: **0**
(all tests mocked). Firebase Auth untouched, `firestore.rules` untouched.

STATE inherited: applications (apps-1) could NOT flip in the read migration
because fs_applications MIRROR COMPLETENESS was never reconciled. apps-2
migrates nothing by design (the unbounded PII listener port is forbidden —
NOT touched by this workstream). apps-3's chapters seam and the
chapter-application flows both write fs_chapters over disjoint flows —
the per-flow single-writer invariant is verified and pinned in §4.

Flag law (foundation): a surface is write-primary iff its token is in BOTH
SUPA_SURFACES and SUPA_PRIMARY (`isSupaPrimary('applications')`). OFF =
byte-identical dual-write. No browser ever writes Supabase (no RLS).

## 1. MIRROR COMPLETENESS — code-level census (gap table FIRST)

Every write point that creates / updates / deletes a document in the
Firestore `applications` or `chapter_applications` collections, found by
grepping every `collection('applications')` / `collection('chapter_applications')`
/ client `doc(db, 'applications', …)` site on the base tree and reading
each one. "Shape identical" means: the mirrored payload is produced by the
same `serializeForSupa` conversion the Supa read path was built against
(sentinels → ISO strings, dot-paths and delete markers interpreted), so
the fs row is field-for-field what the read seam serves.

### 1a. `applications` → fs_applications

| # | Write point | Op | Mirrors today? | Under which flag / seam | Shape identical? | Disposition |
|---|---|---|---|---|---|---|
| A1 | `src/app/induction/page.tsx` submit batch (~L620): `batch.set(doc(db,'applications',uid), applicationData)` + users flag set, one atomic client batch | create/replace | **NO** — client-direct browser write; no server code runs | — | n/a | **CANNOT CLOSE HERE.** A browser write cannot reach the server adapter, and no approved server submit route exists (apps-2 inventory `apps2-induction-submit-batch`: a future route must preserve batch atomicity, the guarded-key strip, and the intake-window stamp). Owned by the W3 client-direct elimination workstream. NAMED FLIP-BLOCKER (§5). |
| A2 | `src/app/admin/applications/page.tsx` `updateApplicationStatus` (~L308): client `updateDoc` {status, reviewedAt/By, reviewNotes, rejection_reason, stageHistory.*} for shortlist / reject / under_review / on_hold | update | **NO** — client-direct | — | n/a | **CANNOT CLOSE HERE.** No approved server route exists for non-approve statuses (approve alone goes through universal-review); apps-2 inventory `apps2-admin-status-write`. Client-direct workstream. NAMED FLIP-BLOCKER (§5). |
| A3 | `src/app/admin/applications/page.tsx` post-approve stage stamp (~L477): client `updateDoc` {`stageHistory.<approved>`} | update | **NO** — client-direct | — | n/a | **CANNOT CLOSE HERE.** Same blocker as A2 (apps-2 `apps2-admin-approve-stage-stamp`). Client-direct workstream. |
| A4 | `src/app/api/applications/status/route.ts` PATCH: `appRef.update(update)` (documents / domainPreferences / milestones whitelist) | update | YES — `mirrorApplicationUpdate` after the Firestore update | SUPA_SURFACES=applications, `src/lib/applications-supa.ts` | YES (seam RMW; dot-paths + null milestone stamps applied by the seam) | Primacy in §3 (adapter-first). |
| A5 | `src/app/api/admin/universal-review/route.ts` PATCH: `batch.update(docRef, updatePayload)` for collection=`applications` (approve/reject + points/cadetship side effects in the same batch) | update | YES — post-commit `mirrorUniversalReviewToSupa('applications', …)` | **SUPA_SURFACES=inbox** (!), `src/lib/inbox-supa.ts` (its own REST transport, not the adapter) | YES for the reviewed fields (route replaces the reviewedAt sentinel with an ISO string before mirroring; RMW merge) | Mirror ownership is the inbox seam's, not this surface's — recorded plainly. This workstream ADDS an applications-seam mirror behind SUPA_SURFACES=applications in the same post-commit flush (dual-write completeness independent of the inbox token) and the primacy commit gate (§3). The inbox mirror itself is untouched. |
| A6 | `src/app/api/auth/send-welcome/route.ts`: `db.collection('applications').add({...leadDoc, type:'rover_starter_lead', stage:'pending_crucible'})` | create | **NO** | — | — | **CLOSED (§2):** capture the ref id, `mirrorApplicationSet`. Primacy: adapter-first (§3). |
| A7 | `src/app/api/cadetships/[id]/decision/route.ts` `mirrorApplication()`: `db.collection('applications').doc(doc.applicationId).set({cadetshipOutcome}, {merge:true})` on confirm/exit | merge-set | **NO** — the site comment hands it to the applications cluster ("stays Firestore-only (applications cluster)") | — | — | **CLOSED (§2):** `mirrorApplicationMergeSet` (adapter setDoc {merge:true} = Firestore set-merge parity, creates the row iff the Firestore doc is created). Primacy: adapter-first (§3). The cadetship write itself stays with the HR/cadetships seam, untouched. |
| A8 | `src/lib/retention/engine.ts` run via `src/app/api/cron/retention/route.ts`: per-doc `update({retentionArchivedAt})`, PII-scrub `update({...PII:null, retentionScrubbedAt})` on rejected applications at 24 months; `delete()` exists in the engine but the applications policy has `deleteAfterDays: null`, so it never fires for this collection | update | **NO** — generic engine over a `deps.db` abstraction with no per-doc mirror hook | (retention reads have a compliance-owned seam; the engine writes have none) | — | **CROSS-CLUSTER, NOT CLOSED HERE.** The retention engine + cron wiring belong to the cron/compliance workstream (the same one that owns the retention seam). Closing it needs an engine-level hook, which is that workstream's design surface, not a per-call-site mirror. Named in §5: under applications primacy these rare Firestore-only updates (archive stamp, PII scrub) would drift fs_applications until that workstream lands its hook or a reconcile runs. |
| A9 | `src/app/api/webhooks/firestore/route.ts` `handleSubmissionsSyncRoute` for col=`applications` | — | Writes `universal_submissions`, NOT `applications` | — | — | Verified NOT an applications write point. No action. |
| — | Reads only (verified, no writes): `src/lib/invite-system.ts`, `src/components/applicant-status/applicant-portal.tsx` (writes go through A4), `src/app/api/admin/dashboard/init/route.ts` (counts), universal-review GET, `src/lib/inbox-supa.ts` GET feeds, `src/lib/server/admin-dashboard-supa.ts` | — | — | — | — | — |

Supabase-side confirmation: the only modules that write fs_applications
through any transport on the base tree are the applications seam (via A4)
and inbox-supa (via A5). The census above is the complete Firestore-side
writer set those mirrors must cover.

### 1b. `chapter_applications` → fs_chapter_applications

| # | Write point | Op | Mirrors today? | Flag / seam | Shape identical? | Disposition |
|---|---|---|---|---|---|---|
| C1 | `src/app/actions/chapter-applications.ts` `createChapterApplication`: `.add(applicationData)` | create | YES — `mirrorChapterApplicationSet(ref.id, …)` | applications, applications-supa | YES | Primacy §3 (pre-generated id, adapter-first). |
| C2 | `src/app/actions/chapter-applications.ts` `linkOrderToApplication`: `.update({status:'pending_review', orderId, updatedAt})` | update | YES — `mirrorChapterApplicationUpdate` | applications | YES | Primacy §3 (adapter-first). |
| C3 | `src/app/actions/chapter-applications.ts` `updateChapterApplicationStatus`: `.update(updatePayload)` (+ approval side effects: chapters create via port, users chapterId writes, order status — other clusters, stay Firestore) | update | YES — `mirrorChapterApplicationUpdate` | applications | YES | Primacy §3: multi-doc flow → Firestore stays the effect engine, the mirror becomes the primary COMMIT GATE (tasks PATCH pattern). |
| C4 | `src/app/actions/chapter-applications.ts` `deleteChapterWithCleanup`: revert `.update(revertPayload)` (+ chapters delete via port) | update | YES — `mirrorChapterApplicationUpdate` (seam serializer turns `FieldValue.delete()` into a key removal) | applications | YES | Primacy §3: same gate pattern as C3. |
| C5 | `src/app/actions/store.ts` `createOrder` chapter linkage: `chapter_applications.doc(chapterApplicationId).update({orderId, status:'pending_review', updatedAt})` inside a best-effort try/catch | update | **NO** | — | — | **CLOSED (§2):** `mirrorChapterApplicationUpdate` inside the same try (same payload as C2). Primacy §3: the throwing primary update runs inside the same try — the host flow is deliberately best-effort (an order never fails because linkage failed), so a primary failure is logged by the existing catch, not surfaced. Named in §3. |
| C6 | `src/app/api/v1/chapters/invoice/route.ts` POST: `.add(applicationData)` with status `invoice_issued` | create | **NO** | — | — | **CLOSED (§2):** capture the ref id, `mirrorChapterApplicationSet`. Primacy: adapter-first, throw → the route's outer catch returns 500 (§3). |

### 1c. `chapters` writes on chapter-application paths → fs_chapters

| # | Write point | Op | Mirrors today? | Flag / seam | Disposition |
|---|---|---|---|---|---|
| H1 | C3 approval: `chapters.doc(finalSlug).set(chapterData)` | create | YES — `mirrorChapterSet` through the seam's `ChaptersWriterPort` | applications, applications-supa port | NOT inverted here: `chapters` is its own surface; its primacy is governed by `isSupaPrimary('chapters')` and the chapters workstream. Payload verified field-for-field against chapters-supa's documented inbound contract (residual report §3) — unchanged. |
| H2 | C4 cleanup: `chapters.doc(chapterId).delete()` | delete | YES — `mirrorChapterDelete` through the port | applications, applications-supa port | Same as H1. |
| H3 | `src/app/api/admin/chapters/route.ts` POST / `[id]/route.ts` PATCH | create/update | YES — `mirrorChapterCreate` / `mirrorChapterUpdate` | chapters, `src/lib/chapters-supa.ts` | Chapters workstream surface; untouched by this workstream. |

## 2. Mirror-gap closures (all landed; commits 791b9ee6 + 6091e454 + a98bd323)

- **A6 — send-welcome create:** the route now captures the created ref
  and calls `mirrorApplicationSet(ref.id, applicationDoc)` after the
  Firestore write (new seam wrapper over `mirrorSetDoc`). Dual-write
  path keeps the exact `.add()` call shape.
- **A7 — cadetship decision write-back:** new seam helper
  `mirrorApplicationMergeSet` (RMW core with create-if-missing =
  Firestore set-merge parity: the fs row is created iff the Firestore
  set-merge creates the doc, merged onto the row when it exists). The
  decision route calls it after its Firestore set-merge; the stale
  "stays Firestore-only" comment is corrected. The cadetship document
  write itself is untouched (HR seam).
- **C5 — store createOrder linkage:** the same payload as C2 now calls
  `mirrorChapterApplicationUpdate` after the Firestore update, inside
  the existing best-effort try.
- **C6 — invoice create:** the route captures the created ref and calls
  `mirrorChapterApplicationSet(ref.id, applicationData)`. Dual-write
  path keeps the exact `.add()` call shape.
- **A5 — universal-review:** applications review ops additionally mirror
  through the applications seam in the same post-commit flush, so the
  surface's dual-write no longer depends on the `inbox` token being set.
  The inbox-seam mirror is untouched (other collections unaffected;
  both mirrors are RMW merges of the same payload onto the same row).
- Seam refactor (behavior-preserving, pinned by the pre-existing seam
  suite): `mirrorUpdateDoc` now runs on a shared RMW core
  (`applyUpdateToAdapter`) that also backs the merge-set mirror and the
  primary update; a missing row remains a silent no-write `false` for
  the mirror path.

NOT closed (named, with owners): **A1** induction submit batch, **A2**
admin status write, **A3** post-approve stage stamp — all client-direct
browser writes; closing them needs the approved server routes the
client-direct elimination workstream owns (a browser must never write
Supabase; no RLS exists). **A8** retention-engine updates — the
cron/compliance workstream owns the engine hook.

## 3. Write primacy (isSupaPrimary('applications'))

Seam support (commit 791b9ee6), following the merged tasks exemplar:
`isApplicationsSupaPrimary()` (local both-flags parser; parity with
`src/lib/supa/flags.ts` pinned by contract), `applicationsPrimaryActive()`
(flag on AND adapter resolved), and the *PrimaryFirst helpers —
`setDocPrimaryFirst` / `updateDocPrimaryFirst` (RMW; throws on adapter
failure AND on a missing row, matching Firestore `update()` parity) /
`mergeSetDocPrimaryFirst` (creates when absent, matching set-merge
parity) — each returning `false` when primacy is inactive so callers
run their untouched dual-write flow.

### Truth table (every applications write flow)

| SUPA_SURFACES | SUPA_PRIMARY | State | Behavior (all flows) |
|---|---|---|---|
| no `applications` | any | OFF | Byte-identical to the base tree: Firestore only, no adapter resolution, no mirror. Pinned by the pre-existing suites + OFF arms of the new suites. |
| `applications` | no `applications` | DUAL-WRITE | Firestore primary; every server write point mirrors through the applications seam (incl. the §2 closures); mirrors never throw. Reads serve Supa per the read migration. |
| `applications` | `applications` | **PRIMARY** | Per-flow table below. Failed Supa write = loud error, never a silent Firestore fallback. |
| no `applications` | `applications` | OFF (flag law) | PRIMARY token alone changes nothing — identical to row 1. Pinned by contract. |

### Per-flow PRIMARY behavior

| Flow | PRIMARY behavior |
|---|---|
| A4 status PATCH | Pre-read from the adapter (missing fs row = authoritative 404; adapter error = loud 500). Adapter update FIRST (throws → 500, zero Firestore writes). Firestore update after as best-effort mirror (failure logged). Post-write response read from the primary store. The users/{uid} domainPreferences mirror stays Firestore (users cluster). |
| A5 universal-review (applications ops) | The Firestore batch remains the effect engine (points, skills, cadetship enrolment are multi-collection). Post-commit, the applications-seam primary update is the COMMIT GATE: failure throws → 500 after the batch committed (two-phase residual, same as tasks PATCH). |
| A6 send-welcome create | Pre-generated id; adapter set FIRST (throws → handler 500, no Firestore doc); Firestore set after, best-effort. The `leads` write stays Firestore-only (other collection). |
| A7 cadetship write-back | Adapter merge-set FIRST (throws → the decision request fails after the cadetship decision landed — same two-phase shape as the existing cadetship flow); Firestore set-merge after, best-effort. |
| C1 chapter application create | Pre-generated id; adapter set FIRST (throws → `{success:false}`, no Firestore doc); Firestore set after, best-effort. `.add()` retained verbatim on the dual-write path. |
| C2 link-order update | Adapter update FIRST (throws → `{success:false}`, Firestore untouched); Firestore update after, best-effort. |
| C3 status transition / C4 delete-revert | Multi-doc flows (chapter create, users writes, order update, audit): Firestore stays the effect engine; the primary update runs as the COMMIT GATE after the Firestore update — failure → `{success:false}` (C3/C4) instead of success over stale primary state. |
| C5 store linkage | Firestore update, then the primary update as gate INSIDE the host flow's existing best-effort try: a gate failure is caught and logged by `createOrder` (an order never fails over linkage — the host's deliberate semantics), so this is the one flow where a primary failure is logged rather than surfaced. Named here plainly. |
| C6 invoice create | Pre-generated id; adapter set FIRST (throws → handler catch → 500, no Firestore doc); Firestore set after, best-effort. |
| H1/H2 chapters writes on approval/delete | NOT inverted (chapters is a separate surface; its primacy belongs to `isSupaPrimary('chapters')`). Unchanged dual-write through the port. |

Contract pins (commit 0e48c138, 41 tests): flag-law truth table +
parser parity; OFF/dual = primary helpers inert with ZERO adapter
writes; primary serialization identical to the mirror's (sentinels →
ISO, dot-paths, delete markers); throw-on-failure per helper; status
route cross-store order log in both states (adapter-first primary,
Firestore-first dual) + 500-with-zero-Firestore-writes on Supa failure
+ primary-authoritative pre-read; action-level create/link order +
loud failure; status/delete gate success and failure arms.

## 4. fs_chapters single-writer invariant

Finding from the census (stated plainly): on the base tree TWO seam
modules write fs_chapters, over DISJOINT flows — the applications-supa
`ChaptersWriterPort` (application-driven create/delete, H1/H2, gated on
the applications token) and chapters-supa (admin chapters CRUD, H3, gated
on the chapters token). No flow has two writers, and no third module
writes fs_chapters through the adapter (verified by grep over every
adapter setDoc/updateDoc/deleteDoc call site). The residual report's
merge-step note ("the re-point must leave exactly one writer") was a
per-flow requirement in effect: the chapter-applications file was
re-pointed so its chapters writes go through exactly ONE port instead of
raw Firestore-side writes plus a second mirror. This workstream does not
add any fs_chapters writer and does not change either flow's gating
(consolidating the two modules into one would change which SUPA_SURFACES
token gates the H1/H2 mirrors — a read-migration behavior change, not a
primacy change; named here as a coordinator decision, not silently done).
The invariant as pinned by contract (§4 tests): per-flow exactly one
writer, and no third writer module.

## 5. Flip prerequisites + rollback

**Flip (in order):**
1. `SUPA_SURFACES` already names `applications` (live since the read
   migration). Add `applications` to `SUPA_PRIMARY` — that token alone
   activates primacy (flag law; either token alone changes nothing).
2. **Data currency (parent verifies at flip time, per program law — not
   verified by this workstream):** fs_applications AND
   fs_chapter_applications must be reconciled current against Firestore
   before the token lands. This is the reconciliation the read
   migration left open; §2 closes the code-level gaps from this commit
   forward, but writes that landed before it through A6/A7/C5/C6 (and
   any A1/A2/A3 client writes) exist only in Firestore until a backfill
   / reconcile covers them. A primary update on an unreconciled row
   throws loudly (by design) — that is the smoke signal, not a silent
   corruption path.
3. **FLIP-BLOCKER (client-direct, A1/A2/A3):** while the induction
   submit, the admin non-approve status write, and the stage stamp
   remain browser-direct Firestore writes, flipping primacy makes
   those writes invisible to Supa-served reads (they land in the
   mirror store only). Flip applications primacy only after the
   client-direct workstream lands server routes for A1/A2/A3, or with
   Zubair's explicit acceptance of that staleness window + a scheduled
   reconcile. This workstream does not hide the blocker: it is the one
   condition under which "full primacy" is not yet true end-to-end.
4. **A8 note:** retention archive/scrub updates stay Firestore-only
   until the cron/compliance hook lands; they run at 24-month horizons
   (archive stamp, PII scrub on rejected applications), so the drift
   window is operationally negligible but nonzero — a reconcile after
   any retention run covers it.
5. No SQL function is required by this surface: primacy here is adapter
   writes (setDoc/updateDoc RMW), not `tx_*` rpc. No schema step.

**Rollback:** remove `applications` from `SUPA_PRIMARY` → dual-write
resumes (Firestore primary, mirrors on). Removing it from
`SUPA_SURFACES` as well returns full Firestore fallback — with the
program-wide sharpening from the finance design (§2.11): after primacy
has accumulated Supa-first writes, a FULL rollback strands those rows
unless a reverse backfill runs first; the SUPA_PRIMARY-only rollback
has no such hazard (reads stay on Supa, which is current).

## 6. Gates (scoped only, per program law; zero live reads/writes)

- **New contract suites (41 tests, all PASS):**
  `src/lib/__tests__/applications-supa-primacy.test.ts` (26),
  `src/app/api/applications/status/__tests__/route-primacy.test.ts` (6),
  `src/app/actions/__tests__/chapter-applications-primacy.test.ts` (9).
- **Apps suites + matched neighbors (all PASS):**
  - Seam + status + chapter-applications + consent + client-inventory
    batch: **15 suites / 186 tests PASS** (applications-supa,
    applications-client-supa, chapters-supa, applicant-status ×2,
    status route/route-supa/route-contracts/route-primacy,
    chapter-applications route-supa/route-parity/route-contracts,
    actions primacy + consent).
  - Universal-review + cadetships + v1 chapters (incl. invoice) +
    admin chapters + store actions + inbox batch: **18 suites / 178
    tests PASS**.
  - Store contracts chain: **60/60 PASS**. Admin applications page +
    induction identity/submit-rules + cron retention contracts:
    **6 suites / 96 tests PASS**.
  - The `test/supa-apps-contracts` family (4 route-contracts files)
    lives in-tree on this base and is inside the green batches above.
  - Total across batches: **520 tests PASS, 0 failures.** One combined
    run early on showed a single failure that traced to a wrong
    assertion in the new actions suite itself (it counted the
    audit_logs `.add()` as a forbidden Firestore add); the assertion
    was narrowed to the application doc and the suite is green.
- **Scoped tsc:** temp-config run over all 8 touched source files + 3
  new test files: **ZERO errors in touched source files**. Remaining
  errors are (a) jest-global artifacts of the scoped config — proven by
  re-running the identical config with untouched baseline test files
  substituted (169 of the same class), and (b) pre-existing baseline
  errors in untouched files (`src/types/store.ts` TS2300 duplicates,
  `src/config/*` TS1117s, consent-gate) — the branch diff for those
  files is zero. Full-repo tsc remains the coordinator's serialized
  gate, per program law.
- **Diff confinement:** 8 production files (the applications seam, the
  status route, the chapter-applications actions, store actions (one
  linkage block), universal-review (one flush block), send-welcome,
  cadetship decision (one helper), invoice route) + 3 test files + this
  report's in-repo copy. Pinned files untouched; adapter untouched;
  `firestore.rules` untouched; apps-2 (PII listener) untouched — zero
  lines.

## Branch

`feat/supa-cut-apps` @ `0e48c138` (+ the report commit that follows):
(1) 3d7bfdce census, (2) 791b9ee6 seam primacy, (3) 6091e454 closures +
wiring, (3b) a98bd323 exact-OFF-path creates, (4) 0e48c138 contracts.
Base: feat/supa-cutover @ fa9866fc. Nothing pushed, nothing deployed,
no flags flipped, zero live reads/writes.
