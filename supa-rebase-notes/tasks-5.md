# Supabase migration — rebase notes: tasks cluster, group 5
## (submissions routes where they join tasks)

Branch: `feat/supa-tasks-5`, built against `feat/integration-wave3 @ 4d5a1e16`.
File group: `src/app/api/submissions/route.ts` ONLY, plus the new seam module
`src/lib/supa/seam-submissions.ts` and its tests.

## JOIN INVENTORY — the scope line, drawn explicitly (verified 2026-10-25)

`src/app/api/submissions/route.ts` (384 lines at base) was read end to end and
grep-verified (`task`, case-insensitive): **the route contains ZERO references
to the `tasks` collection, zero task ids, and zero calls into
`src/lib/server/gamification-transaction.ts`.** Submissions handled here are
the member link-submission system (`src/lib/submission-types.ts`:
competition | opportunity | resource | other), NOT task proof submissions.
Task proof lives on task docs themselves and is reviewed via
`src/app/api/admin/universal-review/route.ts` and
`src/app/api/tasks/review-queue/route.ts` — both owned by other groups.

Per handler, at base commit 4d5a1e16:

| Handler | Collections touched (file:line at base) | Touches tasks? |
|---|---|---|
| GET (list) | `submissions` query L48-67 (where userId/status, orderBy `submittedAt` desc, limit) | NO |
| POST (create) | `submissions` dup-check L132-136, `users/{uid}` get L147, `submissions` set L147-172, `roles` query L182-186 + `users/{admin}/notifications` batch L188-201 | NO |
| PATCH (review) | `submissions` get L251-258, `users/{reviewer}` get L293, ONE batch L296-381: `submissions` update, `users/{submitter}` points increment + `points_audit` set (approve only), `competitions` set + `submissions.linkedCompetitionId` update (approve + addToCompetitions + type=competition), `users/{submitter}/notifications` set | NO |

Consequences for THIS group, stated plainly:

- There are **no task-joining reads to swap** and **no task-doc writes to
  mirror** inside this file. Any seam call claiming otherwise would be dead
  code or a behaviour change, so none is added.
