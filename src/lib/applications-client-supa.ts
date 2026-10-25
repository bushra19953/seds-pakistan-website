/**
 * Applications client seam (Supabase migration, cluster APPS-2: admin
 * applications + induction UI data paths).
 *
 * Pair module: src/lib/applications-supa.ts (group APPS-1) owns the
 * SERVER data paths for applications (chapter-applications route,
 * applications/status route, chapter-application actions). This module
 * owns only the CLIENT side of the same surface. The two seams are
 * flagged as a pair for the merge step: if a surface name or flag
 * convention changes in one, it must change in the other.
 *
 * Why nothing in this group migrates yet (the blocker, stated once):
 * the Supabase adapter (src/lib/supa/, branch feat/supa-adapter) is
 * SERVER-side only (service role key). Browser code can never call it.
 * A client Firestore path can therefore move only by introducing a
 * server route with a byte-identical response shape behind the
 * default-OFF flag, and only when the design verifier's spec
 * (~/workspace/supabase-migration/design-verify-apps-cluster.md)
 * approves that route. No such approval exists for any path in this
 * group, and this group invents no unapproved routes. Every path below
 * therefore stays on Firestore, byte-identical to the base tree, and
 * is recorded in APPLICATIONS_CLIENT_INVENTORY with its ruling:
 *
 *   'server-routed'        Already flows through a server route
 *                          (rule (a)): the call is left exactly as is.
 *   'listener'             A live Firestore listener (onSnapshot,
 *                          direct or via useCollection listen:true).
 *                          Listener class is never-bulk: documented,
 *                          never ripped out or polled.
 *   'client-direct'        A direct browser getDoc / write with no
 *                          approved server replacement. Stays on
 *                          Firestore until the verifier approves one.
 *   'shared-lib-flag-only' The path lives in a shared lib or hook
 *                          owned by another cluster. Flagged here,
 *                          never edited from this group.
 *   'presentational'       No data source of its own.
 *
 * Flag: the client can only see the NEXT_PUBLIC_ twin of the adapter's
 * frozen SUPA_SURFACES list. applicationsSupaClientEnabled() is a HINT
 * only: today no consumer acts on it (there is no approved route to
 * hint at), and when a route is approved the route must re-check the
 * server flag and config itself. Default is OFF: unset, empty, or any
 * list not naming the surface (or '*') means Firestore behavior.
 *
 * Quirks preserved, deliberately (pinned by a sibling test author;
 * changing either is a failure of this group's brief):
 *   1. List-row badges in ApplicationList can stay "Pending" after an
 *      approval; the detail pane and the filter counts are the
 *      authoritative display.
 *   2. The date filters in ApplicationList bucket by a different
 *      timezone than the displayed dates (filter bounds are built
 *      with new Date(<yyyy-mm-dd>) local parsing and setHours, while
 *      rows render created_at via toLocaleDateString).
 * Neither quirk is touched by this group: no badge, filter, sort, or
 * date code changes anywhere in the assigned files.
 */

export const APPLICATIONS_SUPA_SURFACE = 'applications';

export function applicationsSupaClientEnabled(
  raw: string | undefined = process.env.NEXT_PUBLIC_SUPA_SURFACES,
): boolean {
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes(APPLICATIONS_SUPA_SURFACE);
}

export type ApplicationsClientRuling =
  | 'server-routed'
  | 'listener'
  | 'client-direct'
  | 'shared-lib-flag-only'
  | 'presentational';

export interface ApplicationsClientInventoryEntry {
  id: string;
  file: string;
  /** Line in the base tree (feat/integration-wave3 @ 4d5a1e1). */
  line: number;
  collection: string;
  operation: string;
  shape: string;
  ruling: ApplicationsClientRuling;
  note: string;
}

