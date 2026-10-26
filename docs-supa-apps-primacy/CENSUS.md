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

## 2. Mirror-gap closures

_(filled in as the closures land — see git log on feat/supa-cut-apps)_

## 3. Write primacy (isSupaPrimary('applications'))

_(truth table per flag state + per-flow behavior — filled in with the build)_

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

_(filled in with the build)_

## 6. Gates

_(filled in with the build)_