- The ONE place this route joins the wider tasks/gamification WORLD is the
  PATCH approve flow's points award (L317-336 at base): it increments
  `users.points` / `users.submissionsApprovedCount` and writes a
  `points_audit` row DIRECTLY in its own batch. It does **not** flow through
  the canonical `executeGamificationTransaction`
  (`src/lib/server/gamification-transaction.ts`) — no task completion, no XP
  ledger entry, no badge/streak side effects. That divergence is exactly the
  known defect TS-P16 ("inbox approval is a lesser completion than the
  canonical gamification transaction"; see Known facts). This route is the
  API twin of that inbox approval for link submissions. Per brief rule 4 the
  seam stays at route level, `gamification-transaction.ts` is never edited
  here, and the flow is migrated FAITHFULLY (same batch, same increments,
  same audit shape) — not repaired.
- Everything else in the route (all `submissions`-collection reads/writes,
  the `users` reviewer/submitter reads, `roles` admin lookup, `competitions`
  creation, notifications) is a **remaining Firestore dependency for this
  wave** under design rule 2 ("submission-collection reads that do not join
  tasks stay on Firestore"). The submissions collection itself belongs to a
  later/other wave.

### What this branch therefore ships

1. `src/lib/supa/seam-submissions.ts` (new, 372 lines) — the ONE seam
   for this file-group: lazy variable-specifier dynamic import of
   `@/lib/supa`, local `SupaAdapterLike` interface accepting BOTH the
   real adapter's shapes (`getSupaAdapter()` factory returning
   `{getDoc,listDocs,countDocs,setDoc,updateDoc,deleteDoc}` with flat
   `{id, ...data}` docs, verified against branch `feat/supa-adapter`)
   and direct function exports; surface string exactly `'tasks'`
   (`SUBMISSIONS_JOIN_SURFACE`); null/false when unavailable.
   Exports: `supaTasksSurfaceEnabled()`, `supaGetTaskDoc(taskId)` (the
   task-join read primitive: adapter `getDoc('tasks', id)`,
   timestamps normalized; null on off/absent/error/absent-doc),
   `mirrorSubmissionReview(mirror)` (best-effort, never throws),
   `normalizeTimestampValue` / `normalizeTimestampFields` /
   `sanitizeForMirror`, `supaSurfacesInclude` (pure parse matching the
   real flags.ts: SUPA_SURFACES comma list, case-insensitive, '*'),
   and `__setSubmissionsAdapterForTests` for mock injection.
   MERGE-TIME ACTION for the coordinator: the real adapter's
   `getSupaAdapter()` throws `SupaUnavailableError` when no client is
   configured — the seam already catches that; no re-pointing needed
   beyond confirming `@/lib/supa` index exports `getSupaAdapter` +
   `useSupa` (it does on feat/supa-adapter).
2. Route edits: PATCH only, 4 hunks, listed per-hunk below.
   GET and POST are byte-identical to base.
3. Tests: `src/lib/supa/__tests__/seam-submissions.test.ts` (flag
   OFF parity / adapter never called, flag ON join read with MOCKED
   adapter, mirror-on-write incl. failure-swallow, timestamp
   normalization) and
   `src/app/api/submissions/__tests__/route-supa.test.ts` (route-level:
   mirror called exactly once per committed decision with the right
   payload, never on a 409, GET parity shape).

## Surface-string argument (brief asks: argue if own surface is needed)

Implemented surface: **`'tasks'`**, as instructed. Argument recorded for the
merge coordinator: link submissions are not tasks, and if a future wave
migrates the `submissions` collection reads in this route, gating them on
`'tasks'` would couple two unrelated surfaces (enabling tasks would silently
switch submission listing). That future wave should introduce
`'submissions'`. In THIS wave nothing in the route is gated, so the choice
is inert; the seam carries `'tasks'` so any genuine task-join added later
rides the tasks flag as the brief directs.

## Adapter contract (programmed against, not present in this tree)

- Real adapter built in parallel at `src/lib/supa/` (branch
  `feat/supa-adapter`): `getSupaAdapter()` -> `{ getDoc, listDocs,
  countDocs, setDoc, updateDoc, deleteDoc }` over `fs_<collection>` jsonb
  tables, Firestore-shaped results `{id, ...data}`; `useSupa(surface)`
  reads `SUPA_SURFACES` env, default OFF.
- This seam reaches it via a lazy dynamic import through a variable
  specifier typed to a LOCAL interface, so tsc is clean while
  `src/lib/supa/` is absent from this tree. It tolerates: module absent,
  `getSupaAdapter` missing, adapter methods missing, any call throwing.
  Every failure mode -> seam returns null/false -> caller keeps EXACTLY
  today's Firestore behaviour.
- No `@supabase/supabase-js` import anywhere in this group; no new deps.

## KNOWN FACTS — preserved, NOT fixed (defect program owns them)

Flagged where this group's code passes near them:

- **TS-P17 (inbox visibility)**: the Universal Inbox submissions listener
  (`src/app/admin/submissions/page.tsx:46`, CLIENT listener — inventory
  only, later wave, NOT edited here) queries
  `collection(db,"submissions") orderBy("created_at","desc")`. The writer
  of those docs is THIS route's POST (L147-172 at base), which sets
  `submittedAt: serverTimestamp()` and NEVER sets `created_at`; Firestore
  `orderBy` excludes docs missing the field, so these submissions can
  never reach the inbox listener. Same listener/page: rows keep the doc's
  own `type` (lowercase `competition|opportunity|resource|other` from
  `submission-types.ts`), while the tab filter
  (`page.tsx:318-324` + tab def `page.tsx:361`) keeps rows where
  `s.type === 'SUBMISSION'` — never true for these docs. **This branch
  preserves both shapes faithfully: POST still writes `submittedAt` and
  lowercase `type`, adds NO `created_at`, performs NO vocabulary repair.**
- **TS-P16 / TS-P19 (lesser completion / foreign rejected status)**:
  TS-P19 is about TASK docs: inbox rejection strands tasks in a foreign
  `'rejected'` status. THIS route writes `'rejected'` only onto
  SUBMISSION docs (PATCH, see status inventory), where it is the native
  vocabulary (`SubmissionStatus = 'pending'|'approved'|'rejected'`), and
  writes NOTHING onto task docs — there is no task write to strand. The
  TS-P16 half touches this route directly: PATCH approve awards points via
  a direct `users.points` increment + `points_audit` row in the route's
  own batch (base L317-336), bypassing the canonical gamification
  transaction (no flow-through to
  `src/lib/server/gamification-transaction.ts` exists in this file —
  verified by grep; the only flow-through note is this ABSENCE, recorded
  deliberately). Migrated faithfully; the defect branch owns any
  unification.

## Status-literal inventory (collision protocol — defect branch unifies
## task-doc 'approved' -> 'completed')

Every read/write of `'approved'` / `'completed'` / `'rejected'` in
`src/app/api/submissions/route.ts` at base (line numbers at 4d5a1e16):

- L?? `'completed'`: **NONE anywhere in the file.** No read, no write.
- Submission-doc status writes (PATCH): `newStatus = action === 'approve'
  ? 'approved' : 'rejected'` (base L303) written to the SUBMISSION doc
  only (batch.update, base L307-315). These are submission vocabulary,
  NOT task-doc status — the defect branch's 'approved'->'completed'
  unification for TASK docs must NOT rewrite these.
- Submission-doc status reads (PATCH guard): `priorStatus` lowercased;
  terminal check `priorStatus === 'approved' || priorStatus ===
  'rejected'` (base L281-282); 409 body echoes `submission.status`
  verbatim (base L288).
- GET: `status` query param passed through as a `where('status','==',
  status)` value against the submissions collection (base L58-60) — no
  literal in code; callers may pass 'approved'/'rejected' (submission
  vocabulary).
- POST: writes `status: 'pending'` on the new submission doc (base L171).
- Competition write (PATCH, approve + addToCompetitions): writes
  `status: 'active'` on the new COMPETITIONS doc (base L352) — not a task
  doc, not 'approved'/'completed'.
- `points_audit.reason: 'submission_approved'` (base L328) — audit
  vocabulary, unchanged.
- No status literal of any spelling is read from or written to a `tasks`
  doc in this file, because no task doc is touched (see inventory).

Re-application rule for the rebase over `fix/tasks-status-semantics` +
`fix/tasks-profile-board` (both merge BEFORE this branch): if the defect
branch renames submission-doc literals in this file (it should not — its
scope is task docs), re-check the PATCH guard + write hunks below; the
expected rebase is conflict-free because this branch's hunks do not touch
status literals at all (see per-hunk list).

## Timestamp consumers in scope (.toDate() / Timestamp), base file:line

In `src/app/api/submissions/route.ts`:
- GET response mapping (base L72-76): `submittedAt?.toDate?.()
  ?.toISOString() || null`, same pattern for `reviewedAt` (L74) and
  `deadline` (L75) — the ONLY `.toDate()` consumers in the file. GET is a
  submissions-collection read (out of task-join scope, stays Firestore
  this wave); the seam's normalizer reproduces this exact output for
  ISO-string/Date/Timestamp-like inputs so a future swap is shape-safe.
- POST (base L165): `deadline` written as
  `admin.firestore.Timestamp.fromDate(new Date(deadline))`; (base L171)
  `submittedAt: FieldValue.serverTimestamp()`.
- PATCH (base L309, L333, L371): `reviewedAt` / audit `timestamp` /
  notification `timestamp` written as `FieldValue.serverTimestamp()`.
- jsonb note: when these docs are read back through Supabase in a later
  wave, timestamp fields arrive as ISO strings; `?.toDate?.()` yields
  undefined -> `|| null` would NULL OUT real timestamps. That is why the
  seam normalizer exists and why any future GET swap must use it. NOT
  changed in this wave (GET stays Firestore; changing its mapping now
  would alter flag-OFF output for non-string shapes).

## Admin submissions PAGE listeners (client — inventory only, later wave)

`src/app/admin/submissions/page.tsx` (Universal Inbox), NOT edited:
- L46-68: `submissions` listener, `orderBy("created_at","desc")`,
  limit 100 — TS-P17 site (above).
- L87-172: TWO `tasks` listeners (status `submitted-for-review`; and
  pending/in-progress with deliverableFiles) merged client-side into
  TASK_REVIEW rows — this is the REAL submissions<->tasks join in the
  product, and it is entirely client-side; a later client-listener wave
  owns it.
- L182-256: `leave_requests` listener; L269-313: `applications` listener.
- L318-324: combined filter; tab id `'SUBMISSION'` vs lowercase doc
  `type` — TS-P17 site.
- L412-413: row date render `row.created_at?.toDate` — client Timestamp
  consumer, later wave.
Review actions from the inbox go through the drawers /
`src/app/api/admin/universal-review/route.ts` (other group), NOT through
this route. This route's only live caller is
`src/components/profile/submit-competition.tsx:71` (POST).

## Per-hunk re-application list

All hunks are in `src/app/api/submissions/route.ts`, PATCH handler
only, plus the seam/test files (pure additions, conflict-free). Line
numbers are POST-edit on this branch; base anchors quoted so each hunk
re-applies mechanically over `fix/tasks-status-semantics` and
`fix/tasks-profile-board` (neither is expected to touch this file; if
the status-semantics branch DID rename submission-doc literals —
out of its stated task-doc scope — hunks 1-5 still apply unchanged
because none of them touches a status literal; the mirror payload's
`status: newStatus` reads the variable, so it follows whatever
literal the merged code assigns).

- Hunk 1 (import, post-edit L6): after the `submission-types` import
  add `import { mirrorSubmissionReview } from
  '@/lib/supa/seam-submissions';`
- Hunk 2 (mirror capture declarations, post-edit L293-295): anchor
  `const batch = db.batch();` in PATCH; immediately after it insert
  the comment + `let auditMirrorId`, `let auditMirrorData`,
  `let competitionMirrorData` declarations (all `null`).
- Hunk 3 (audit payload capture, post-edit L322-344): anchor the
  `// Points audit` block. The inline object passed to
  `batch.set(auditRef, {...})` becomes `const auditData = {...}`
  (object content byte-identical, incl. the serverTimestamp), then
  `batch.set(auditRef, auditData); auditMirrorId = auditRef.id;
  auditMirrorData = { ...same fields minus timestamp... };`
- Hunk 4 (competition payload capture, post-edit L349-379): same
  pattern on the addToCompetitions block: `const compData = {...}`
  (byte-identical), `batch.set(compRef, compData)`,
  `competitionMirrorData = { ...same fields minus createdAt... }`,
  then the pre-existing `linkedCompetitionId = compRef.id;` and the
  `batch.update(submissionRef, { linkedCompetitionId })` lines are
  unchanged.
- Hunk 5 (mirror call, post-edit L401-424): anchor
  `await batch.commit();` in PATCH (NOT the POST one at L185, which
  is untouched). After it, before the success `NextResponse.json`,
  insert the explanatory comment and `await mirrorSubmissionReview({
  submissionId, status: newStatus, reviewedBy: auth.user.userId,
  reviewerDisplayName: reviewerData?.displayName || auth.user.email
  || 'Admin', reviewNotes: reviewNotes || null, pointsAwarded:
  finalPoints, reviewedAtIso: new Date().toISOString(),
  linkedCompetitionId, competition: competitionMirrorData, auditId:
  auditMirrorId, audit: auditMirrorData });`

Mirror semantics on re-application: Firestore batch stays primary
and commits FIRST; the mirror runs after, is gated inside the seam
on surface 'tasks' + adapter presence, and never throws — flag OFF /
adapter absent / mirror error all leave the response byte-identical
to today. NOT mirrored, deliberately (merge-coordinator decisions if
ever wanted): the `users/{submitter}` points increment + count
increment (FieldValue.increment; no safe absolute mirror), and the
submitter notification (users subcollection, other cluster).

## Gates

- jest (touched suites): `npx jest src/app/api/submissions
  src/lib/supa` — 3 suites, 30 tests, ALL PASS (9 pre-existing
  route.test.ts + 21 new: 15 seam + 6 route-supa). Zero live reads;
  every adapter interaction in tests is an injected mock.
- tsc: (filled in when the queued full run lands)