export const APPLICATIONS_CLIENT_INVENTORY: readonly ApplicationsClientInventoryEntry[] =
  Object.freeze([
    // -- src/components/admin/applications/application-list.tsx --------
    {
      id: 'apps2-list-applications',
      file: 'src/components/admin/applications/application-list.tsx',
      line: 73,
      collection: 'applications',
      operation: 'read (listener)',
      shape:
        'collection(applications); where(status == statusFilter) only when a status filter is set, otherwise the unconstrained collection; NO orderBy and NO limit (client-side sort by created_at, client-side university and date filtering). Consumed via useCollection(query, { listen: true }), which subscribes with onSnapshot.',
      ruling: 'listener',
      note: 'Listener class, never-bulk. The same snapshot feeds the rows, the filter counts, and the intake pace cohort in this component. Stays on Firestore; a Supabase move would need a verifier-approved server list path plus a realtime story, neither of which exists.',
    },
    {
      id: 'apps2-list-universities',
      file: 'src/components/admin/applications/application-list.tsx',
      line: 70,
      collection: 'settings/induction_metadata',
      operation: 'read via shared hook',
      shape: 'useUniversities() -> getDoc(settings/induction_metadata) inside src/hooks/use-universities.ts.',
      ruling: 'shared-lib-flag-only',
      note: 'Shared hook, settings surface, not the applications collection. Flagged for the settings/hook owner; not edited here.',
    },
    // -- src/components/admin/applications/intake-pace-line.tsx -------
    {
      id: 'apps2-pace-line',
      file: 'src/components/admin/applications/intake-pace-line.tsx',
      line: 1,
      collection: '(none)',
      operation: 'none',
      shape:
        'Presentational only. ApplicationList computes pool and projection from its own snapshot with computePaceProjection (src/lib/intake-windows/pace.ts) and passes plain props.',
      ruling: 'presentational',
      note: 'No data source to migrate. Its figures inherit the ruling of apps2-list-applications.',
    },
    // -- src/app/admin/applications/page.tsx ---------------------------
    {
      id: 'apps2-admin-intake-windows',
      file: 'src/app/admin/applications/page.tsx',
      line: 107,
      collection: '(server route)',
      operation: 'fetch GET',
      shape: "fetch('/api/admin/intake-windows?kind=induction', Bearer ID token) -> { windows } resolved client-side with resolveWindow.",
      ruling: 'server-routed',
      note: 'Rule (a): call left exactly as is. The route itself belongs to the intake-windows/server groups.',
    },
    {
      id: 'apps2-admin-user-flag',
      file: 'src/app/admin/applications/page.tsx',
      line: 157,
      collection: 'users',
      operation: 'read',
      shape: 'getDoc(doc(db, users, selectedApplicationId)) -> { hasApplied, applicationStatus } duplicate-submission flag display.',
      ruling: 'client-direct',
      note: 'Single-doc browser read of the users collection (users cluster surface). Left on Firestore; flagged as an adjacent path, not an applications-collection path.',
    },
    {
      id: 'apps2-admin-audit-logs',
      file: 'src/app/admin/applications/page.tsx',
      line: 178,
      collection: 'audit_logs',
      operation: 'read',
      shape: "getDocs(query(collection(audit_logs), where(targetUidOrResource == uid))), filtered client-side to action == 'application_status_updated' for the status-history pane.",
      ruling: 'client-direct',
      note: 'CROSS-CLUSTER FLAG: audit_logs is NOT this cluster. The read is inventoried here only because it sits in an assigned file; it is not touched and not migrated by this group.',
    },
    {
      id: 'apps2-admin-form-config',
      file: 'src/app/admin/applications/page.tsx',
      line: 210,
      collection: 'settings/induction_form',
      operation: 'read',
      shape: 'getDoc(doc(db, settings, induction_form)) -> fields config for rendering applicant responses.',
      ruling: 'client-direct',
      note: 'Settings surface, other cluster. Left on Firestore, flagged only.',
    },
    {
      id: 'apps2-admin-status-write',
      file: 'src/app/admin/applications/page.tsx',
      line: 308,
      collection: 'applications',
      operation: 'write',
      shape:
        'updateApplicationStatus: updateDoc(doc(db, applications, applicationId), { status, reviewedAt: serverTimestamp(), reviewedBy, reviewNotes, rejection_reason, stageHistory.<stage>: serverTimestamp() }) via src/lib/client/firestore-wrapper. Used for shortlist, reject, under_review, on_hold (every decision EXCEPT approve).',
      ruling: 'client-direct',
      note: 'Direct browser write. The adapter is server-only and no server route for these statuses is approved (approve alone goes through universal-review). Stays on Firestore. The wrapper itself is a shared lib (firestore-wrapper) and is not edited here.',
    },
    {
      id: 'apps2-admin-user-mirror-write',
      file: 'src/app/admin/applications/page.tsx',
      line: 278,
      collection: 'users',
      operation: 'write',
      shape: 'mirrorDecisionToUserAndAudit: updateDoc(doc(db, users, applicationId), { applicationStatus, hasApplied: false on reject, updatedAt }) via the firestore wrapper, plus logAuditEntry (src/lib/audit-logging.ts) writing audit_logs.',
      ruling: 'client-direct',
      note: 'Users + audit surfaces, both other clusters. Best-effort mirror shared by the direct-write path and the universal-review approve path. Left exactly as is; flagged.',
    },
    {
      id: 'apps2-admin-approve',
      file: 'src/app/admin/applications/page.tsx',
      line: 442,
      collection: 'applications (via server route)',
      operation: 'fetch PATCH',
      shape: "fetch('/api/admin/universal-review', PATCH, Bearer token, { collection: 'applications', ids: [uid], action: 'approve' }, 30s abort) -> { success, skippedAlreadyReviewed? }.",
      ruling: 'server-routed',
      note: 'Rule (a): approval already flows through a server route; request and response shapes verified unchanged. The route is another group\u2019s file and a design-verifier seam consumer.',
    },
    {
      id: 'apps2-admin-approve-stage-stamp',
      file: 'src/app/admin/applications/page.tsx',
      line: 477,
      collection: 'applications',
      operation: 'write',
      shape: 'Post-approve: updateDoc(doc(db, applications, uid), { stageHistory.<approved>: serverTimestamp() }) via the firestore wrapper, best-effort.',
      ruling: 'client-direct',
      note: 'Same blocker as apps2-admin-status-write: browser write, no approved server replacement. Left on Firestore.',
    },
    // -- src/app/admin/chapter-applications/page.tsx ------------------
    {
      id: 'apps2-chapter-listener',
      file: 'src/app/admin/chapter-applications/page.tsx',
      line: 69,
      collection: 'chapter_applications',
      operation: 'read (listener)',
      shape: 'onSnapshot(query(collection(chapter_applications), orderBy(createdAt, desc), limit(100))) -> full list state; status counts and search filtering are client-side over the snapshot.',
      ruling: 'listener',
      note: 'NEVER-BULK per brief: documented, not migrated, listener left in place exactly as is.',
    },
    {
      id: 'apps2-chapter-decision',
      file: 'src/app/admin/chapter-applications/page.tsx',
      line: 104,
      collection: 'chapter_applications (via server route)',
      operation: 'fetch PATCH',
      shape: "fetch('/api/chapter-applications', PATCH, Bearer token, { applicationId, status, ...extra, consentRequestId? }) -> { chapterId? } or a CONSENT_REQUIRED gate body.",
      ruling: 'server-routed',
      note: "Rule (a): the route is group APPS-1's file; this group only consumes it. Shape verified unchanged.",
    },
    {
      id: 'apps2-chapter-delete',
      file: 'src/app/admin/chapter-applications/page.tsx',
      line: 154,
      collection: 'chapters (via server route)',
      operation: 'fetch DELETE',
      shape: "fetch('/api/chapter-applications', DELETE, Bearer token, { chapterId, consentRequestId }) -> { usersUpdated } or a CONSENT_REQUIRED gate body.",
      ruling: 'server-routed',
      note: "Rule (a): same APPS-1 route. Shape verified unchanged.",
    },
    // -- src/app/induction/page.tsx -----------------------------------
    {
      id: 'apps2-induction-status-reads',
      file: 'src/app/induction/page.tsx',
      line: 102,
      collection: 'users + settings/induction_form',
      operation: 'read',
      shape: 'Promise.all([ getDoc(users/{uid}), getDoc(settings/induction_form) ]). Existing-application status comes from the users mirror (hasApplied / applicationStatus), NOT from the applications collection, for non-admins.',
      ruling: 'client-direct',
      note: 'Users and settings surfaces (other clusters). Fail-closed load gate for the form. Left on Firestore, flagged.',
    },
    {
      id: 'apps2-induction-admin-app-read',
      file: 'src/app/induction/page.tsx',
      line: 123,
      collection: 'applications',
      operation: 'read',
      shape: 'Super-admin-only fallback: getDoc(doc(db, applications, user.uid)) -> status, when the users mirror shows nothing.',
      ruling: 'client-direct',
      note: 'Single-doc browser read. No verifier-approved server replacement is consumed by this page today (the APPS-1 status route exists server-side but this page does not call it, and switching would change fallback semantics). Left on Firestore with this blocker note.',
    },
    {
      id: 'apps2-induction-reapply',
      file: 'src/app/induction/page.tsx',
      line: 258,
      collection: 'users',
      operation: 'write',
      shape: 'handleReapply: updateDoc(doc(db, users, uid), { hasApplied: false, applicationStatus: null, updatedAt: serverTimestamp() }), rejected applications only.',
      ruling: 'client-direct',
      note: 'Users surface. Governed by the isOwnReapply rules path. Left on Firestore, flagged.',
    },
    {
      id: 'apps2-induction-draft-read',
      file: 'src/app/induction/page.tsx',
      line: 443,
      collection: 'drafts + users',
      operation: 'read',
      shape: 'getDoc(drafts/{uid}) for the autosaved payload (with expiry check); on no draft, getDoc(users/{uid}) for profile autofill.',
      ruling: 'client-direct',
      note: 'Drafts and users surfaces, other clusters. Left on Firestore, flagged.',
    },
    {
      id: 'apps2-induction-window-check',
      file: 'src/app/induction/page.tsx',
      line: 496,
      collection: '(server route)',
      operation: 'fetch GET',
      shape: "onSubmit gate: fetch('/api/public/intake-window?kind=induction', { cache: 'no-store' }) -> { windowId, state, closesAt }; submit proceeds only when state == 'open' and stamps windowId as intakeWindowId.",
      ruling: 'server-routed',
      note: 'Rule (a): call left exactly as is.',
    },
    {
      id: 'apps2-induction-presubmit-read',
      file: 'src/app/induction/page.tsx',
      line: 564,
      collection: 'applications',
      operation: 'read',
      shape: 'getDoc(doc(db, applications, user.uid)) immediately before the submit batch, used ONLY to pick the webhook event type (create vs update). Failure is tolerated (appBefore stays null).',
      ruling: 'client-direct',
      note: 'Same blocker as apps2-induction-admin-app-read. Left on Firestore.',
    },
    {
      id: 'apps2-induction-submit-batch',
      file: 'src/app/induction/page.tsx',
      line: 620,
      collection: 'applications + users',
      operation: 'write (atomic batch)',
      shape: 'writeBatch: batch.set(applications/{uid}, applicationData) + batch.set(users/{uid}, { hasApplied: true, applicationStatus: pending, updatedAt }, { merge: true }), then one commit. applicationData strips guarded identity keys (uid, email, reviewed_by, rejection_reason, reviewed_at, pre_score, role, isAdmin) before the spread and stamps intakeWindowId after it.',
      ruling: 'client-direct',
      note: 'THE submit write path. A browser atomic batch cannot call the server adapter, and no server submit route is approved. Its identity logic is pinned by src/lib/__tests__/induction-submit-user-identity.test.ts (source-text), which this group does not alter. Any future migration needs a verifier-approved server submit route preserving batch atomicity, the guarded-key strip, and the window stamp.',
    },
    {
      id: 'apps2-induction-webhook',
      file: 'src/app/induction/page.tsx',
      line: 43,
      collection: '(server route)',
      operation: 'fetch POST',
      shape: "fireWebhook: POST /api/webhooks/dispatch { collection, docId, eventType, before, after } for applications and users after the batch, fire-and-forget.",
      ruling: 'server-routed',
      note: 'Rule (a): call left exactly as is.',
    },
    {
      id: 'apps2-induction-shared-helpers',
      file: 'src/app/induction/page.tsx',
      line: 439,
      collection: 'drafts / settings / audit_logs (via shared libs)',
      operation: 'read + write via shared libs',
      shape: 'useAutosave (src/hooks/use-autosave.ts) setDoc drafts/{uid} via the firestore wrapper; useUniversities addUniversity writes settings/induction_metadata via the wrapper; useIntakeWindow fetches /api/public/intake-window; post-submit logAuditEntry (src/lib/audit-logging.ts) writes audit_logs and deleteDoc (wrapper) removes drafts/{uid}.',
      ruling: 'shared-lib-flag-only',
      note: 'CROSS-CLUSTER FLAG: these write paths live in shared libs/hooks owned by other clusters (firestore-wrapper, audit-logging, hooks). Flagged here instead of edited, per brief.',
    },
  ]);
