# DECOMMISSION CENSUS — every remaining Firestore data-path reference

- Program: SEDS Pakistan Supabase CUTOVER (Option A), workstream: decommission census (scopes workstreams 10 client-direct-write elimination, 12 listeners elimination, the mechanical inversion wave, and 16 kill-switch).
- Tree censused: `feat/supa-cutover` @ `b1c5d5bd` (worktree `wt-supa-cut-census`, branch `feat/supa-cut-census`). Same tree as DEPLOY_READY_REPORT.md; surface names below use that report's vocabulary where a file maps to a surface, otherwise the feature is named plainly in the path itself.
- Date: 2026-10-26. Zero live reads. No code was changed; this file is the only deliverable.

## Method and reading rules

- Grep/regex census over every `.ts/.tsx/.js/.jsx/.mjs` file under `src/`, plus `functions/` and `scripts/` (reported in their own sections). Call-site counts are regex counts of the named functions in the file (client SDK: `getDoc/getDocs/getCountFromServer`, `setDoc/updateDoc/addDoc/deleteDoc`, `onSnapshot`, `writeBatch`, `runTransaction`; Admin SDK: `.collection()` chains with `.get/.set/.update/.add/.delete/.create/.batch/.runTransaction/.onSnapshot` verbs). Admin-chain verb attribution is per-file, not per-statement: a file with both an Admin `.collection()` chain and unrelated `.get(` calls can over-attribute by a small margin. Presence of a kind in a row is reliable; exact verb counts in mixed files are approximate.
- Indirection is followed one level and named in the Via column: `src/lib/client/firestore-wrapper.ts` (write/read functions with the same names as the SDK), `src/firebase/firestore/use-collection.tsx` (`useCollection`), `src/firebase/firestore/use-doc.tsx` (`useDoc`), `src/hooks/use-safe-firestore-subscription.ts`, `src/lib/firebase/firestore.ts` (timeline/projects/chapters helpers), and `src/lib/server/firebase-admin.ts` (`getDb`/`adminDb`, the server entry point imported by 235 files).
- A file with several kinds gets several rows. `TEST` rows are test files only (their base kind is shown as `TEST/<kind>`); they are excluded from every runtime count and list. `AUTH-EXEMPT` rows are Firebase Auth only (auth SDK, token verification, `__session`): Auth stays, nobody should "fix" them.
- Mention-only files (the word Firestore in a comment, type, log string, or test pin, with no data call) are NOT data paths; they are counted and listed in Appendix A so the kill-switch team can tell signal from noise.
- Direct Firestore REST data calls: none exist in `src/`. The only `firestore.googleapis.com` references are the preconnect/dns-prefetch hints in `src/app/layout.tsx` (row in the misc group).

## Summary counts (runtime, `src/` only)

- Runtime files with at least one Firestore data path: **460**
- Runtime files with any row below (data path and/or AUTH-EXEMPT): **495**
- READ: **405** runtime files (405 rows)
- WRITE: **286** runtime files (286 rows)
- LISTENER: **34** runtime files (34 rows)
- BATCH: **51** runtime files (51 rows)
- TRANSACTION: **21** runtime files (21 rows)
- AUTH-EXEMPT: **91** runtime files (91 rows)
- Test files with Firestore references (rows in the TEST section): **163** files, 204 rows
- Mention-only files (no data call, Appendix A): **547** in `src/`
- Outside `src/`: `functions/` rows: 5; `scripts/` rows: 94 (operator tooling, see its section).

### Top 20 runtime files by Firestore-call density (call sites, all kinds combined)

| # | File | Calls | Kinds | Surface |
|---|---|---|---|---|
| 1 | `src/app/api/tasks/route.ts` | 75 | BATCHx2, READx39, WRITEx34 | tasks |
| 2 | `src/lib/server/consent-service.ts` | 50 | BATCHx4, READx15, TRANSACTIONx6, WRITEx25 | compliance / discipline / consent |
| 3 | `src/lib/server/governance/firestore-stores.ts` | 44 | BATCHx1, READx29, WRITEx14 | meetings / decisions / minutes / motions / governance |
| 4 | `src/lib/server/role-writes.ts` | 41 | BATCHx2, READx12, WRITEx27 | roles / authority |
| 5 | `src/lib/finance/money-approval.ts` | 34 | BATCHx3, READx9, TRANSACTIONx2, WRITEx20 | finance |
| 6 | `src/lib/server/gamification-transaction.ts` | 32 | READx7, TRANSACTIONx2, WRITEx23 | gamification / points / badges |
| 7 | `src/app/api/profile/[userId]/route.ts` | 30 | READx19, WRITEx11 | users / identity / directory |
| 8 | `src/app/api/webhooks/firestore/route.ts` | 29 | BATCHx2, READx8, TRANSACTIONx2, WRITEx17 | webhooks |
| 9 | `src/lib/server/lifecycle-ratification.ts` | 26 | READx11, TRANSACTIONx2, WRITEx13 | misc / unclassified |
| 10 | `src/lib/server/election-domain-supa.ts` | 26 | READx9, WRITEx17 | elections / AGM / governors |
| 11 | `src/app/api/workflows/route.ts` | 26 | BATCHx1, READx17, WRITEx8 | workflows |
| 12 | `src/app/api/admin/universal-review/route.ts` | 26 | BATCHx1, READx11, WRITEx14 | inbox / submissions |
| 13 | `src/app/actions/chapter-applications.ts` | 26 | BATCHx2, READx8, WRITEx16 | intake-windows / applications |
| 14 | `src/lib/server/governors/register.ts` | 24 | BATCHx5, READx6, WRITEx13 | elections / AGM / governors |
| 15 | `src/lib/supa-events/registrations.ts` | 23 | READx8, TRANSACTIONx4, WRITEx11 | events |
| 16 | `src/lib/server/discipline/apply-decision.ts` | 23 | READx5, TRANSACTIONx6, WRITEx12 | compliance / discipline / consent |
| 17 | `src/app/api/admin/users/route.ts` | 21 | READx14, WRITEx7 | users / identity / directory |
| 18 | `src/app/api/admin/role-permissions/route.ts` | 21 | BATCHx2, READx10, WRITEx9 | workflows |
| 19 | `src/lib/server/lifecycle-vacancy.ts` | 20 | READx9, WRITEx11 | misc / unclassified |
| 20 | `src/lib/server/cadetship/create.ts` | 20 | READx8, TRANSACTIONx2, WRITEx10 | cadetships |

## (a) Every browser/client-component WRITE — workstream 10 exact scope

48 runtime client-context files perform Firestore writes (direct SDK names, via `firestore-wrapper`, Admin-named functions do not appear here; server routes/actions and shared lib files are excluded and appear in the main inventory). Presence heartbeat X4 (`enhanced-workflow-chat.tsx`) is included and is Class C STAY.

- `src/app/admin/announcements/page.tsx` — WRITEx6; targets: announcements; events; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/applications/page.tsx` — WRITEx3; targets: applications; audit_logs; settings; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/badges/page.tsx` — WRITEx3; targets: badges; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/blog/edit/page.tsx` — WRITEx1; targets: (dynamic / via ref); via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts
- `src/app/admin/blog/new/page.tsx` — WRITEx1; targets: blogs; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/chapters/page.tsx` — WRITEx1; targets: chapters; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/events/edit/page.tsx` — WRITEx3; targets: events; via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts
- `src/app/admin/events/new/page.tsx` — WRITEx2; targets: events; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/forms/page.tsx` — WRITEx3; targets: forms; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/legal-documents/page.tsx` — WRITEx1; targets: pages; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/organizations/page.tsx` — WRITEx5; targets: organizations; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/pages/contact/page.tsx` — WRITEx1; targets: pages; via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts
- `src/app/admin/pages/page.tsx` — WRITEx2; targets: pages; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/projects/page.tsx` — WRITEx2; targets: projects; users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/app/admin/resources/edit/page.tsx` — WRITEx2; targets: resources; via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts
- `src/app/admin/resources/new/page.tsx` — WRITEx1; targets: resources; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/resources/page.tsx` — WRITEx1; targets: roles; users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts, src/lib/firebase/firestore.ts
- `src/app/admin/seed/page.tsx` — WRITEx1; targets: products; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/skills/components/register-capability-modal.tsx` — WRITEx2; targets: skills; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/skills/page.tsx` — WRITEx1; targets: skills; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/store/components/certificate-settings.tsx` — WRITEx1; targets: settings; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/timeline/page.tsx` — WRITEx2; targets: timeline; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/blog/new/page.tsx` — WRITEx1; targets: blogs; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/events/new/page.tsx` — WRITEx1; targets: events; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/events/register/page.tsx` — WRITEx1; targets: events; warningConfig; via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts
- `src/app/induction/page.tsx` — WRITEx2, BATCHx1; targets: applications; drafts; settings; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/profile/unified/[uid]/page.tsx` — TRANSACTIONx2; targets: users; direct
- `src/app/terms-and-conditions/page.tsx` — WRITEx1; targets: pages; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/welcome/page.tsx` — WRITEx1; targets: users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/AnalyticsEventTracker.tsx` — WRITEx2; targets: analyticsEvents; direct
- `src/components/PageVisitTracker.tsx` — WRITEx4; targets: pageVisits; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/admin/applications/induction-form-editor.tsx` — WRITEx1; targets: settings; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/admin/discipline/discipline-settings-panel.tsx` — WRITEx1; targets: warningConfig; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/admin/events/event-attendees-panel.tsx` — WRITEx4; targets: events; users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/components/admin/inspectors/generic-inspector.tsx` — WRITEx1; targets: users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/admin/site-settings-management.tsx` — WRITEx2; targets: settings; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/admin/users/award-badge-dialog.tsx` — WRITEx1; targets: badges; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/auth/google-only-auth-form.tsx` — WRITEx4; targets: legalDocuments; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/auth/mandatory-profile-check.tsx` — WRITEx1; targets: users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/community/leaderboard.tsx` — TRANSACTIONx1; targets: badges; chapters; settings; users; direct
- `src/components/notifications/notification-center.tsx` — WRITEx2; targets: users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/components/notifications/notification-preferences.tsx` — WRITEx2; targets: users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/sections/join-us-section.tsx` — WRITEx1; targets: legalDocuments; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/workflow/enhanced-workflow-chat.tsx` — WRITEx6; targets: messages; users; workflow_members; workflow_presence; workflow_typing; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/hooks/use-autosave.ts` — WRITEx1; targets: drafts; via-helper: src/lib/client/firestore-wrapper.ts
- `src/hooks/use-universities.ts` — WRITEx2; targets: (dynamic / via ref); via-helper: src/lib/client/firestore-wrapper.ts
- `src/lib/client-actions.ts` — WRITEx1; targets: projects; via-helper: src/lib/client/firestore-wrapper.ts
- `src/lib/client/firestore-wrapper.ts` — WRITEx1; targets: (dynamic / via ref); direct

## (b) Every LISTENER still on Firestore — workstream 12 exact scope

34 runtime files hold a Firestore listener (direct `onSnapshot`, or via `useCollection`/`useDoc`/`useSafeFirestore*` — the hook definitions themselves are marked INFRA). Cross-checked against `listeners-design/BUILDOUT_REPORT.md` §5: its census found 59 `onSnapshot` text lines = 27 call sites (23 logical direct + 4 infra); this census finds the same call-site files, plus every hook-mediated consumer, which the BUILDOUT dispositions as the B-items. Class C/E STAY annotations are from that report (never-move in the listeners program; the cutover program must make its own ruling for them, they do not disappear by flipping a surface).

- `src/app/admin/blog/page.tsx` — 1 listener call(s), call site; targets: blogs; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/app/admin/certificates/page.tsx` — 1 listener call(s), call site; targets: certificates; chapters; users
- `src/app/admin/chapter-applications/page.tsx` — 1 listener call(s), call site; targets: chapter_applications
- `src/app/admin/crm/page.tsx` — 1 listener call(s), call site; targets: events; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/app/admin/events/page.tsx` — 1 listener call(s), call site; targets: events; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/app/admin/meetings/page.tsx` — 2 listener call(s), call site; targets: motions; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/app/admin/page.tsx` — 1 listener call(s), call site; targets: audit_logs
- `src/app/admin/pages/contact/page.tsx` — 1 listener call(s), call site; targets: pages; via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts
- `src/app/admin/resources/page.tsx` — 1 listener call(s), call site; targets: roles; users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts, src/lib/firebase/firestore.ts
- `src/app/admin/store/components/order-management.tsx` — 1 listener call(s), call site; targets: orders; products; users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/app/admin/submissions/page.tsx` — 5 listener call(s), call site; targets: applications; leave_requests; submissions; tasks
- `src/app/meetings/[meetingId]/page.tsx` — 2 listener call(s), call site; targets: motions; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/app/projects/page.tsx` — 1 listener call(s), call site; targets: projects; tasks; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/components/admin/applications/application-list.tsx` — 1 listener call(s), call site; targets: applications; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/components/admin/hierarchy/chapter-selector.tsx` — 1 listener call(s), call site; targets: chapters; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/components/admin/live-missions-board.tsx` — 3 listener call(s), call site; targets: audit_logs; chapters; tasks; users
- `src/components/admin/roles/role-registry.tsx` — 1 listener call(s), call site; targets: chapters; roleDefinitions — **Class E STAY (B10, roleDefinitions listener, useCollection listen:true L170)**; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/components/admin/users/user-table.tsx` — 1 listener call(s), call site; targets: chapters; leave_audit
- `src/components/auth/mandatory-profile-check.tsx` — 1 listener call(s), call site; targets: users; via-helper: src/lib/client/firestore-wrapper.ts
- `src/components/notifications/notification-center.tsx` — 1 listener call(s), call site; targets: users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/components/profile/assigned-tasks.tsx` — 2 listener call(s), call site; targets: tasks; users; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/components/profile/optimized-profile.tsx` — 1 listener call(s), call site; targets: orders
- `src/components/profile/task-detail-dialog.tsx` — 1 listener call(s), call site; targets: badges; projects; tasks; users
- `src/components/profile/user-notifications-listener.tsx` — 1 listener call(s), call site; targets: users; via-helper: src/hooks/use-safe-firestore-subscription.ts
- `src/components/profile/vacation-toggle.tsx` — 1 listener call(s), call site; targets: users; via-helper: src/firebase/firestore/use-doc.tsx (useDoc)
- `src/components/profile/workflow-visualizer.tsx` — 4 listener call(s), call site; targets: messages; tasks; users; workflow_presence — **Class C STAY (A18, BUILDOUT_REPORT §5) + B15/B16 Class D defer/delete in same dormant file**; via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/components/workflow/enhanced-workflow-chat.tsx` — 3 listener call(s), call site; targets: messages; users; workflow_members; workflow_presence; workflow_typing — **Class C STAY (A19 typing, A20 presence, B17 messages via useCollection, X4 heartbeat write)**; via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/firebase/firestore/use-collection.tsx` — 2 listener call(s), INFRA (mechanism); targets: (dynamic / via ref); via-helper: src/firebase/firestore/use-collection.tsx (useCollection)
- `src/firebase/firestore/use-doc.tsx` — 2 listener call(s), INFRA (mechanism); targets: (dynamic / via ref); via-helper: src/firebase/firestore/use-doc.tsx (useDoc)
- `src/firebase/user-provider.tsx` — 1 listener call(s), call site; targets: roles; users — **Class E STAY (A21, claims authority)**
- `src/hooks/use-role.ts` — 1 listener call(s), call site; targets: roles; users — **Class E STAY (A22, roles store)**
- `src/hooks/use-safe-firestore-subscription.ts` — 2 listener call(s), INFRA (mechanism); targets: users
- `src/lib/applications-client-supa.ts` — 2 listener call(s), call site; targets: (dynamic / via ref); via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts
- `src/lib/authority-refresh.ts` — 1 listener call(s), call site; targets: authority_refresh — **Class E STAY (A23, token-refresh signal)**; via-helper: src/lib/client/firestore-wrapper.ts

Named Class C/E stays inside the list above (BUILDOUT_REPORT §5/§7): Class C (5 items: A18, A19, A20, B17, X4) all live in `src/components/profile/workflow-visualizer.tsx` (dormant, zero importers) and `src/components/workflow/enhanced-workflow-chat.tsx`. Class E (4 items: A21 `src/firebase/user-provider.tsx`, A22 `src/hooks/use-role.ts`, A23 `src/lib/authority-refresh.ts`, B10 `src/components/admin/roles/role-registry.tsx`) is the claims/authority chain and moves atomically or not at all (F5 ruling). All other listener files above are Class A/B/D conversions or conditional stays per the BUILDOUT disposition table; the per-consumer disposition is not repeated here.

## (c) Every file that needs the kill-switch — workstream 16 exact scope

The kill-switch (Firestore disabled at the client config / Admin init / project level) changes behaviour for every runtime file with a data path: **460 files in `src/`** plus `functions/src/index.ts` (Cloud Functions, own section). The full named list is exactly the set of paths in the main inventory below (all groups, kinds READ/WRITE/LISTENER/BATCH/TRANSACTION, excluding TEST and AUTH-EXEMPT-only rows), plus these two infrastructure files which every one of them funnels through and which are therefore the actual switch points:

- `src/firebase/config.ts` + `src/firebase/core.ts` / `src/firebase/index.ts` (client app + `getFirestore` instance; client kill point)
- `src/lib/server/firebase-admin.ts` (Admin app init, `getDb`/`adminDb`; server kill point, imported by 235 files)

Named kill-switch file list (compact, alphabetical):

```
src/app/about/page.tsx
src/app/actions/chapter-applications.ts
src/app/actions/payment-methods.ts
src/app/actions/store.ts
src/app/admin/analytics/page.tsx
src/app/admin/announcements/page.tsx
src/app/admin/applications/page.tsx
src/app/admin/audit-logs/page.tsx
src/app/admin/badges/page.tsx
src/app/admin/blog/edit/page.tsx
src/app/admin/blog/new/page.tsx
src/app/admin/blog/page.tsx
src/app/admin/certificates/page.tsx
src/app/admin/chapter-applications/page.tsx
src/app/admin/chapters/page.tsx
src/app/admin/crm/page.tsx
src/app/admin/events/[id]/page.tsx
src/app/admin/events/edit/page.tsx
src/app/admin/events/new/page.tsx
src/app/admin/events/page.tsx
src/app/admin/forms/page.tsx
src/app/admin/forms/responses/page.tsx
src/app/admin/intake-windows/page.tsx
src/app/admin/legal-documents/page.tsx
src/app/admin/meetings/page.tsx
src/app/admin/organizations/page.tsx
src/app/admin/page.tsx
src/app/admin/pages/contact/page.tsx
src/app/admin/pages/page.tsx
src/app/admin/projects/page.tsx
src/app/admin/resources/edit/page.tsx
src/app/admin/resources/new/page.tsx
src/app/admin/resources/page.tsx
src/app/admin/seed/page.tsx
src/app/admin/skills/components/capability-detail-panel.tsx
src/app/admin/skills/components/register-capability-modal.tsx
src/app/admin/skills/page.tsx
src/app/admin/store/components/certificate-settings.tsx
src/app/admin/store/components/order-management.tsx
src/app/admin/store/components/product-management.tsx
src/app/admin/submissions/page.tsx
src/app/admin/superadmin/page.tsx
src/app/admin/tasks/page.tsx
src/app/admin/timeline/page.tsx
src/app/api/admin/backup-runs/route.ts
src/app/api/admin/banned-restore-report/route.ts
src/app/api/admin/blogs/[id]/route.ts
src/app/api/admin/bug-report/route.ts
src/app/api/admin/bug-reports/route.ts
src/app/api/admin/chapters/[id]/route.ts
src/app/api/admin/chapters/route.ts
src/app/api/admin/compliance/notices/[id]/intervention/route.ts
src/app/api/admin/compliance/notices/[id]/issue/route.ts
src/app/api/admin/compliance/notices/route.ts
src/app/api/admin/compliance/obligations/route.ts
src/app/api/admin/compliance/reports/route.ts
src/app/api/admin/compliance/templates/[key]/route.ts
src/app/api/admin/compliance/templates/route.ts
src/app/api/admin/compliance/triggers/list/route.ts
src/app/api/admin/compliance/triggers/route.ts
src/app/api/admin/dashboard/init/route.ts
src/app/api/admin/discipline-settings/route.ts
src/app/api/admin/email-logs/route.ts
src/app/api/admin/erasure-requests/route.ts
src/app/api/admin/events/profit-settlement/route.ts
src/app/api/admin/finance/approvals/route.ts
src/app/api/admin/finance/auditor/route.ts
src/app/api/admin/finance/budgets/route.ts
src/app/api/admin/finance/destinations/route.ts
src/app/api/admin/finance/ledger/reverse/route.ts
src/app/api/admin/finance/ledger/route.ts
src/app/api/admin/finance/receipts/deliver/route.ts
src/app/api/admin/finance/receipts/route.ts
src/app/api/admin/finance/reconciliations/complete/route.ts
src/app/api/admin/finance/reconciliations/route.ts
src/app/api/admin/finance/reports/route.ts
src/app/api/admin/founder-review/route.ts
src/app/api/admin/governors/seed/route.ts
src/app/api/admin/hierarchy/add-existing/route.ts
src/app/api/admin/hierarchy/move/route.ts
src/app/api/admin/hierarchy/relationships/route.ts
src/app/api/admin/hierarchy/user/route.ts
src/app/api/admin/hierarchy/users/route.ts
src/app/api/admin/hierarchy/workload/route.ts
src/app/api/admin/partners/analyze/route.ts
src/app/api/admin/partners/export/route.ts
src/app/api/admin/partners/related-party/route.ts
src/app/api/admin/performance-records/route.ts
src/app/api/admin/performance-reviews/[reviewId]/route.ts
src/app/api/admin/performance-reviews/route.ts
src/app/api/admin/retention-policies/route.ts
src/app/api/admin/role-permissions/route.ts
src/app/api/admin/roles/[slug]/route.ts
src/app/api/admin/roles/assign/route.ts
src/app/api/admin/roles/write/route.ts
src/app/api/admin/sync-user-role/route.ts
src/app/api/admin/universal-review/route.ts
src/app/api/admin/uploads/route.ts
src/app/api/admin/users/restore-workload/route.ts
src/app/api/admin/users/route.ts
src/app/api/ai/match-partners/route.ts
src/app/api/applications/status/route.ts
src/app/api/appointments/shared.ts
src/app/api/auth/send-welcome/route.ts
src/app/api/authors/route.ts
src/app/api/blogs/[slug]/route.ts
src/app/api/blogs/latest/route.ts
src/app/api/blogs/route.ts
src/app/api/cadetships/[id]/decision/route.ts
src/app/api/cadetships/[id]/evaluations/route.ts
src/app/api/cadetships/[id]/route.ts
src/app/api/cadetships/me/acknowledge-conduct/route.ts
src/app/api/cadetships/route.ts
src/app/api/categories/route.ts
src/app/api/chapter-applications/route.ts
src/app/api/client-errors/route.ts
src/app/api/compliance/mine/route.ts
src/app/api/compliance/obligations/[id]/evidence/route.ts
src/app/api/compliance/obligations/[id]/review/route.ts
src/app/api/compliance/obligations/[id]/route.ts
src/app/api/consents/[id]/route.ts
src/app/api/contact/route.ts
src/app/api/cron/backup/route.ts
src/app/api/cron/clear-probation/route.ts
src/app/api/cron/consent-deadlines/route.ts
src/app/api/cron/overdue/route.ts
src/app/api/cron/process-dlq/route.ts
src/app/api/cron/reconcile-roles/route.ts
src/app/api/cron/retention/route.ts
src/app/api/discipline/cases/route.ts
src/app/api/discipline/miss-records/route.ts
src/app/api/discipline/my-cases/route.ts
src/app/api/discipline/request-founder-review/route.ts
src/app/api/event-registrations/route.ts
src/app/api/events/auction/bid/route.ts
src/app/api/events/publish/route.ts
src/app/api/forms/[formId]/responses/route.ts
src/app/api/forms/route.ts
src/app/api/gallery-assets/[id]/route.ts
src/app/api/gallery-assets/route.ts
src/app/api/governance-records/[recordId]/file/route.ts
src/app/api/governance/decisions/route.ts
src/app/api/governance/meetings/[meetingId]/route.ts
src/app/api/governance/settings/route.ts
src/app/api/health/firebase/route.ts
src/app/api/leaderboard-aggregate/route.ts
src/app/api/leave/route.ts
src/app/api/messages/route.ts
src/app/api/missions/[workflowId]/route.ts
src/app/api/missions/[workflowId]/submit/[stepIndex]/route.ts
src/app/api/notifications/route.ts
src/app/api/organizations/homepage/route.ts
src/app/api/organizations/route.ts
src/app/api/positions/route.ts
src/app/api/profile/[userId]/credential-pdf/route.ts
src/app/api/profile/[userId]/credential-qr/route.ts
src/app/api/profile/[userId]/route.ts
src/app/api/profile/[userId]/telemetry/route.ts
src/app/api/profile/my-team/route.ts
src/app/api/public/portfolio/[username]/route.ts
src/app/api/public/skills-users/route.ts
src/app/api/public/skills/route.ts
src/app/api/resources/competitions/route.ts
src/app/api/resources/route.ts
src/app/api/roles/reads/route.ts
src/app/api/skills/assign-bulk/route.ts
src/app/api/skills/migrate-legacy/route.ts
src/app/api/skills/route.ts
src/app/api/sourcing/inquiries/[id]/route.ts
src/app/api/sourcing/inquiries/route.ts
src/app/api/sourcing/rfq/route.ts
src/app/api/sourcing/submit/route.ts
src/app/api/store/orders/route.ts
src/app/api/store/products/route.ts
src/app/api/submissions/route.ts
src/app/api/tasks/[id]/activity/route.ts
src/app/api/tasks/[id]/validation/route.ts
src/app/api/tasks/all/route.ts
src/app/api/tasks/attach-upload/route.ts
src/app/api/tasks/batch/route.ts
src/app/api/tasks/by-user/route.ts
src/app/api/tasks/by-workflow/route.ts
src/app/api/tasks/delegate/route.ts
src/app/api/tasks/review-queue/route.ts
src/app/api/tasks/route.ts
src/app/api/tasks/team/route.ts
src/app/api/user/post-vacation/route.ts
src/app/api/users/picker/route.ts
src/app/api/users/search/route.ts
src/app/api/v1/certificates/[id]/route.ts
src/app/api/v1/certificates/bulk-issue/route.ts
src/app/api/v1/certificates/issue/route.ts
src/app/api/v1/certificates/verify/[code]/route.ts
src/app/api/v1/chapters/invoice/route.ts
src/app/api/v1/chapters/route.ts
src/app/api/v1/roles/route.ts
src/app/api/v1/tickets/issue/route.ts
src/app/api/v1/users/certificate-eligible/route.ts
src/app/api/webhooks/firestore/route.ts
src/app/api/workflows/[id]/duplicate/route.ts
src/app/api/workflows/[id]/route.ts
src/app/api/workflows/bulk-delete/route.ts
src/app/api/workflows/route.ts
src/app/blog/new/page.tsx
src/app/blog/post/page.tsx
src/app/checkout/page.tsx
src/app/competitions/page.tsx
src/app/contact/page.tsx
src/app/donate/page.tsx
src/app/events/[slug]/_event-client.tsx
src/app/events/[slug]/page.tsx
src/app/events/detail/page.tsx
src/app/events/new/page.tsx
src/app/events/page.tsx
src/app/events/register/page.tsx
src/app/events/ticket/[ticketId]/page.tsx
src/app/induction/page.tsx
src/app/layout.tsx
src/app/meetings/[meetingId]/page.tsx
src/app/notifications/page.tsx
src/app/privacy-policy/page.tsx
src/app/profile/unified/[uid]/page.tsx
src/app/projects/detail/page.tsx
src/app/projects/page.tsx
src/app/register-chapter/page.tsx
src/app/resources/page.tsx
src/app/skills/[skillSlug]/page.tsx
src/app/tasks/[taskId]/page.tsx
src/app/terms-and-conditions/page.tsx
src/app/verify/[code]/page.tsx
src/app/welcome/page.tsx
src/app/workshops/detail/page.tsx
src/app/workshops/page.tsx
src/components/AnalyticsEventTracker.tsx
src/components/PageVisitTracker.tsx
src/components/admin/applications/application-list.tsx
src/components/admin/applications/induction-form-editor.tsx
src/components/admin/appointment-instruments-panel.tsx
src/components/admin/chapter-switcher.tsx
src/components/admin/crm/sponsor-match-panel.tsx
src/components/admin/discipline/defaulters-register.tsx
src/components/admin/discipline/discipline-settings-panel.tsx
src/components/admin/events/event-attendees-panel.tsx
src/components/admin/events/event-form.tsx
src/components/admin/hierarchy/chapter-selector.tsx
src/components/admin/hierarchy/hierarchy-graph.tsx
src/components/admin/hierarchy/role-clusters-overview.tsx
src/components/admin/inspectors/generic-inspector.tsx
src/components/admin/live-missions-board.tsx
src/components/admin/multi-select-user-combobox.tsx
src/components/admin/roles/role-permission-editor.tsx
src/components/admin/roles/role-registry.tsx
src/components/admin/site-settings-management.tsx
src/components/admin/tasks/task-form.tsx
src/components/admin/users/award-badge-dialog.tsx
src/components/admin/users/user-table.tsx
src/components/auth/google-only-auth-form.tsx
src/components/auth/mandatory-profile-check.tsx
src/components/community/leaderboard.tsx
src/components/events/event-cta.tsx
src/components/home/events-workshops-section.tsx
src/components/home/home-page-intro.tsx
src/components/home/homepage-event-feed.tsx
src/components/layout/announcement-carousel.tsx
src/components/notifications/notification-center.tsx
src/components/notifications/notification-preferences.tsx
src/components/profile/assigned-tasks.tsx
src/components/profile/optimized-profile.tsx
src/components/profile/task-detail-dialog.tsx
src/components/profile/task-history.tsx
src/components/profile/team-tasks.tsx
src/components/profile/user-notifications-listener.tsx
src/components/profile/vacation-toggle.tsx
src/components/profile/workflow-visualizer.tsx
src/components/sections/credibility-marquee.tsx
src/components/sections/featured-announcement-banner.tsx
src/components/sections/induction-hero-section.tsx
src/components/sections/join-us-section.tsx
src/components/sections/project-detail-page.tsx
src/components/sections/timeline-section.tsx
src/components/workflow/enhanced-workflow-chat.tsx
src/firebase/firestore/use-collection.tsx
src/firebase/firestore/use-doc.tsx
src/firebase/user-provider.tsx
src/hooks/use-autosave.ts
src/hooks/use-blogs-fixed.ts
src/hooks/use-blogs.ts
src/hooks/use-featured-projects.ts
src/hooks/use-organizations.ts
src/hooks/use-projects.ts
src/hooks/use-role.ts
src/hooks/use-safe-firestore-subscription.ts
src/hooks/use-site-settings.ts
src/hooks/use-universities.ts
src/hooks/use-user.ts
src/hooks/use-workshops.ts
src/lib/announcements-supa.ts
src/lib/announcements.ts
src/lib/applications-client-supa.ts
src/lib/applications-supa.ts
src/lib/audit-logging.ts
src/lib/auth/ensure-user-profile.ts
src/lib/authority-refresh.ts
src/lib/backup/engine.ts
src/lib/chapters-supa.ts
src/lib/client-actions.ts
src/lib/client/firestore-wrapper.ts
src/lib/competitions.ts
src/lib/consents/consent-config.ts
src/lib/contacts-repository.ts
src/lib/finance/adapters.ts
src/lib/finance/ledger.ts
src/lib/finance/money-approval.ts
src/lib/finance/public-org-gate.ts
src/lib/finance/supa/_shared.ts
src/lib/finance/supa/ledger-receipts-seam.ts
src/lib/finance/supa/lib-core-seam.ts
src/lib/finance/supa/money-approvals-seam.ts
src/lib/finance/supa/reconciliations-seam.ts
src/lib/finance/supa/routes-core-seam.ts
src/lib/firebase/firestore.ts
src/lib/governance/audit.ts
src/lib/governance/consent-adapter.ts
src/lib/governance/offices.ts
src/lib/governance/registration-status.ts
src/lib/inbox-supa.ts
src/lib/invite-system.ts
src/lib/mailer.ts
src/lib/notification-helper.ts
src/lib/organizations.ts
src/lib/projects-cached.ts
src/lib/projects-supa.ts
src/lib/push-notifications.ts
src/lib/retention/erasure.ts
src/lib/retention/server-deps.ts
src/lib/retention/supa-seam.ts
src/lib/role-definitions.ts
src/lib/role-management.ts
src/lib/role-request.ts
src/lib/server/admin-analytics-supa.ts
src/lib/server/agm-domain-supa.ts
src/lib/server/agm.ts
src/lib/server/blog-server.ts
src/lib/server/blog-supa.ts
src/lib/server/cadetship/access.ts
src/lib/server/cadetship/create.ts
src/lib/server/cadetship/cron-stanza.ts
src/lib/server/chapter-scoping.ts
src/lib/server/compliance-role-holders.ts
src/lib/server/compliance/access.ts
src/lib/server/compliance/cron.ts
src/lib/server/compliance/generator.ts
src/lib/server/compliance/report-service.ts
src/lib/server/compliance/supa-seam.ts
src/lib/server/consent-gate.ts
src/lib/server/consent-lookup.ts
src/lib/server/consent-service.ts
src/lib/server/crm-supa.ts
src/lib/server/cron/g1-data.ts
src/lib/server/custom-role-expiry-sweep.ts
src/lib/server/discipline/adapters-probation.ts
src/lib/server/discipline/adapters.ts
src/lib/server/discipline/apply-decision.ts
src/lib/server/discipline/case-service.ts
src/lib/server/discipline/derived-counter.ts
src/lib/server/discipline/miss-records.ts
src/lib/server/discipline/referral.ts
src/lib/server/discipline/settings.ts
src/lib/server/discipline/stanzas.ts
src/lib/server/discipline/supa-seam.ts
src/lib/server/discipline/suspension.ts
src/lib/server/discipline/vote-adapter.ts
src/lib/server/effective-role.ts
src/lib/server/election-audit.ts
src/lib/server/election-ballot.ts
src/lib/server/election-count.ts
src/lib/server/election-db.ts
src/lib/server/election-domain-supa.ts
src/lib/server/election-nominations.ts
src/lib/server/election-ports.ts
src/lib/server/election-roll.ts
src/lib/server/election-supa.ts
src/lib/server/elections.ts
src/lib/server/finance-audit.ts
src/lib/server/forms-supa.ts
src/lib/server/gamification-transaction.ts
src/lib/server/governance-audit.ts
src/lib/server/governance-settings.ts
src/lib/server/governance-votes.ts
src/lib/server/governance/decisions-supa.ts
src/lib/server/governance/firestore-stores.ts
src/lib/server/governance/meetings-supa.ts
src/lib/server/governance/meetings.ts
src/lib/server/governance/minutes-circular-supa.ts
src/lib/server/governance/motions-supa.ts
src/lib/server/governance/supa-facade.ts
src/lib/server/governors/register.ts
src/lib/server/governors/shared.ts
src/lib/server/governors/term-sweep.ts
src/lib/server/hierarchy-utils.ts
src/lib/server/hierarchy.ts
src/lib/server/intake-windows-supa.ts
src/lib/server/leave-return.ts
src/lib/server/lifecycle-adapters.ts
src/lib/server/lifecycle-probation.ts
src/lib/server/lifecycle-ratification.ts
src/lib/server/lifecycle-vacancy.ts
src/lib/server/member-lifecycle.ts
src/lib/server/mission-reads-supa.ts
src/lib/server/money-audit.ts
src/lib/server/notification-service.ts
src/lib/server/notifications-supa-seam.ts
src/lib/server/organizations-supa.ts
src/lib/server/permissions.ts
src/lib/server/phase1-flags.ts
src/lib/server/push-server.ts
src/lib/server/resources-supa.ts
src/lib/server/role-holders.ts
src/lib/server/role-writes.ts
src/lib/server/scope.ts
src/lib/server/settings-mirror.ts
src/lib/server/site-state-supa.ts
src/lib/server/skills-supa.ts
src/lib/server/supa-db-handle.ts
src/lib/server/supa-roles-reconcile-seam.ts
src/lib/server/supa-roles-seam.ts
src/lib/server/task-approval-rate.ts
src/lib/server/team-registry.ts
src/lib/server/threshold-ban.ts
src/lib/server/user-status.ts
src/lib/server/validation-audit.ts
src/lib/server/validation-notifications.ts
src/lib/server/workflow-audit.ts
src/lib/server/workflow-cascade.ts
src/lib/server/workflow-detail-supa.ts
src/lib/server/workflow-members-supa.ts
src/lib/supa-events/admin-events.ts
src/lib/supa-events/public-events.ts
src/lib/supa-events/registrations.ts
src/lib/supa-events/server-events.ts
src/lib/supa-events/tickets.ts
src/lib/supa-seams/hr-cadetships.ts
src/lib/supa-seams/hr-leave.ts
src/lib/supa-seams/profile.ts
src/lib/supa/adapter.ts
src/lib/supa/gamification.ts
src/lib/supa/index.ts
src/lib/supa/seam-admin-tasks.ts
src/lib/supa/seam-submissions.ts
src/lib/supa/seam-tasks-delegate.ts
src/lib/supa/seam-tasks-lists.ts
src/lib/supa/seam-tasks-route.ts
src/lib/supa/store-actions.ts
src/lib/supa/store-orders.ts
src/lib/supa/store-settings.ts
src/lib/task-management.ts
src/lib/task-rollup.ts
src/scripts/backfill-searchable-index.ts
src/scripts/heal-tickets-v16.js
src/scripts/migrate-email-lowercase.js
```

## Main inventory — runtime rows grouped by surface

### HR / reports

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/bug-report/route.ts` | READ | 1 | (sub)doc:siteWide; bug_reports; settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/bug-report/route.ts` | WRITE | 1 | (sub)doc:siteWide; bug_reports; settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/bug-reports/route.ts` | BATCH | 1 | bug_reports; points_ledger; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/admin/bug-reports/route.ts` | READ | 4 | bug_reports; points_ledger; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/admin/bug-reports/route.ts` | WRITE | 5 | bug_reports; points_ledger; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/threshold-ban.ts` | READ | 1 | expulsions | direct | Admin SDK chain: 1x .collection() |

### admin-analytics

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/analytics/page.tsx` | READ | 5 | analyticsEvents; pageVisits; projects; users | direct | client context |
| `src/components/AnalyticsEventTracker.tsx` | WRITE | 2 | analyticsEvents | direct | client context |
| `src/lib/server/admin-analytics-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |

### admin-audit

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/audit-logs/page.tsx` | READ | 4 | auditLogs; audit_logs | direct | client context |
| `src/app/api/admin/finance/auditor/route.ts` | BATCH | 1 | auditor_appointments | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/auditor/route.ts` | READ | 2 | auditor_appointments | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/auditor/route.ts` | WRITE | 1 | auditor_appointments | direct | Admin SDK chain: 2x .collection() |
| `src/lib/audit-logging.ts` | READ | 2 | audit_logs | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/audit-logging.ts` | WRITE | 1 | audit_logs | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/governance/audit.ts` | WRITE | 1 | audit_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/lib/server/finance-audit.ts` | WRITE | 1 | audit_logs | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/governance-audit.ts` | WRITE | 2 | audit_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/lib/server/money-audit.ts` | WRITE | 1 | audit_logs | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/validation-audit.ts` | WRITE | 2 | audit_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/workflow-audit.ts` | WRITE | 1 | workflow_audits | direct | Admin SDK chain: 1x .collection() |

### admin-dashboard

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/dashboard/init/route.ts` | READ | 8 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |

### admin-settings / site-state

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/store/components/certificate-settings.tsx` | READ | 1 | settings | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/store/components/certificate-settings.tsx` | WRITE | 1 | settings | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/admin/discipline-settings/route.ts` | WRITE | 1 | (sub)doc:discipline; settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/governance/settings/route.ts` | WRITE | 1 | (sub)doc:phase2; governance_settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/components/admin/discipline/discipline-settings-panel.tsx` | READ | 1 | warningConfig | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/discipline/discipline-settings-panel.tsx` | WRITE | 1 | warningConfig | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/site-settings-management.tsx` | READ | 2 | settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/site-settings-management.tsx` | WRITE | 2 | settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/hooks/use-site-settings.ts` | READ | 1 | settings | direct | client context |
| `src/lib/server/discipline/settings.ts` | READ | 1 | (sub)doc:discipline; settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/lib/server/governance-settings.ts` | READ | 3 | (sub)doc:phase2; governance_settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/lib/server/settings-mirror.ts` | WRITE | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/site-state-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/site-state-supa.ts` | WRITE | 1 | (dynamic / via ref) | direct | server |
| `src/lib/supa/store-settings.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |

### announcements

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/announcements/page.tsx` | READ | 2 | announcements; events | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/announcements/page.tsx` | WRITE | 6 | announcements; events | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/announcements-supa.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/announcements-supa.ts` | WRITE | 9 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/announcements.ts` | READ | 1 | announcements | direct | shared/lib |

### blog

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/blog/edit/page.tsx` | READ | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/blog/edit/page.tsx` | WRITE | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/blog/new/page.tsx` | WRITE | 1 | blogs | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/blog/page.tsx` | LISTENER | 1 | blogs | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!liveAdminOn (listener; default is listen:false) |
| `src/app/api/admin/blogs/[id]/route.ts` | READ | 3 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/blogs/[id]/route.ts` | WRITE | 2 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/blogs/[slug]/route.ts` | READ | 6 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/blogs/latest/route.ts` | READ | 2 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/blogs/route.ts` | READ | 7 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/blogs/route.ts` | WRITE | 1 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/blog/new/page.tsx` | WRITE | 1 | blogs | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/blog/post/page.tsx` | READ | 1 | blogs | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/hooks/use-blogs-fixed.ts` | READ | 2 | blogs | direct | client context |
| `src/hooks/use-blogs.ts` | READ | 1 | blogs | direct | client context |
| `src/lib/server/blog-server.ts` | READ | 4 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/lib/server/blog-server.ts` | WRITE | 2 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/lib/server/blog-supa.ts` | READ | 1 | (dynamic / via ref) | direct | server |
| `src/lib/server/blog-supa.ts` | WRITE | 3 | (dynamic / via ref) | direct | server |

### cadetships

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/cadetships/[id]/decision/route.ts` | READ | 1 | applications; evaluations | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/cadetships/[id]/decision/route.ts` | WRITE | 3 | applications; evaluations | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/cadetships/[id]/evaluations/route.ts` | READ | 1 | evaluations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cadetships/[id]/evaluations/route.ts` | WRITE | 1 | evaluations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cadetships/[id]/route.ts` | READ | 1 | evaluations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cadetships/me/acknowledge-conduct/route.ts` | READ | 1 | cadetships | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cadetships/me/acknowledge-conduct/route.ts` | WRITE | 1 | cadetships | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cadetships/route.ts` | READ | 9 | cadetships; evaluations; users | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/cadetships/route.ts` | WRITE | 3 | cadetships; evaluations; users | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/cadetship/access.ts` | READ | 3 | cadetships; roles; tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/lib/server/cadetship/create.ts` | READ | 8 | cadetships; cohort_counters; cohorts | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/cadetship/create.ts` | TRANSACTION | 2 | cadetships; cohort_counters; cohorts | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/cadetship/create.ts` | WRITE | 10 | cadetships; cohort_counters; cohorts | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/cadetship/cron-stanza.ts` | READ | 5 | cadetships; evaluations; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/cadetship/cron-stanza.ts` | WRITE | 9 | cadetships; evaluations; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/supa-seams/hr-cadetships.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-seams/hr-cadetships.ts` | WRITE | 7 | (dynamic / via ref) | direct | shared/lib |

### chapters

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/chapters/page.tsx` | READ | 2 | chapters | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/chapters/page.tsx` | WRITE | 1 | chapters | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/admin/chapters/[id]/route.ts` | READ | 1 | chapters | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/chapters/[id]/route.ts` | WRITE | 1 | chapters | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/chapters/route.ts` | READ | 1 | chapters | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/chapters/route.ts` | WRITE | 1 | chapters | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/v1/chapters/invoice/route.ts` | READ | 3 | (sub)doc:global; audit_logs; chapter_applications; users; warningConfig | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/v1/chapters/invoice/route.ts` | WRITE | 2 | (sub)doc:global; audit_logs; chapter_applications; users; warningConfig | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/v1/chapters/route.ts` | READ | 1 | chapters | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/register-chapter/page.tsx` | READ | 4 | pages; products; users; warningConfig | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/admin/chapter-switcher.tsx` | READ | 1 | chapters | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/admin/hierarchy/chapter-selector.tsx` | LISTENER | 1 | chapters | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!liveAdminOn (listener; default is listen:false) |
| `src/lib/chapters-supa.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/chapters-supa.ts` | WRITE | 6 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/server/chapter-scoping.ts` | READ | 1 | permissions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |

### compliance / discipline / consent

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/compliance/notices/[id]/intervention/route.ts` | WRITE | 5 | compliance_obligations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/notices/[id]/issue/route.ts` | READ | 1 | compliance_obligations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/notices/[id]/issue/route.ts` | TRANSACTION | 2 | compliance_obligations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/notices/[id]/issue/route.ts` | WRITE | 3 | compliance_obligations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/notices/route.ts` | READ | 1 | default_notices | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/obligations/route.ts` | READ | 8 | compliance_obligations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/reports/route.ts` | READ | 1 | compliance_reports | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/templates/[key]/route.ts` | READ | 2 | compliance_templates | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/compliance/templates/[key]/route.ts` | WRITE | 1 | compliance_templates | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/compliance/templates/route.ts` | READ | 1 | compliance_templates | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/triggers/list/route.ts` | READ | 1 | compliance_triggers | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/compliance/triggers/route.ts` | READ | 2 | compliance_obligations; compliance_templates; compliance_triggers | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/admin/compliance/triggers/route.ts` | WRITE | 2 | compliance_obligations; compliance_templates; compliance_triggers | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/admin/erasure-requests/route.ts` | READ | 1 | erasure_requests | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/compliance/mine/route.ts` | READ | 2 | compliance_obligations; roles | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/compliance/obligations/[id]/evidence/route.ts` | READ | 1 | compliance_templates | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/compliance/obligations/[id]/evidence/route.ts` | WRITE | 1 | compliance_templates | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/compliance/obligations/[id]/review/route.ts` | READ | 1 | compliance_templates | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/compliance/obligations/[id]/review/route.ts` | WRITE | 2 | compliance_templates | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/compliance/obligations/[id]/route.ts` | READ | 3 | audit_logs; compliance_templates; default_notices | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/consents/[id]/route.ts` | READ | 1 | consent_requests; history | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/discipline/cases/route.ts` | READ | 3 | disciplinary_cases | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/discipline/miss-records/route.ts` | READ | 3 | deadline_miss_records | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/discipline/my-cases/route.ts` | READ | 1 | disciplinary_cases | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/discipline/request-founder-review/route.ts` | WRITE | 1 | disciplinary_cases | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/components/admin/discipline/defaulters-register.tsx` | READ | 7 | chapters; users; warningConfig | direct | client context |
| `src/lib/consents/consent-config.ts` | READ | 1 | (sub)doc:consent_config; settings | direct | Admin SDK chain: 1x .collection() |
| `src/lib/retention/erasure.ts` | READ | 5 | points_ledger; roles; users | direct | Admin SDK chain: 3x .collection() |
| `src/lib/retention/erasure.ts` | WRITE | 7 | points_ledger; roles; users | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/compliance-role-holders.ts` | READ | 3 | roles | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/lib/server/compliance/access.ts` | READ | 3 | compliance_obligations; default_notices; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/lib/server/compliance/generator.ts` | READ | 5 | (sub)doc:generator; chapters; compliance_meta; compliance_obligations; compliance_templates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/server/compliance/generator.ts` | WRITE | 3 | (sub)doc:generator; chapters; compliance_meta; compliance_obligations; compliance_templates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/server/compliance/report-service.ts` | READ | 7 | audit_logs; compliance_obligations; compliance_reports; default_notices; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/lib/server/compliance/report-service.ts` | WRITE | 4 | audit_logs; compliance_obligations; compliance_reports; default_notices; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/lib/server/compliance/supa-seam.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/compliance/supa-seam.ts` | WRITE | 5 | (dynamic / via ref) | direct | server |
| `src/lib/server/consent-gate.ts` | READ | 1 | roleDefinitions; tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/consent-gate.ts` | WRITE | 2 | roleDefinitions; tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/consent-lookup.ts` | READ | 3 | consent_requests | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/consent-lookup.ts` | TRANSACTION | 2 | consent_requests | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/consent-lookup.ts` | WRITE | 1 | consent_requests | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/consent-service.ts` | BATCH | 4 | (sub)doc:consent_counter; audit_logs; history; settings; users | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/consent-service.ts` | READ | 15 | (sub)doc:consent_counter; audit_logs; history; settings; users | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/consent-service.ts` | TRANSACTION | 6 | (sub)doc:consent_counter; audit_logs; history; settings; users | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/consent-service.ts` | WRITE | 25 | (sub)doc:consent_counter; audit_logs; history; settings; users | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/discipline/adapters.ts` | READ | 3 | audit_logs; roles; tasks; users | direct | Admin SDK chain: 5x .collection() |
| `src/lib/server/discipline/adapters.ts` | WRITE | 3 | audit_logs; roles; tasks; users | direct | Admin SDK chain: 5x .collection() |
| `src/lib/server/discipline/apply-decision.ts` | READ | 5 | disciplinary_cases; roles; users; warnings | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/discipline/apply-decision.ts` | TRANSACTION | 6 | disciplinary_cases; roles; users; warnings | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/discipline/apply-decision.ts` | WRITE | 12 | disciplinary_cases; roles; users; warnings | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/discipline/case-service.ts` | READ | 5 | counters; disciplinary_cases; governors; users | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/discipline/case-service.ts` | TRANSACTION | 2 | counters; disciplinary_cases; governors; users | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/discipline/case-service.ts` | WRITE | 5 | counters; disciplinary_cases; governors; users | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/discipline/derived-counter.ts` | READ | 3 | disciplinary_cases; users | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/discipline/derived-counter.ts` | WRITE | 4 | disciplinary_cases; users | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/discipline/miss-records.ts` | READ | 9 | deadline_miss_records; disciplinary_cases; roles; tasks; users | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/discipline/miss-records.ts` | WRITE | 3 | deadline_miss_records; disciplinary_cases; roles; tasks; users | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/discipline/referral.ts` | WRITE | 3 | deadline_miss_records; disciplinary_cases | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/discipline/stanzas.ts` | READ | 2 | disciplinary_cases; users | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/discipline/stanzas.ts` | WRITE | 1 | disciplinary_cases; users | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/discipline/supa-seam.ts` | READ | 1 | (dynamic / via ref) | direct | server |
| `src/lib/server/discipline/suspension.ts` | READ | 2 | users | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/discipline/vote-adapter.ts` | READ | 4 | ballots; disciplinary_cases; governance_votes; governors | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/discipline/vote-adapter.ts` | WRITE | 5 | ballots; disciplinary_cases; governance_votes; governors | direct | Admin SDK chain: 8x .collection() |

### crm

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/crm/page.tsx` | LISTENER | 1 | events | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!useCrmPoll (listener; default is listen:false) |
| `src/app/admin/crm/page.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!useCrmPoll (listener; default is listen:false) |
| `src/app/api/admin/partners/analyze/route.ts` | READ | 1 | sponsors_partners | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/partners/analyze/route.ts` | WRITE | 1 | sponsors_partners | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/partners/export/route.ts` | BATCH | 1 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/partners/export/route.ts` | READ | 1 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/partners/related-party/route.ts` | BATCH | 1 | sponsors_partners | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/partners/related-party/route.ts` | READ | 2 | sponsors_partners | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/partners/related-party/route.ts` | WRITE | 1 | sponsors_partners | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/ai/match-partners/route.ts` | READ | 1 | sponsors_partners | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/components/admin/crm/sponsor-match-panel.tsx` | READ | 1 | (dynamic / via ref) | direct | client context |
| `src/lib/server/crm-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/crm-supa.ts` | WRITE | 4 | (dynamic / via ref) | direct | server |

### cron

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/cron/backup/route.ts` | READ | 9 | backup_runs | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cron/backup/route.ts` | WRITE | 3 | backup_runs | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cron/consent-deadlines/route.ts` | READ | 2 | consent_requests | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/cron/consent-deadlines/route.ts` | WRITE | 1 | consent_requests | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/cron/overdue/route.ts` | BATCH | 3 | (sub)doc:workflow; settings; tasks | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/cron/overdue/route.ts` | READ | 5 | (sub)doc:workflow; settings; tasks | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/cron/overdue/route.ts` | WRITE | 3 | (sub)doc:workflow; settings; tasks | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/cron/process-dlq/route.ts` | BATCH | 1 | dlq_points_retry; points_ledger; tasks; users | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/cron/process-dlq/route.ts` | READ | 4 | dlq_points_retry; points_ledger; tasks; users | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/cron/process-dlq/route.ts` | WRITE | 13 | dlq_points_retry; points_ledger; tasks; users | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/cron/reconcile-roles/route.ts` | READ | 1 | reconciliation_reports | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cron/reconcile-roles/route.ts` | WRITE | 1 | reconciliation_reports | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cron/retention/route.ts` | READ | 1 | audit_logs | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/cron/retention/route.ts` | WRITE | 1 | audit_logs | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/compliance/cron.ts` | READ | 5 | compliance_obligations; compliance_templates; default_notices | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/compliance/cron.ts` | WRITE | 10 | compliance_obligations; compliance_templates; default_notices | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/cron/g1-data.ts` | BATCH | 1 | tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/server/cron/g1-data.ts` | READ | 6 | tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/server/cron/g1-data.ts` | TRANSACTION | 2 | tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/server/cron/g1-data.ts` | WRITE | 7 | tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |

### elections / AGM / governors

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/governors/seed/route.ts` | READ | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/agm-domain-supa.ts` | READ | 5 | (dynamic / via ref) | direct | server |
| `src/lib/server/agm-domain-supa.ts` | WRITE | 13 | (dynamic / via ref) | direct | server |
| `src/lib/server/agm.ts` | READ | 7 | agm_documents; agm_events; auditor_appointments; notices; recipients | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/agm.ts` | WRITE | 4 | agm_documents; agm_events; auditor_appointments; notices; recipients | direct | Admin SDK chain: 14x .collection() |
| `src/lib/server/election-audit.ts` | READ | 1 | audit_logs | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/election-audit.ts` | WRITE | 1 | audit_logs | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/election-ballot.ts` | READ | 8 | ballots; cast_markers; elections; eligibility_tokens | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/election-ballot.ts` | TRANSACTION | 2 | ballots; cast_markers; elections; eligibility_tokens | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/election-ballot.ts` | WRITE | 9 | ballots; cast_markers; elections; eligibility_tokens | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/election-count.ts` | READ | 7 | elections | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/election-count.ts` | WRITE | 8 | elections | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/election-db.ts` | READ | 3 | elections | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/election-db.ts` | WRITE | 4 | elections | direct | Admin SDK chain: 3x .collection() |
| `src/lib/server/election-domain-supa.ts` | READ | 9 | (dynamic / via ref) | direct | server |
| `src/lib/server/election-domain-supa.ts` | WRITE | 17 | (dynamic / via ref) | direct | server |
| `src/lib/server/election-nominations.ts` | READ | 3 | elections; nominations | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/election-nominations.ts` | WRITE | 3 | elections; nominations | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/election-ports.ts` | READ | 4 | compliance_obligations; decision_records; election_certificate_files; governor_register_writebacks; lifecycle_notifications; notifications | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/election-ports.ts` | WRITE | 13 | compliance_obligations; decision_records; election_certificate_files; governor_register_writebacks; lifecycle_notifications; notifications | direct | Admin SDK chain: 9x .collection() |
| `src/lib/server/election-roll.ts` | READ | 2 | elections; voter_roll | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/election-roll.ts` | WRITE | 5 | elections; voter_roll | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/election-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/election-supa.ts` | WRITE | 6 | (dynamic / via ref) | direct | server |
| `src/lib/server/elections.ts` | READ | 2 | elections; nominations | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/governors/register.ts` | BATCH | 5 | consent_requests; governance_votes; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/governors/register.ts` | READ | 6 | consent_requests; governance_votes; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/governors/register.ts` | WRITE | 13 | consent_requests; governance_votes; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/governors/shared.ts` | READ | 2 | roles; users | direct | Admin SDK chain: 6x .collection() |
| `src/lib/server/governors/shared.ts` | WRITE | 6 | roles; users | direct | Admin SDK chain: 6x .collection() |
| `src/lib/server/governors/term-sweep.ts` | BATCH | 1 | roles | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/governors/term-sweep.ts` | READ | 2 | roles | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/governors/term-sweep.ts` | WRITE | 3 | roles | direct | Admin SDK chain: 1x .collection() |

### events

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/events/[id]/page.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/events/edit/page.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/events/edit/page.tsx` | WRITE | 3 | events | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/events/new/page.tsx` | WRITE | 2 | events | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/events/page.tsx` | LISTENER | 1 | events | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!liveAdminOn (listener; default is listen:false) |
| `src/app/api/admin/events/profit-settlement/route.ts` | READ | 5 | events; roles | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/admin/events/profit-settlement/route.ts` | WRITE | 2 | events; roles | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/events/auction/bid/route.ts` | WRITE | 1 | auction_bids | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/events/publish/route.ts` | READ | 2 | announcements; events | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/events/publish/route.ts` | WRITE | 2 | announcements; events | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/events/[slug]/_event-client.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/events/[slug]/page.tsx` | READ | 1 | events | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/events/detail/page.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/events/new/page.tsx` | WRITE | 1 | events | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/events/page.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/events/register/page.tsx` | READ | 3 | events; warningConfig | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener useDoc one-shot (listen:f |
| `src/app/events/register/page.tsx` | WRITE | 1 | events; warningConfig | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener useDoc one-shot (listen:f |
| `src/app/events/ticket/[ticketId]/page.tsx` | READ | 4 | eventTickets; events | direct | client context |
| `src/components/admin/events/event-attendees-panel.tsx` | READ | 4 | events; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/admin/events/event-attendees-panel.tsx` | WRITE | 4 | events; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/admin/events/event-form.tsx` | READ | 1 | products | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/events/event-cta.tsx` | READ | 2 | events; warningConfig | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/home/events-workshops-section.tsx` | READ | 1 | events | direct | client context |
| `src/lib/supa-events/admin-events.ts` | READ | 2 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-events/admin-events.ts` | WRITE | 4 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-events/public-events.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-events/public-events.ts` | WRITE | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-events/registrations.ts` | READ | 8 | (sub)doc:global; events; registrations; users; warningConfig | direct | Admin SDK chain: 6x .collection() |
| `src/lib/supa-events/registrations.ts` | TRANSACTION | 4 | (sub)doc:global; events; registrations; users; warningConfig | direct | Admin SDK chain: 6x .collection() |
| `src/lib/supa-events/registrations.ts` | WRITE | 11 | (sub)doc:global; events; registrations; users; warningConfig | direct | Admin SDK chain: 6x .collection() |
| `src/lib/supa-events/server-events.ts` | READ | 2 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-events/server-events.ts` | WRITE | 6 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-events/tickets.ts` | READ | 10 | eventTickets; events; registrations; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/supa-events/tickets.ts` | TRANSACTION | 4 | eventTickets; events; registrations; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/supa-events/tickets.ts` | WRITE | 5 | eventTickets; events; registrations; users | direct | Admin SDK chain: 11x .collection() |

### finance

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/actions/payment-methods.ts` | READ | 1 | (sub)doc:payment_methods; settings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/approvals/route.ts` | READ | 2 | money_approvals | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/budgets/route.ts` | BATCH | 2 | finance_budgets | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/admin/finance/budgets/route.ts` | READ | 7 | finance_budgets | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/admin/finance/budgets/route.ts` | WRITE | 3 | finance_budgets | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/admin/finance/destinations/route.ts` | READ | 2 | money_approvals | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/ledger/reverse/route.ts` | BATCH | 1 | ledger_entries | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/ledger/reverse/route.ts` | READ | 1 | ledger_entries | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/ledger/reverse/route.ts` | WRITE | 1 | ledger_entries | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/ledger/route.ts` | BATCH | 3 | ledger_entries; sponsors_partners | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/admin/finance/ledger/route.ts` | READ | 8 | ledger_entries; sponsors_partners | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/admin/finance/ledger/route.ts` | WRITE | 3 | ledger_entries; sponsors_partners | direct | Admin SDK chain: 4x .collection() |
| `src/app/api/admin/finance/receipts/deliver/route.ts` | BATCH | 1 | finance_receipts | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/receipts/deliver/route.ts` | READ | 1 | finance_receipts | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/receipts/deliver/route.ts` | WRITE | 1 | finance_receipts | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/receipts/route.ts` | BATCH | 1 | finance_receipts | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/receipts/route.ts` | READ | 3 | finance_receipts | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/receipts/route.ts` | WRITE | 1 | finance_receipts | direct | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/finance/reconciliations/complete/route.ts` | BATCH | 1 | finance_reconciliations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/reconciliations/complete/route.ts` | READ | 1 | finance_reconciliations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/reconciliations/complete/route.ts` | WRITE | 1 | finance_reconciliations | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/finance/reconciliations/route.ts` | BATCH | 2 | finance_reconciliations | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/finance/reconciliations/route.ts` | READ | 4 | finance_reconciliations | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/finance/reconciliations/route.ts` | WRITE | 2 | finance_reconciliations | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/finance/reports/route.ts` | BATCH | 1 | finance_budgets; ledger_entries; orders | direct | Admin SDK chain: 5x .collection() |
| `src/app/api/admin/finance/reports/route.ts` | READ | 9 | finance_budgets; ledger_entries; orders | direct | Admin SDK chain: 5x .collection() |
| `src/lib/finance/adapters.ts` | READ | 1 | compliance_obligations; consent_requests | direct | Admin SDK chain: 2x .collection() |
| `src/lib/finance/adapters.ts` | WRITE | 1 | compliance_obligations; consent_requests | direct | Admin SDK chain: 2x .collection() |
| `src/lib/finance/ledger.ts` | BATCH | 1 | (sub)doc:finance; finance_budgets; ledger_entries; settings | direct | Admin SDK chain: 5x .collection() |
| `src/lib/finance/ledger.ts` | READ | 5 | (sub)doc:finance; finance_budgets; ledger_entries; settings | direct | Admin SDK chain: 5x .collection() |
| `src/lib/finance/ledger.ts` | WRITE | 2 | (sub)doc:finance; finance_budgets; ledger_entries; settings | direct | Admin SDK chain: 5x .collection() |
| `src/lib/finance/money-approval.ts` | BATCH | 3 | (sub)doc:donate; (sub)doc:payment_methods; events; finance_budgets; finance_receipts; ledger_entries | direct | Admin SDK chain: 14x .collection() |
| `src/lib/finance/money-approval.ts` | READ | 9 | (sub)doc:donate; (sub)doc:payment_methods; events; finance_budgets; finance_receipts; ledger_entries | direct | Admin SDK chain: 14x .collection() |
| `src/lib/finance/money-approval.ts` | TRANSACTION | 2 | (sub)doc:donate; (sub)doc:payment_methods; events; finance_budgets; finance_receipts; ledger_entries | direct | Admin SDK chain: 14x .collection() |
| `src/lib/finance/money-approval.ts` | WRITE | 20 | (sub)doc:donate; (sub)doc:payment_methods; events; finance_budgets; finance_receipts; ledger_entries | direct | Admin SDK chain: 14x .collection() |
| `src/lib/finance/public-org-gate.ts` | READ | 1 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |
| `src/lib/finance/supa/_shared.ts` | WRITE | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/finance/supa/ledger-receipts-seam.ts` | READ | 6 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/finance/supa/lib-core-seam.ts` | READ | 4 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/finance/supa/lib-core-seam.ts` | WRITE | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/finance/supa/money-approvals-seam.ts` | READ | 4 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/finance/supa/reconciliations-seam.ts` | READ | 2 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/finance/supa/routes-core-seam.ts` | READ | 6 | (dynamic / via ref) | direct | shared/lib |

### forms

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/forms/page.tsx` | READ | 1 | forms | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/forms/page.tsx` | WRITE | 3 | forms | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/forms/responses/page.tsx` | READ | 2 | forms | direct | client context |
| `src/app/api/forms/[formId]/responses/route.ts` | READ | 4 | forms | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/forms/[formId]/responses/route.ts` | WRITE | 1 | forms | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/forms/route.ts` | READ | 2 | forms | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/forms/route.ts` | WRITE | 1 | forms | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/forms-supa.ts` | READ | 1 | (dynamic / via ref) | direct | server |
| `src/lib/server/forms-supa.ts` | WRITE | 2 | (dynamic / via ref) | direct | server |

### gamification / points / badges

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/badges/page.tsx` | READ | 3 | badges | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/badges/page.tsx` | WRITE | 3 | badges | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/leaderboard-aggregate/route.ts` | READ | 6 | chapters; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/components/admin/users/award-badge-dialog.tsx` | READ | 1 | badges; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/users/award-badge-dialog.tsx` | WRITE | 1 | badges; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/community/leaderboard.tsx` | READ | 4 | badges; chapters; settings; users | direct | client context |
| `src/components/community/leaderboard.tsx` | TRANSACTION | 1 | badges; chapters; settings; users | direct | client context |
| `src/lib/server/gamification-transaction.ts` | READ | 7 | activity; chapters; notifications; points_ledger; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 25x .collection() |
| `src/lib/server/gamification-transaction.ts` | TRANSACTION | 2 | activity; chapters; notifications; points_ledger; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 25x .collection() |
| `src/lib/server/gamification-transaction.ts` | WRITE | 23 | activity; chapters; notifications; points_ledger; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 25x .collection() |
| `src/lib/supa/gamification.ts` | READ | 4 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/gamification.ts` | WRITE | 4 | (dynamic / via ref) | direct | shared/lib |

### inbox / submissions

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/submissions/page.tsx` | LISTENER | 5 | applications; leave_requests; submissions; tasks | direct | client context |
| `src/app/api/admin/universal-review/route.ts` | BATCH | 1 | audit_logs; competitions; dlq_points_retry; leave_audit; leave_requests; notifications | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/api/admin/universal-review/route.ts` | READ | 11 | audit_logs; competitions; dlq_points_retry; leave_audit; leave_requests; notifications | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/api/admin/universal-review/route.ts` | WRITE | 14 | audit_logs; competitions; dlq_points_retry; leave_audit; leave_requests; notifications | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/api/submissions/route.ts` | BATCH | 2 | competitions; notifications; points_audit; roles; submissions; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 14x .collection() |
| `src/app/api/submissions/route.ts` | READ | 9 | competitions; notifications; points_audit; roles; submissions; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 14x .collection() |
| `src/app/api/submissions/route.ts` | WRITE | 8 | competitions; notifications; points_audit; roles; submissions; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 14x .collection() |
| `src/lib/inbox-supa.ts` | READ | 1 | (dynamic / via ref) | direct | server |
| `src/lib/inbox-supa.ts` | WRITE | 4 | (dynamic / via ref) | direct | server |
| `src/lib/supa/seam-submissions.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-submissions.ts` | WRITE | 3 | (dynamic / via ref) | direct | shared/lib |

### intake-windows / applications

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/actions/chapter-applications.ts` | BATCH | 2 | (sub)doc:global; audit_logs; chapter_applications; chapters; orders; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/actions/chapter-applications.ts` | READ | 8 | (sub)doc:global; audit_logs; chapter_applications; chapters; orders; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/actions/chapter-applications.ts` | WRITE | 16 | (sub)doc:global; audit_logs; chapter_applications; chapters; orders; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/admin/applications/page.tsx` | READ | 3 | applications; audit_logs; settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/applications/page.tsx` | WRITE | 3 | applications; audit_logs; settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/chapter-applications/page.tsx` | LISTENER | 1 | chapter_applications | direct | client context |
| `src/app/admin/intake-windows/page.tsx` | READ | 1 | audit_logs | direct | client context |
| `src/app/api/applications/status/route.ts` | READ | 6 | applications; cadetships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/applications/status/route.ts` | WRITE | 2 | applications; cadetships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/chapter-applications/route.ts` | READ | 4 | chapter_applications | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/induction/page.tsx` | BATCH | 1 | applications; drafts; settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/induction/page.tsx` | READ | 6 | applications; drafts; settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/induction/page.tsx` | WRITE | 2 | applications; drafts; settings; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/applications/application-list.tsx` | LISTENER | 1 | applications | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:true (listener; default is listen:false) |
| `src/components/admin/applications/induction-form-editor.tsx` | READ | 1 | settings | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/applications/induction-form-editor.tsx` | WRITE | 1 | settings | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/sections/induction-hero-section.tsx` | READ | 1 | organizations | direct | client context |
| `src/lib/applications-client-supa.ts` | LISTENER | 2 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:true (listener; default is listen:false) |
| `src/lib/applications-client-supa.ts` | READ | 10 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:true (listener; default is listen:false) |
| `src/lib/applications-client-supa.ts` | WRITE | 5 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:true (listener; default is listen:false) |
| `src/lib/applications-supa.ts` | READ | 5 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/applications-supa.ts` | WRITE | 8 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/server/intake-windows-supa.ts` | WRITE | 2 | (dynamic / via ref) | direct | server |

### leave / HR

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/cron/clear-probation/route.ts` | BATCH | 1 | (sub)doc:global; users; warningConfig; warnings | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/cron/clear-probation/route.ts` | READ | 5 | (sub)doc:global; users; warningConfig; warnings | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/cron/clear-probation/route.ts` | WRITE | 3 | (sub)doc:global; users; warningConfig; warnings | direct | Admin SDK chain: 3x .collection() |
| `src/app/api/leave/route.ts` | READ | 6 | leave_requests; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/leave/route.ts` | WRITE | 2 | leave_requests; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/discipline/adapters-probation.ts` | READ | 1 | probation_restores | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/discipline/adapters-probation.ts` | WRITE | 1 | probation_restores | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/leave-return.ts` | BATCH | 1 | activity; leave_audit; leave_requests; tasks; users | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/leave-return.ts` | READ | 5 | activity; leave_audit; leave_requests; tasks; users | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/leave-return.ts` | WRITE | 11 | activity; leave_audit; leave_requests; tasks; users | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/lifecycle-probation.ts` | READ | 10 | audit_logs; probation_restores; roles; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/lifecycle-probation.ts` | WRITE | 6 | audit_logs; probation_restores; roles; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/supa-seams/hr-leave.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa-seams/hr-leave.ts` | WRITE | 7 | (dynamic / via ref) | direct | shared/lib |

### meetings / decisions / minutes / motions / governance

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/meetings/page.tsx` | LISTENER | 2 | motions | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:true (listener; default is listen:false) useCollection with listen:true (listener; default is listen:false) |
| `src/app/api/governance-records/[recordId]/file/route.ts` | READ | 3 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/governance-records/[recordId]/file/route.ts` | WRITE | 4 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/governance/decisions/route.ts` | READ | 4 | decisions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/governance/meetings/[meetingId]/route.ts` | WRITE | 1 | meetings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/meetings/[meetingId]/page.tsx` | LISTENER | 2 | motions | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:true (listener; default is listen:false) useCollection with listen:true (listener; default is listen:false) |
| `src/lib/governance/consent-adapter.ts` | READ | 1 | consents | direct | Admin SDK chain: 1x .collection() |
| `src/lib/governance/offices.ts` | READ | 3 | notifications; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/governance/offices.ts` | WRITE | 3 | notifications; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/governance/registration-status.ts` | READ | 1 | (sub)doc:siteWide; settings | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/governance-votes.ts` | BATCH | 1 | audit_logs; ballots; governance_votes | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/governance-votes.ts` | READ | 7 | audit_logs; ballots; governance_votes | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/governance-votes.ts` | TRANSACTION | 2 | audit_logs; ballots; governance_votes | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/governance-votes.ts` | WRITE | 4 | audit_logs; ballots; governance_votes | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/governance/decisions-supa.ts` | READ | 6 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/decisions-supa.ts` | WRITE | 4 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/firestore-stores.ts` | BATCH | 1 | ballots; bodies; circular_resolutions; consent_requests; decisionClasses; decisions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 48x .collection() |
| `src/lib/server/governance/firestore-stores.ts` | READ | 29 | ballots; bodies; circular_resolutions; consent_requests; decisionClasses; decisions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 48x .collection() |
| `src/lib/server/governance/firestore-stores.ts` | WRITE | 14 | ballots; bodies; circular_resolutions; consent_requests; decisionClasses; decisions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 48x .collection() |
| `src/lib/server/governance/meetings-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/meetings.ts` | READ | 6 | bodies; consent_requests; meeting_attendance; meetings | direct | Admin SDK chain: 12x .collection() |
| `src/lib/server/governance/meetings.ts` | WRITE | 6 | bodies; consent_requests; meeting_attendance; meetings | direct | Admin SDK chain: 12x .collection() |
| `src/lib/server/governance/minutes-circular-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/minutes-circular-supa.ts` | WRITE | 3 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/motions-supa.ts` | READ | 5 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/motions-supa.ts` | WRITE | 6 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/supa-facade.ts` | READ | 1 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/supa-facade.ts` | TRANSACTION | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/governance/supa-facade.ts` | WRITE | 3 | (dynamic / via ref) | direct | server |

### misc / unclassified

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/about/page.tsx` | READ | 1 | pages | direct | client context |
| `src/app/admin/legal-documents/page.tsx` | READ | 1 | pages | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/legal-documents/page.tsx` | WRITE | 1 | pages | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/page.tsx` | LISTENER | 1 | audit_logs | direct | client context |
| `src/app/admin/pages/contact/page.tsx` | LISTENER | 1 | pages | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc with listen:!liveAdminOn (listener; default is listen:false) |
| `src/app/admin/pages/contact/page.tsx` | WRITE | 1 | pages | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc with listen:!liveAdminOn (listener; default is listen:false) |
| `src/app/admin/pages/page.tsx` | READ | 1 | pages | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/pages/page.tsx` | WRITE | 2 | pages | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/seed/page.tsx` | READ | 1 | products | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/seed/page.tsx` | WRITE | 1 | products | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/superadmin/page.tsx` | READ | 3 | audit_logs; users | direct | client context |
| `src/app/admin/timeline/page.tsx` | READ | 1 | timeline | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/timeline/page.tsx` | WRITE | 2 | timeline | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/admin/backup-runs/route.ts` | READ | 1 | backup_runs | direct | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/email-logs/route.ts` | READ | 2 | email_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/founder-review/route.ts` | READ | 4 | disciplinary_cases; points_audit; roles; users; warnings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/app/api/admin/founder-review/route.ts` | TRANSACTION | 6 | disciplinary_cases; points_audit; roles; users; warnings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/app/api/admin/founder-review/route.ts` | WRITE | 9 | disciplinary_cases; points_audit; roles; users; warnings | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/app/api/admin/performance-records/route.ts` | READ | 4 | deadline_miss_records; disciplinary_cases; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/performance-records/route.ts` | WRITE | 2 | deadline_miss_records; disciplinary_cases; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/performance-reviews/[reviewId]/route.ts` | READ | 5 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/performance-reviews/route.ts` | READ | 8 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/retention-policies/route.ts` | WRITE | 1 | audit_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/uploads/route.ts` | READ | 5 | upload_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/appointments/shared.ts` | READ | 5 | decisions; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/appointments/shared.ts` | WRITE | 2 | decisions; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/auth/send-welcome/route.ts` | WRITE | 2 | applications; leads | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/authors/route.ts` | READ | 6 | blogs; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/authors/route.ts` | WRITE | 3 | blogs; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/categories/route.ts` | READ | 3 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/categories/route.ts` | WRITE | 1 | blogs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/client-errors/route.ts` | READ | 2 | client_errors | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/client-errors/route.ts` | WRITE | 1 | client_errors | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/contact/route.ts` | READ | 4 | (sub)doc:siteWide; contactRateLimits; contactSubmissions; settings; submissions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/contact/route.ts` | WRITE | 3 | (sub)doc:siteWide; contactRateLimits; contactSubmissions; settings; submissions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/event-registrations/route.ts` | READ | 2 | events; orders | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/gallery-assets/[id]/route.ts` | WRITE | 4 | audit_logs; galleryAssets | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/gallery-assets/route.ts` | READ | 4 | audit_logs; galleryAssets | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/gallery-assets/route.ts` | WRITE | 2 | audit_logs; galleryAssets | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/health/firebase/route.ts` | READ | 3 | certificates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/messages/route.ts` | READ | 3 | messages | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/messages/route.ts` | WRITE | 1 | messages | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/positions/route.ts` | READ | 15 | audit_logs; positions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/app/api/positions/route.ts` | WRITE | 4 | audit_logs; positions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/app/api/sourcing/inquiries/[id]/route.ts` | READ | 3 | sourcing_inquiries | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/sourcing/inquiries/[id]/route.ts` | WRITE | 2 | sourcing_inquiries | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/sourcing/inquiries/route.ts` | READ | 2 | sourcing_inquiries | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/sourcing/rfq/route.ts` | READ | 1 | sourcing_rfqs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/sourcing/rfq/route.ts` | WRITE | 1 | sourcing_rfqs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/sourcing/submit/route.ts` | WRITE | 1 | sourcing_inquiries | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/checkout/page.tsx` | READ | 3 | events; forms; users | direct | client context |
| `src/app/contact/page.tsx` | READ | 1 | pages | direct | client context |
| `src/app/donate/page.tsx` | READ | 1 | pages | direct | client context |
| `src/app/layout.tsx` | READ | 0 | (dynamic / via ref) | direct | firestore.googleapis.com reference (REST or preconnect hint) |
| `src/app/privacy-policy/page.tsx` | READ | 1 | pages | direct | client context |
| `src/app/terms-and-conditions/page.tsx` | READ | 2 | pages; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/terms-and-conditions/page.tsx` | WRITE | 1 | pages; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/verify/[code]/page.tsx` | READ | 1 | products | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/welcome/page.tsx` | READ | 1 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/welcome/page.tsx` | WRITE | 1 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/workshops/detail/page.tsx` | READ | 1 | workshops | direct | client context |
| `src/app/workshops/page.tsx` | READ | 1 | events | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/PageVisitTracker.tsx` | WRITE | 4 | pageVisits | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/appointment-instruments-panel.tsx` | READ | 1 | roleHistory | direct | client context |
| `src/components/admin/inspectors/generic-inspector.tsx` | READ | 2 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/admin/inspectors/generic-inspector.tsx` | WRITE | 1 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/auth/google-only-auth-form.tsx` | READ | 4 | legalDocuments; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/auth/google-only-auth-form.tsx` | WRITE | 4 | legalDocuments; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/home/home-page-intro.tsx` | READ | 1 | pages | direct | client context |
| `src/components/home/homepage-event-feed.tsx` | READ | 1 | events | direct | client context |
| `src/components/layout/announcement-carousel.tsx` | READ | 1 | events | direct | client context |
| `src/components/sections/credibility-marquee.tsx` | READ | 1 | organizations | direct | client context |
| `src/components/sections/featured-announcement-banner.tsx` | READ | 1 | events | direct | client context |
| `src/components/sections/join-us-section.tsx` | READ | 1 | legalDocuments; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/sections/join-us-section.tsx` | WRITE | 1 | legalDocuments; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/sections/timeline-section.tsx` | READ | 1 | timeline | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/firebase/firestore/use-collection.tsx` | LISTENER | 2 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:boolean (listener; default is listen:false) |
| `src/firebase/firestore/use-collection.tsx` | READ | 2 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:boolean (listener; default is listen:false) |
| `src/firebase/firestore/use-doc.tsx` | LISTENER | 2 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc with listen:boolean (listener; default is listen:false) |
| `src/firebase/firestore/use-doc.tsx` | READ | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc with listen:boolean (listener; default is listen:false) |
| `src/hooks/use-autosave.ts` | WRITE | 1 | drafts | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/hooks/use-universities.ts` | READ | 1 | (dynamic / via ref) | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/hooks/use-universities.ts` | WRITE | 2 | (dynamic / via ref) | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/hooks/use-workshops.ts` | READ | 1 | events | direct | client context |
| `src/lib/backup/engine.ts` | READ | 1 | audit_logs; backup_runs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/backup/engine.ts` | WRITE | 4 | audit_logs; backup_runs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/client-actions.ts` | WRITE | 1 | projects | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/contacts-repository.ts` | READ | 2 | sponsors_partners | direct | shared/lib |
| `src/lib/firebase/firestore.ts` | READ | 7 | (dynamic / via ref) | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/firebase/firestore.ts` | WRITE | 9 | (dynamic / via ref) | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/invite-system.ts` | READ | 5 | applications; invites; roleDefinitions | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/invite-system.ts` | WRITE | 3 | applications; invites; roleDefinitions | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/mailer.ts` | WRITE | 1 | email_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/lib/retention/server-deps.ts` | WRITE | 1 | audit_logs | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/lib/retention/supa-seam.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/retention/supa-seam.ts` | WRITE | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/server/lifecycle-adapters.ts` | READ | 5 | (sub)doc:phase2; audit_logs; governance_settings; notifications; roles; tasks | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/lifecycle-adapters.ts` | WRITE | 4 | (sub)doc:phase2; audit_logs; governance_settings; notifications; roles; tasks | direct | Admin SDK chain: 8x .collection() |
| `src/lib/server/lifecycle-ratification.ts` | READ | 11 | audit_logs; governance_votes; ratifications; roles; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/lifecycle-ratification.ts` | TRANSACTION | 2 | audit_logs; governance_votes; ratifications; roles; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/lifecycle-ratification.ts` | WRITE | 13 | audit_logs; governance_votes; ratifications; roles; users | direct | Admin SDK chain: 11x .collection() |
| `src/lib/server/lifecycle-vacancy.ts` | READ | 9 | audit_logs; chapters; vacancies | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/lifecycle-vacancy.ts` | WRITE | 11 | audit_logs; chapters; vacancies | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/phase1-flags.ts` | READ | 1 | (sub)doc:phase1_flags; settings | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/scope.ts` | READ | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/supa-db-handle.ts` | READ | 3 | (dynamic / via ref) | direct | server |
| `src/lib/server/supa-db-handle.ts` | TRANSACTION | 1 | (dynamic / via ref) | direct | server |
| `src/lib/server/supa-db-handle.ts` | WRITE | 4 | (dynamic / via ref) | direct | server |
| `src/lib/server/team-registry.ts` | READ | 8 | roleDefinitions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/server/team-registry.ts` | WRITE | 5 | roleDefinitions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/lib/supa/adapter.ts` | READ | 4 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/adapter.ts` | WRITE | 6 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/index.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/scripts/backfill-searchable-index.ts` | BATCH | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/scripts/backfill-searchable-index.ts` | READ | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/scripts/backfill-searchable-index.ts` | WRITE | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/scripts/migrate-email-lowercase.js` | BATCH | 1 | users | direct | Admin SDK chain: 3x .collection() |
| `src/scripts/migrate-email-lowercase.js` | READ | 2 | users | direct | Admin SDK chain: 3x .collection() |
| `src/scripts/migrate-email-lowercase.js` | WRITE | 1 | users | direct | Admin SDK chain: 3x .collection() |

### notifications

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/notifications/route.ts` | READ | 4 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/notifications/route.ts` | WRITE | 4 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/notifications/page.tsx` | READ | 2 | users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/notifications/notification-center.tsx` | LISTENER | 1 | users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:enableRealtime (listener; default is listen:false) |
| `src/components/notifications/notification-center.tsx` | WRITE | 2 | users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:enableRealtime (listener; default is listen:false) |
| `src/components/notifications/notification-preferences.tsx` | READ | 1 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/notifications/notification-preferences.tsx` | WRITE | 2 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/profile/user-notifications-listener.tsx` | LISTENER | 1 | users | via-helper: src/hooks/use-safe-firestore-subscription.ts | client context |
| `src/lib/notification-helper.ts` | BATCH | 1 | notifications; users | direct | Admin SDK chain: 6x .collection() |
| `src/lib/notification-helper.ts` | READ | 1 | notifications; users | direct | Admin SDK chain: 6x .collection() |
| `src/lib/notification-helper.ts` | WRITE | 3 | notifications; users | direct | Admin SDK chain: 6x .collection() |
| `src/lib/push-notifications.ts` | WRITE | 2 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/server/notification-service.ts` | BATCH | 1 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/notification-service.ts` | READ | 2 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/notification-service.ts` | WRITE | 3 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/notifications-supa-seam.ts` | WRITE | 7 | (dynamic / via ref) | direct | server |
| `src/lib/server/push-server.ts` | READ | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/push-server.ts` | WRITE | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/validation-notifications.ts` | READ | 2 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/lib/server/validation-notifications.ts` | WRITE | 7 | notifications; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |

### organizations

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/organizations/page.tsx` | READ | 1 | organizations | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/organizations/page.tsx` | WRITE | 5 | organizations | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/organizations/homepage/route.ts` | READ | 3 | organizations | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/organizations/homepage/route.ts` | WRITE | 1 | organizations | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/organizations/route.ts` | READ | 3 | organizations | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/organizations/route.ts` | WRITE | 1 | organizations | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/hooks/use-organizations.ts` | READ | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/lib/organizations.ts` | READ | 1 | organizations | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/organizations.ts` | WRITE | 4 | organizations | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/server/organizations-supa.ts` | WRITE | 1 | (dynamic / via ref) | direct | server |

### projects

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/projects/page.tsx` | READ | 2 | projects; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/projects/page.tsx` | WRITE | 2 | projects; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/projects/detail/page.tsx` | READ | 2 | tasks; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/firebase/firestore/use-doc.tsx (useDoc), src/lib/firebase/firestore.ts | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener consumes timeline/project |
| `src/app/projects/page.tsx` | LISTENER | 1 | projects; tasks | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/projects/page.tsx` | READ | 3 | projects; tasks | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/sections/project-detail-page.tsx` | READ | 2 | projects | direct | client context |
| `src/hooks/use-featured-projects.ts` | READ | 2 | projects | direct | client context |
| `src/hooks/use-projects.ts` | READ | 2 | projects | direct | client context |
| `src/lib/projects-cached.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/projects-supa.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/projects-supa.ts` | WRITE | 9 | (dynamic / via ref) | direct | shared/lib |

### resources / competitions

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/resources/edit/page.tsx` | READ | 1 | resources | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/resources/edit/page.tsx` | WRITE | 2 | resources | via-helper: src/firebase/firestore/use-doc.tsx (useDoc), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useDoc one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/admin/resources/new/page.tsx` | WRITE | 1 | resources | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/resources/page.tsx` | LISTENER | 1 | roles; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts, src/lib/firebase/firestore.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:!liveAdminOn (listener; default is listen:false) consumes timeline/projects/chapter |
| `src/app/admin/resources/page.tsx` | READ | 4 | roles; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts, src/lib/firebase/firestore.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:!liveAdminOn (listener; default is listen:false) consumes timeline/projects/chapter |
| `src/app/admin/resources/page.tsx` | WRITE | 1 | roles; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts, src/lib/firebase/firestore.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:!liveAdminOn (listener; default is listen:false) consumes timeline/projects/chapter |
| `src/app/api/resources/competitions/route.ts` | READ | 2 | competitions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/resources/route.ts` | READ | 2 | resources | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/resources/route.ts` | WRITE | 1 | resources | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/competitions/page.tsx` | READ | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/app/resources/page.tsx` | READ | 1 | resources | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/lib/competitions.ts` | WRITE | 3 | competitions | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/server/resources-supa.ts` | WRITE | 2 | (dynamic / via ref) | direct | server |

### roles / authority

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/hierarchy/add-existing/route.ts` | READ | 2 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/hierarchy/add-existing/route.ts` | WRITE | 2 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/hierarchy/move/route.ts` | READ | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/hierarchy/move/route.ts` | TRANSACTION | 2 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/hierarchy/move/route.ts` | WRITE | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/admin/hierarchy/relationships/route.ts` | BATCH | 1 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/admin/hierarchy/relationships/route.ts` | READ | 8 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/admin/hierarchy/relationships/route.ts` | WRITE | 4 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/admin/hierarchy/user/route.ts` | READ | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/hierarchy/user/route.ts` | WRITE | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/hierarchy/users/route.ts` | READ | 4 | reporting_relationships; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/hierarchy/workload/route.ts` | READ | 9 | reporting_relationships; roleDefinitions; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/admin/hierarchy/workload/route.ts` | WRITE | 8 | reporting_relationships; roleDefinitions; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/admin/roles/[slug]/route.ts` | BATCH | 1 | audit_logs; permissions; roleDefinitions; role_permissions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/admin/roles/[slug]/route.ts` | READ | 7 | audit_logs; permissions; roleDefinitions; role_permissions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/admin/roles/[slug]/route.ts` | WRITE | 5 | audit_logs; permissions; roleDefinitions; role_permissions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/admin/roles/assign/route.ts` | READ | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/roles/write/route.ts` | READ | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/roles/write/route.ts` | WRITE | 1 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/sync-user-role/route.ts` | READ | 1 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/admin/sync-user-role/route.ts` | WRITE | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/roles/reads/route.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/app/api/roles/reads/route.ts` | WRITE | 4 | (dynamic / via ref) | direct | server |
| `src/app/api/v1/roles/route.ts` | READ | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/v1/roles/route.ts` | WRITE | 4 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/components/admin/hierarchy/hierarchy-graph.tsx` | READ | 2 | roles; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/admin/hierarchy/role-clusters-overview.tsx` | READ | 1 | chapters | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener |
| `src/components/admin/roles/role-registry.tsx` | LISTENER | 1 | chapters; roleDefinitions | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:true (listener; default is listen:false) |
| `src/components/admin/roles/role-registry.tsx` | READ | 2 | chapters; roleDefinitions | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:true (listener; default is listen:false) |
| `src/hooks/use-role.ts` | LISTENER | 1 | roles; users | direct | client context |
| `src/hooks/use-role.ts` | READ | 3 | roles; users | direct | client context |
| `src/lib/authority-refresh.ts` | LISTENER | 1 | authority_refresh | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/authority-refresh.ts` | WRITE | 2 | authority_refresh | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/role-definitions.ts` | READ | 1 | (dynamic / via ref) | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/role-definitions.ts` | WRITE | 1 | (dynamic / via ref) | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/role-management.ts` | READ | 4 | roles; users | direct | shared/lib |
| `src/lib/role-request.ts` | READ | 3 | role_requests | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/role-request.ts` | WRITE | 3 | role_requests | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/server/custom-role-expiry-sweep.ts` | READ | 3 | roleDefinitions; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/custom-role-expiry-sweep.ts` | WRITE | 1 | roleDefinitions; roles; users | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/effective-role.ts` | READ | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/effective-role.ts` | WRITE | 1 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/hierarchy-utils.ts` | READ | 2 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/hierarchy-utils.ts` | WRITE | 1 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/hierarchy.ts` | BATCH | 1 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/lib/server/hierarchy.ts` | READ | 8 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/lib/server/hierarchy.ts` | WRITE | 5 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/lib/server/role-holders.ts` | READ | 2 | roles | direct | Admin SDK chain: 2x .collection() |
| `src/lib/server/role-writes.ts` | BATCH | 2 | audit_logs; authority_refresh; roleDefinitions; roles; users | direct | Admin SDK chain: 16x .collection() |
| `src/lib/server/role-writes.ts` | READ | 12 | audit_logs; authority_refresh; roleDefinitions; roles; users | direct | Admin SDK chain: 16x .collection() |
| `src/lib/server/role-writes.ts` | WRITE | 27 | audit_logs; authority_refresh; roleDefinitions; roles; users | direct | Admin SDK chain: 16x .collection() |
| `src/lib/server/supa-roles-reconcile-seam.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/supa-roles-reconcile-seam.ts` | WRITE | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/supa-roles-seam.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/supa-roles-seam.ts` | WRITE | 7 | (dynamic / via ref) | direct | server |

### skills

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/skills/components/capability-detail-panel.tsx` | READ | 1 | events | direct | client context |
| `src/app/admin/skills/components/register-capability-modal.tsx` | WRITE | 2 | skills | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/skills/page.tsx` | WRITE | 1 | skills | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/public/skills-users/route.ts` | READ | 2 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/public/skills/route.ts` | READ | 6 | skills | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/public/skills/route.ts` | WRITE | 1 | skills | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/skills/assign-bulk/route.ts` | BATCH | 1 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/skills/assign-bulk/route.ts` | READ | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/skills/assign-bulk/route.ts` | WRITE | 1 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/skills/migrate-legacy/route.ts` | READ | 2 | skills | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/skills/migrate-legacy/route.ts` | WRITE | 4 | skills | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/skills/route.ts` | BATCH | 1 | events; roles; skills; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/skills/route.ts` | READ | 11 | events; roles; skills; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/skills/route.ts` | WRITE | 5 | events; roles; skills; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/skills/[skillSlug]/page.tsx` | READ | 2 | skills; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/skills-supa.ts` | READ | 3 | (dynamic / via ref) | direct | server |
| `src/lib/server/skills-supa.ts` | WRITE | 5 | (dynamic / via ref) | direct | server |

### store (products/settings/actions/orders)

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/actions/store.ts` | READ | 11 | (sub)doc:global; (sub)doc:siteWide; audit_logs; chapter_applications; events; orders | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 20x .collection() |
| `src/app/actions/store.ts` | WRITE | 8 | (sub)doc:global; (sub)doc:siteWide; audit_logs; chapter_applications; events; orders | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 20x .collection() |
| `src/app/admin/certificates/page.tsx` | LISTENER | 1 | certificates; chapters; users | direct | client context |
| `src/app/admin/certificates/page.tsx` | READ | 4 | certificates; chapters; users | direct | client context |
| `src/app/admin/store/components/order-management.tsx` | LISTENER | 1 | orders; products; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/store/components/order-management.tsx` | READ | 3 | orders; products; users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/admin/store/components/product-management.tsx` | READ | 2 | events; forms | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/app/api/admin/banned-restore-report/route.ts` | READ | 2 | (sub)doc:global; audit_logs; users; warningConfig | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/banned-restore-report/route.ts` | WRITE | 1 | (sub)doc:global; audit_logs; users; warningConfig | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/admin/users/restore-workload/route.ts` | BATCH | 1 | activity; audit_logs; leave_audit; leave_requests; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/admin/users/restore-workload/route.ts` | READ | 3 | activity; audit_logs; leave_audit; leave_requests; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/admin/users/restore-workload/route.ts` | WRITE | 8 | activity; audit_logs; leave_audit; leave_requests; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/store/orders/route.ts` | BATCH | 1 | orders; products | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/store/orders/route.ts` | READ | 13 | orders; products | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/store/orders/route.ts` | WRITE | 2 | orders; products | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 6x .collection() |
| `src/app/api/store/products/route.ts` | BATCH | 2 | audit_logs; products | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/store/products/route.ts` | READ | 8 | audit_logs; products | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/store/products/route.ts` | WRITE | 5 | audit_logs; products | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/v1/certificates/[id]/route.ts` | READ | 7 | certificate_public; certificates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/v1/certificates/[id]/route.ts` | WRITE | 4 | certificate_public; certificates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/v1/certificates/bulk-issue/route.ts` | BATCH | 2 | certificate_public; certificates; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/v1/certificates/bulk-issue/route.ts` | READ | 4 | certificate_public; certificates; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/v1/certificates/bulk-issue/route.ts` | WRITE | 3 | certificate_public; certificates; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/v1/certificates/issue/route.ts` | READ | 6 | certificate_public; certificates; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/v1/certificates/issue/route.ts` | WRITE | 2 | certificate_public; certificates; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/v1/certificates/verify/[code]/route.ts` | READ | 2 | certificates; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/v1/users/certificate-eligible/route.ts` | READ | 11 | chapters; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/v1/users/certificate-eligible/route.ts` | WRITE | 2 | chapters; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/hooks/use-safe-firestore-subscription.ts` | LISTENER | 2 | users | direct | Admin SDK chain: 1x .collection() |
| `src/lib/client/firestore-wrapper.ts` | WRITE | 1 | (dynamic / via ref) | direct | client context |
| `src/lib/supa/store-actions.ts` | READ | 2 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/store-orders.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |

### tasks

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/admin/tasks/page.tsx` | READ | 3 | chapters; tasks; users | direct | client context |
| `src/app/api/tasks/[id]/activity/route.ts` | READ | 7 | activity; notifications; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/tasks/[id]/activity/route.ts` | WRITE | 7 | activity; notifications; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/tasks/[id]/validation/route.ts` | READ | 1 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/all/route.ts` | READ | 2 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/attach-upload/route.ts` | READ | 2 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/attach-upload/route.ts` | WRITE | 2 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/batch/route.ts` | BATCH | 1 | roles; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/tasks/batch/route.ts` | READ | 1 | roles; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/tasks/batch/route.ts` | WRITE | 2 | roles; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/tasks/by-user/route.ts` | READ | 5 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/by-user/route.ts` | WRITE | 1 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/delegate/route.ts` | BATCH | 1 | activity; notifications; tasks; users; workflow_members | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/tasks/delegate/route.ts` | READ | 5 | activity; notifications; tasks; users; workflow_members | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/tasks/delegate/route.ts` | WRITE | 11 | activity; notifications; tasks; users; workflow_members | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 10x .collection() |
| `src/app/api/tasks/review-queue/route.ts` | READ | 4 | tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/tasks/review-queue/route.ts` | WRITE | 2 | tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/tasks/route.ts` | BATCH | 2 | activity; dlq_points_retry; notifications; projects; roles; tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 48x .collection() |
| `src/app/api/tasks/route.ts` | READ | 39 | activity; dlq_points_retry; notifications; projects; roles; tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 48x .collection() |
| `src/app/api/tasks/route.ts` | WRITE | 34 | activity; dlq_points_retry; notifications; projects; roles; tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 48x .collection() |
| `src/app/api/tasks/team/route.ts` | READ | 8 | reporting_relationships; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/api/tasks/team/route.ts` | WRITE | 9 | reporting_relationships; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 5x .collection() |
| `src/app/tasks/[taskId]/page.tsx` | READ | 1 | tasks | direct | client context |
| `src/components/admin/tasks/task-form.tsx` | READ | 3 | badges; chapters; projects | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener useCollection one-shot (listen:false or default); one-shot READ via helper, not a listener useCollection one- |
| `src/components/profile/assigned-tasks.tsx` | LISTENER | 2 | tasks; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!initialTasks (listener; default is listen:false) useCollection with listen:!initialTasks (listener; default is listen:false) |
| `src/components/profile/assigned-tasks.tsx` | READ | 1 | tasks; users | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:!initialTasks (listener; default is listen:false) useCollection with listen:!initialTasks (listener; default is listen:false) |
| `src/components/profile/task-detail-dialog.tsx` | LISTENER | 1 | badges; projects; tasks; users | direct | client context |
| `src/components/profile/task-detail-dialog.tsx` | READ | 4 | badges; projects; tasks; users | direct | client context |
| `src/components/profile/task-history.tsx` | READ | 3 | tasks | direct | client context |
| `src/components/profile/team-tasks.tsx` | READ | 1 | tasks | direct | client context |
| `src/lib/server/task-approval-rate.ts` | READ | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `src/lib/server/task-approval-rate.ts` | WRITE | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `src/lib/supa/seam-admin-tasks.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-admin-tasks.ts` | WRITE | 5 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-tasks-delegate.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-tasks-delegate.ts` | WRITE | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-tasks-lists.ts` | READ | 2 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-tasks-lists.ts` | WRITE | 4 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-tasks-route.ts` | READ | 1 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/supa/seam-tasks-route.ts` | WRITE | 5 | (dynamic / via ref) | direct | shared/lib |
| `src/lib/task-management.ts` | READ | 5 | tasks | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/task-management.ts` | WRITE | 4 | tasks | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/lib/task-rollup.ts` | READ | 1 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/task-rollup.ts` | WRITE | 1 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |

### tickets

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/v1/tickets/issue/route.ts` | READ | 3 | events; orders; registrations; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/v1/tickets/issue/route.ts` | WRITE | 1 | events; orders; registrations; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/scripts/heal-tickets-v16.js` | READ | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `src/scripts/heal-tickets-v16.js` | WRITE | 2 | users | direct | Admin SDK chain: 1x .collection() |

### users / identity / directory

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/users/route.ts` | READ | 14 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/app/api/admin/users/route.ts` | WRITE | 7 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 8x .collection() |
| `src/app/api/profile/[userId]/credential-pdf/route.ts` | READ | 2 | certificates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/profile/[userId]/credential-qr/route.ts` | READ | 2 | certificates | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/profile/[userId]/route.ts` | READ | 19 | badges; certificates; chapters; projects; reporting_relationships; roles | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/api/profile/[userId]/route.ts` | WRITE | 11 | badges; certificates; chapters; projects; reporting_relationships; roles | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 17x .collection() |
| `src/app/api/profile/[userId]/telemetry/route.ts` | READ | 8 | (sub)doc:global; certificates; points_ledger; tasks; users; warningConfig | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/profile/[userId]/telemetry/route.ts` | WRITE | 3 | (sub)doc:global; certificates; points_ledger; tasks; users; warningConfig | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/app/api/profile/my-team/route.ts` | READ | 5 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/profile/my-team/route.ts` | WRITE | 5 | reporting_relationships; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/public/portfolio/[username]/route.ts` | READ | 7 | certificates; skills; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/app/api/public/portfolio/[username]/route.ts` | WRITE | 1 | certificates; skills; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 7x .collection() |
| `src/app/api/user/post-vacation/route.ts` | READ | 3 | leave_requests; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `src/app/api/users/picker/route.ts` | READ | 7 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/users/picker/route.ts` | WRITE | 2 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/users/search/route.ts` | READ | 3 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/profile/unified/[uid]/page.tsx` | READ | 1 | users | direct | client context |
| `src/app/profile/unified/[uid]/page.tsx` | TRANSACTION | 2 | users | direct | client context |
| `src/components/admin/multi-select-user-combobox.tsx` | READ | 2 | chapters; users | direct | client context |
| `src/components/admin/users/user-table.tsx` | LISTENER | 1 | chapters; leave_audit | direct | client context |
| `src/components/admin/users/user-table.tsx` | READ | 1 | chapters; leave_audit | direct | client context |
| `src/components/auth/mandatory-profile-check.tsx` | LISTENER | 1 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/auth/mandatory-profile-check.tsx` | WRITE | 1 | users | via-helper: src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly |
| `src/components/profile/optimized-profile.tsx` | LISTENER | 1 | orders | direct | client context |
| `src/components/profile/vacation-toggle.tsx` | LISTENER | 1 | users | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc with listen:true (listener; default is listen:false) |
| `src/components/profile/vacation-toggle.tsx` | READ | 1 | users | via-helper: src/firebase/firestore/use-doc.tsx (useDoc) | useDoc with listen:true (listener; default is listen:false) |
| `src/firebase/user-provider.tsx` | LISTENER | 1 | roles; users | direct | client context |
| `src/firebase/user-provider.tsx` | READ | 1 | roles; users | direct | client context |
| `src/hooks/use-user.ts` | READ | 1 | roles | direct | client context |
| `src/lib/auth/ensure-user-profile.ts` | READ | 1 | users | direct | shared/lib |
| `src/lib/auth/ensure-user-profile.ts` | WRITE | 2 | users | direct | shared/lib |
| `src/lib/server/member-lifecycle.ts` | BATCH | 1 | audit_logs; positions; role_history; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/lib/server/member-lifecycle.ts` | READ | 6 | audit_logs; positions; role_history; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/lib/server/member-lifecycle.ts` | WRITE | 10 | audit_logs; positions; role_history; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `src/lib/server/user-status.ts` | READ | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/lib/supa-seams/profile.ts` | READ | 3 | (dynamic / via ref) | direct | shared/lib |

### webhooks

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/webhooks/firestore/route.ts` | BATCH | 2 | (sub)doc:leaderboard; activity; audit_logs; badges; cache; notifications | direct | Admin SDK chain: 25x .collection() |
| `src/app/api/webhooks/firestore/route.ts` | READ | 8 | (sub)doc:leaderboard; activity; audit_logs; badges; cache; notifications | direct | Admin SDK chain: 25x .collection() |
| `src/app/api/webhooks/firestore/route.ts` | TRANSACTION | 2 | (sub)doc:leaderboard; activity; audit_logs; badges; cache; notifications | direct | Admin SDK chain: 25x .collection() |
| `src/app/api/webhooks/firestore/route.ts` | WRITE | 17 | (sub)doc:leaderboard; activity; audit_logs; badges; cache; notifications | direct | Admin SDK chain: 25x .collection() |

### workflows

| File | Kind | Calls | Firestore target (collection pattern) | Direct / via-helper | Note |
|---|---|---|---|---|---|
| `src/app/api/admin/role-permissions/route.ts` | BATCH | 2 | chapters; permissions; roleDefinitions; role_permissions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 14x .collection() |
| `src/app/api/admin/role-permissions/route.ts` | READ | 10 | chapters; permissions; roleDefinitions; role_permissions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 14x .collection() |
| `src/app/api/admin/role-permissions/route.ts` | WRITE | 9 | chapters; permissions; roleDefinitions; role_permissions; roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 14x .collection() |
| `src/app/api/missions/[workflowId]/route.ts` | READ | 4 | chapters; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/missions/[workflowId]/submit/[stepIndex]/route.ts` | READ | 2 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/tasks/by-workflow/route.ts` | READ | 2 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/workflows/[id]/duplicate/route.ts` | BATCH | 1 | tasks; workflow_members | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/workflows/[id]/duplicate/route.ts` | READ | 2 | tasks; workflow_members | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/workflows/[id]/duplicate/route.ts` | WRITE | 4 | tasks; workflow_members | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 4x .collection() |
| `src/app/api/workflows/[id]/route.ts` | READ | 4 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/app/api/workflows/bulk-delete/route.ts` | READ | 1 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `src/app/api/workflows/route.ts` | BATCH | 1 | chapters; notifications; roles; tasks; users; workflow_audits | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 18x .collection() |
| `src/app/api/workflows/route.ts` | READ | 17 | chapters; notifications; roles; tasks; users; workflow_audits | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 18x .collection() |
| `src/app/api/workflows/route.ts` | WRITE | 8 | chapters; notifications; roles; tasks; users; workflow_audits | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 18x .collection() |
| `src/components/admin/live-missions-board.tsx` | LISTENER | 3 | audit_logs; chapters; tasks; users | direct | client context |
| `src/components/admin/live-missions-board.tsx` | READ | 1 | audit_logs; chapters; tasks; users | direct | client context |
| `src/components/admin/roles/role-permission-editor.tsx` | READ | 2 | chapters; roleDefinitions | direct | client context |
| `src/components/profile/workflow-visualizer.tsx` | LISTENER | 4 | messages; tasks; users; workflow_presence | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:realtime (listener; default is listen:false) useCollection with listen:realtime (listener; default is listen:false) useCollection with listen:realtime (listener; default is l |
| `src/components/profile/workflow-visualizer.tsx` | READ | 1 | messages; tasks; users; workflow_presence | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) | useCollection with listen:realtime (listener; default is listen:false) useCollection with listen:realtime (listener; default is listen:false) useCollection with listen:realtime (listener; default is l |
| `src/components/workflow/enhanced-workflow-chat.tsx` | LISTENER | 3 | messages; users; workflow_members; workflow_presence; workflow_typing | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:allowRealtime (listener; default is listen:false) |
| `src/components/workflow/enhanced-workflow-chat.tsx` | READ | 2 | messages; users; workflow_members; workflow_presence; workflow_typing | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:allowRealtime (listener; default is listen:false) |
| `src/components/workflow/enhanced-workflow-chat.tsx` | WRITE | 6 | messages; users; workflow_members; workflow_presence; workflow_typing | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/lib/client/firestore-wrapper.ts | setDoc/updateDoc/addDoc/deleteDoc/getDoc imported from firestore-wrapper, not SDK directly useCollection with listen:allowRealtime (listener; default is listen:false) |
| `src/lib/server/mission-reads-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/mission-reads-supa.ts` | WRITE | 3 | (dynamic / via ref) | direct | server |
| `src/lib/server/permissions.ts` | READ | 3 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/permissions.ts` | WRITE | 1 | roles; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 2x .collection() |
| `src/lib/server/workflow-cascade.ts` | BATCH | 1 | tasks; workflow_members; workflows | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/workflow-cascade.ts` | READ | 4 | tasks; workflow_members; workflows | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/workflow-cascade.ts` | WRITE | 1 | tasks; workflow_members; workflows | direct | Admin SDK chain: 4x .collection() |
| `src/lib/server/workflow-detail-supa.ts` | READ | 2 | (dynamic / via ref) | direct | server |
| `src/lib/server/workflow-detail-supa.ts` | WRITE | 3 | (dynamic / via ref) | direct | server |
| `src/lib/server/workflow-members-supa.ts` | READ | 1 | (dynamic / via ref) | direct | server |
| `src/lib/server/workflow-members-supa.ts` | WRITE | 3 | (dynamic / via ref) | direct | server |

## AUTH-EXEMPT — Firebase Auth usage (stays; do not migrate)

| File | Auth refs | Note |
|---|---|---|
| `src/app/admin/email-logs/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/admin/governors/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/admin/organizations/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/admin/role-privileges/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/admin/uploads/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/api/admin/partners/analyze/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/admin/uploads/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/ai-task-generator/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/api/announcements/visible/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/api/applications/status/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/chapter-applications/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/client-errors/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/event-registrations/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/events/publish/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/forms/[formId]/responses/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/forms/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/messages/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/missions/[workflowId]/submit/[stepIndex]/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/organizations/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/positions/route.ts` | 4 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/projects/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/api/resources/competitions/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/resources/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/roles/reads/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/skills/assign-bulk/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/skills/migrate-legacy/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/skills/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/sourcing/get-upload-url/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/api/sourcing/inquiries/[id]/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/sourcing/inquiries/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/store/orders/route.ts` | 4 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/store/products/route.ts` | 4 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/tasks/attach-upload/route.ts` | 4 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/tasks/route.ts` | 5 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/v1/certificates/[id]/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/v1/certificates/bulk-issue/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/v1/certificates/issue/route.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/v1/tickets/issue/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/v1/users/certificate-eligible/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/webhooks/firestore/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/api/workflows/route.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/induction/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/profile/page.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/registerForEvent/route.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/app/tasks/[taskId]/page.tsx` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/admin/admin-sidebar.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/admin/bug-report-button.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/admin/hierarchy/add-person-modal.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/admin/hierarchy/hierarchy-canvas.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/admin/hierarchy/role-clusters-overview.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/admin/hierarchy/smart-user-search.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/admin/roles/role-permission-editor.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/admin/tasks/task-form.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/admin/universal/admin-approval-table.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/applicant-status/applicant-portal.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/auth/google-only-auth-form.tsx` | 10 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/auth/with-admin-protection.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/profile/assigned-tasks.tsx` | 4 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/profile/delegate-task-dialog.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/profile/my-team.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/profile/optimized-profile.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/profile/task-detail-dialog.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/profile/team-tasks.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/components/profile/workflow-steps-inline.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/components/sections/join-us-section.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/firebase/core.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/firebase/provider.tsx` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/firebase/user-provider.tsx` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/hooks/use-my-reports.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/hooks/use-role-permissions.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/hooks/use-user.ts` | 8 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/announcements-supa.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/auth-middleware.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/auth/ensure-user-profile.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/auth/verifySession.ts` | 5 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/authority-refresh.ts` | 3 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/client-actions.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/client/firestore-wrapper.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/crm-supa-client.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/inbox-supa.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/partners.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/projects-supa.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/role-management.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/server/finance-http.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/server/founder-gate.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/server/governance/route-helpers.ts` | 6 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/server/role-writes.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/lib/supa-roles-client-seam.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `src/lib/task-management.ts` | 1 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `src/middleware.ts` | 2 | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |

## Indirect — `useFirestore()` instance passed to helpers (no data call in the file itself)

These runtime files obtain the Firestore instance from `src/firebase` (`useFirestore()`) and hand it to helper functions/hooks in other files (the data rows live at the helper). A function-name grep at the call site misses them; the kill-switch still changes their behaviour.

- `src/app/announcements/page.tsx`
- `src/app/invite/page.tsx`
- `src/components/admin/crm/partner-form-dialog.tsx`
- `src/components/admin/tasks/step-role-picker.tsx`
- `src/components/admin/users/user-table-columns.tsx`
- `src/components/admin/workflows/missions-tab.tsx`
- `src/components/privacy/masked-contact.tsx`
- `src/components/roles/custom-role-registry.tsx`
- `src/components/sections/skills-page-section.tsx`
- `src/firebase/index.ts`
- `src/hooks/use`
- `src/hooks/use-authorization.ts`

## Outside src/ — Cloud Functions (`functions/`)

Deployed separately from the Next app. Rows here are runtime for the functions deployment.

| File | Kind | Calls | Target | Via | Note |
|---|---|---|---|---|---|
| `functions/src/index.ts` | AUTH-EXEMPT | 3 | (auth) | direct | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `functions/src/index.ts` | BATCH | 2 | (sub)doc:global; (sub)doc:leaderboard; activity; audit_logs; badges; cache | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 33x .collection() |
| `functions/src/index.ts` | READ | 16 | (sub)doc:global; (sub)doc:leaderboard; activity; audit_logs; badges; cache | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 33x .collection() |
| `functions/src/index.ts` | TRANSACTION | 4 | (sub)doc:global; (sub)doc:leaderboard; activity; audit_logs; badges; cache | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 33x .collection() |
| `functions/src/index.ts` | WRITE | 23 | (sub)doc:global; (sub)doc:leaderboard; activity; audit_logs; badges; cache | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 33x .collection() |

## Outside src/ — operator scripts (`scripts/`)

NOT app runtime: one-off operator/backfill/diagnostic scripts run by hand with Admin credentials. They are shadow write paths for as long as Firestore exists and must be retired or re-pointed at decommission, but no app surface depends on them.

| File | Kind | Calls | Target | Via | Note |
|---|---|---|---|---|---|
| `scripts/add-points-to-all-users.js` | BATCH | 1 | users | direct | Admin SDK chain: 2x .collection() |
| `scripts/add-points-to-all-users.js` | READ | 3 | users | direct | Admin SDK chain: 2x .collection() |
| `scripts/add-points-to-all-users.js` | WRITE | 2 | users | direct | Admin SDK chain: 2x .collection() |
| `scripts/analyze-leaderboard-comprehensive.js` | READ | 8 | roles; users | direct | Admin SDK chain: 2x .collection() |
| `scripts/analyze-leaderboard-comprehensive.js` | WRITE | 2 | roles; users | direct | Admin SDK chain: 2x .collection() |
| `scripts/assign-test-role.js` | AUTH-EXEMPT | 1 | (auth) | direct | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `scripts/assign-test-role.js` | WRITE | 3 | audit_logs; roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/backfill-certificate-public.js` | BATCH | 1 | certificate_public; certificates | direct | Admin SDK chain: 2x .collection() |
| `scripts/backfill-certificate-public.js` | READ | 1 | certificate_public; certificates | direct | Admin SDK chain: 2x .collection() |
| `scripts/backfill-certificate-public.js` | WRITE | 1 | certificate_public; certificates | direct | Admin SDK chain: 2x .collection() |
| `scripts/backfill-email-lowercase.js` | BATCH | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/backfill-email-lowercase.js` | READ | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/backfill-email-lowercase.js` | WRITE | 2 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/backfill-firestore-fields.js` | READ | 3 | messages; notifications; users | direct | Admin SDK chain: 4x .collection() |
| `scripts/backfill-firestore-fields.js` | WRITE | 2 | messages; notifications; users | direct | Admin SDK chain: 4x .collection() |
| `scripts/backfill-user-roles.js` | BATCH | 1 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/backfill-user-roles.js` | READ | 3 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/backfill-user-roles.js` | WRITE | 2 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/backfill-users-role-from-roles.ts` | BATCH | 1 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/backfill-users-role-from-roles.ts` | READ | 2 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/backfill-users-role-from-roles.ts` | WRITE | 1 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/check-firestore-data.js` | READ | 8 | badges; certificates; chapters; projects; tasks; users | direct | Admin SDK chain: 9x .collection() |
| `scripts/check-overdue.js` | READ | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `scripts/check-user-data.js` | READ | 8 | badges; certificates; chapters; projects; tasks; users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 9x .collection() |
| `scripts/clean-user-points-data.js` | BATCH | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/clean-user-points-data.js` | READ | 2 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/clean-user-points-data.js` | WRITE | 3 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/cleanup-unauthorized-admins.js` | READ | 2 | roles; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/cleanup-unauthorized-admins.js` | WRITE | 4 | roles; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/count-all-users.js` | READ | 2 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/count-recruitment-admins.js` | READ | 1 | roles | direct | Admin SDK chain: 1x .collection() |
| `scripts/create-superadmin.js` | AUTH-EXEMPT | 1 | (auth) | direct | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate; file also has data rows above |
| `scripts/create-superadmin.js` | BATCH | 1 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/create-superadmin.js` | READ | 1 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/create-superadmin.js` | WRITE | 2 | roles; users | direct | Admin SDK chain: 3x .collection() |
| `scripts/create-test-auth-user.js` | AUTH-EXEMPT | 1 | (auth) | direct | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `scripts/debug-maira.js` | READ | 3 | tasks; users | direct | Admin SDK chain: 2x .collection() |
| `scripts/debug-maira.js` | WRITE | 2 | tasks; users | direct | Admin SDK chain: 2x .collection() |
| `scripts/diagnose-admin-leak.js` | READ | 2 | roles; users | direct | Admin SDK chain: 2x .collection() |
| `scripts/diagnose-tasks-count.js` | READ | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `scripts/diagnose-zubair-tasks.ts` | READ | 12 | reporting_relationships; tasks; users | direct | Admin SDK chain: 11x .collection() |
| `scripts/diagnose-zubair-tasks.ts` | WRITE | 6 | reporting_relationships; tasks; users | direct | Admin SDK chain: 11x .collection() |
| `scripts/fix-poison-pill-data.js` | READ | 2 | (dynamic / via ref) | direct |  |
| `scripts/fix-poison-pill-data.js` | WRITE | 1 | (dynamic / via ref) | direct |  |
| `scripts/fix-store-data-integrity-v2.js` | BATCH | 2 | orders; products | direct | Admin SDK chain: 2x .collection() |
| `scripts/fix-store-data-integrity-v2.js` | READ | 2 | orders; products | direct | Admin SDK chain: 2x .collection() |
| `scripts/fix-store-data-integrity-v2.js` | WRITE | 2 | orders; products | direct | Admin SDK chain: 2x .collection() |
| `scripts/fix-store-data-integrity.js` | BATCH | 3 | (dynamic / via ref) | direct |  |
| `scripts/fix-store-data-integrity.js` | READ | 5 | (dynamic / via ref) | direct |  |
| `scripts/fix-zero-point-tasks.ts` | BATCH | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `scripts/fix-zero-point-tasks.ts` | READ | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `scripts/fix-zero-point-tasks.ts` | WRITE | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `scripts/get-test-token.js` | AUTH-EXEMPT | 3 | (auth) | direct | Firebase Auth usage (auth SDK / token verification / session); Auth stays, do not migrate |
| `scripts/migrate-add-points.js` | BATCH | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/migrate-add-points.js` | READ | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/migrate-add-points.js` | WRITE | 1 | users | direct | Admin SDK chain: 1x .collection() |
| `scripts/nuclear-cleanup.js` | READ | 2 | roles; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/nuclear-cleanup.js` | WRITE | 4 | roles; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/nuclear-dedupe.js` | READ | 4 | roleDefinitions; roles; users | direct | Admin SDK chain: 9x .collection() |
| `scripts/nuclear-dedupe.js` | WRITE | 5 | roleDefinitions; roles; users | direct | Admin SDK chain: 9x .collection() |
| `scripts/populate-sample-organizations.js` | BATCH | 1 | organizations | direct | Admin SDK chain: 2x .collection() |
| `scripts/populate-sample-organizations.js` | READ | 1 | organizations | direct | Admin SDK chain: 2x .collection() |
| `scripts/populate-sample-organizations.js` | WRITE | 2 | organizations | direct | Admin SDK chain: 2x .collection() |
| `scripts/qa_gamification.js` | BATCH | 2 | points_ledger; tasks; users | direct | Admin SDK chain: 12x .collection() |
| `scripts/qa_gamification.js` | READ | 8 | points_ledger; tasks; users | direct | Admin SDK chain: 12x .collection() |
| `scripts/qa_gamification.js` | WRITE | 7 | points_ledger; tasks; users | direct | Admin SDK chain: 12x .collection() |
| `scripts/recalculate-user-aggregates.ts` | READ | 4 | tasks; users | direct | Admin SDK chain: 5x .collection() |
| `scripts/recalculate-user-aggregates.ts` | WRITE | 3 | tasks; users | direct | Admin SDK chain: 5x .collection() |
| `scripts/seed-about.js` | BATCH | 1 | (sub)doc:about; pages; roleHistory; teamMembers | direct | Admin SDK chain: 3x .collection() |
| `scripts/seed-about.js` | WRITE | 3 | (sub)doc:about; pages; roleHistory; teamMembers | direct | Admin SDK chain: 3x .collection() |
| `scripts/seed-compliance-obligations.ts` | READ | 4 | compliance_obligations; compliance_templates; default_notices | direct | Admin SDK chain: 6x .collection() |
| `scripts/seed-compliance-obligations.ts` | WRITE | 4 | compliance_obligations; compliance_templates; default_notices | direct | Admin SDK chain: 6x .collection() |
| `scripts/seed-consent-matters.ts` | READ | 3 | (sub)doc:consent_config; (sub)doc:consent_counter; reserved_matters; settings | direct | Admin SDK chain: 3x .collection() |
| `scripts/seed-consent-matters.ts` | WRITE | 3 | (sub)doc:consent_config; (sub)doc:consent_counter; reserved_matters; settings | direct | Admin SDK chain: 3x .collection() |
| `scripts/seed-gallery-assets.js` | BATCH | 1 | galleryAssets | direct | Admin SDK chain: 2x .collection() |
| `scripts/seed-gallery-assets.js` | READ | 1 | galleryAssets | direct | Admin SDK chain: 2x .collection() |
| `scripts/seed-gallery-assets.js` | WRITE | 1 | galleryAssets | direct | Admin SDK chain: 2x .collection() |
| `scripts/seed-office-roles.mjs` | BATCH | 1 | roleDefinitions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `scripts/seed-office-roles.mjs` | WRITE | 1 | roleDefinitions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `scripts/seed-role-catalog.ts` | BATCH | 1 | roleDefinitions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `scripts/seed-role-catalog.ts` | READ | 1 | roleDefinitions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `scripts/seed-role-catalog.ts` | WRITE | 2 | roleDefinitions | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 3x .collection() |
| `scripts/seed-sponsors.ts` | READ | 1 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |
| `scripts/seed-sponsors.ts` | WRITE | 1 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |
| `scripts/simulate-api.js` | READ | 1 | tasks | direct | Admin SDK chain: 1x .collection() |
| `scripts/sync-custom-claims.js` | READ | 3 | roles | direct | Admin SDK chain: 1x .collection() |
| `scripts/test-queries.js` | READ | 4 | announcements; notifications; users | direct | Admin SDK chain: 5x .collection() |
| `scripts/thermonuclear.js` | BATCH | 3 | points_ledger; tasks; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/thermonuclear.js` | READ | 4 | points_ledger; tasks; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/thermonuclear.js` | WRITE | 4 | points_ledger; tasks; users | direct | Admin SDK chain: 6x .collection() |
| `scripts/unban_bushra.ts` | READ | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `scripts/unban_bushra.ts` | WRITE | 1 | users | via-helper: src/lib/server/firebase-admin.ts (getDb) | Admin SDK chain: 1x .collection() |
| `scripts/update-seed-intelligence.ts` | READ | 2 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |
| `scripts/update-seed-intelligence.ts` | WRITE | 2 | sponsors_partners | direct | Admin SDK chain: 1x .collection() |

## TEST files (excluded from all runtime counts and lists)

| File | Kind | Calls | Target | Via |
|---|---|---|---|---|
| `src/app/api/admin/chapters/__tests__/route-contracts.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/admin/chapters/__tests__/route-contracts.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/admin/discipline-settings/__tests__/mirror.test.ts` | TEST/READ | 1 | (sub)doc:discipline; settings | direct |
| `src/app/api/admin/discipline-settings/__tests__/route.test.ts` | TEST/READ | 1 | (sub)doc:discipline; settings | direct |
| `src/app/api/admin/erasure-requests/[id]/execute/__tests__/supa-contract-execute-route.test.ts` | TEST/READ | 5 | (dynamic / via ref) | direct |
| `src/app/api/admin/finance/__tests__/supa-law-contracts.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/finance/__tests__/supa-law-flag-paused.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/finance/__tests__/supa-route-parity.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/finance/approvals/__tests__/approvals-parity.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/finance/ledger/__tests__/ledger.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/finance/receipts/__tests__/receipts.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/finance/reconciliations/__tests__/reconcile.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/governance-records/[recordId]/__tests__/attach.test.ts` | TEST/READ | 2 | (dynamic / via ref) | direct |
| `src/app/api/admin/governance-records/[recordId]/__tests__/route.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/admin/governance-records/[recordId]/__tests__/transition.test.ts` | TEST/READ | 4 | (dynamic / via ref) | direct |
| `src/app/api/admin/partners/__tests__/analyze-auth.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/admin/partners/related-party/__tests__/related-party-route.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/admin/universal-review/__tests__/universal-review-cadetship-batch-mirror.test.ts` | TEST/WRITE | 1 | (dynamic / via ref) | direct |
| `src/app/api/admin/uploads/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/ai-task-generator/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/applications/status/__tests__/route-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/applications/status/__tests__/route-contracts.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/applications/status/__tests__/route-contracts.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/applications/status/__tests__/route-supa.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/applications/status/__tests__/route-supa.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/applications/status/__tests__/route-supa.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/applications/status/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/chapter-applications/__tests__/route-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/chapter-applications/__tests__/route-contracts.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/chapter-applications/__tests__/route-contracts.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/chapter-applications/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/chapter-applications/__tests__/route-supa.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/chapter-applications/__tests__/route-supa.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/chapter-applications/__tests__/route-supa.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/client-errors/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/elections/__tests__/routes.test.ts` | TEST/READ | 8 | (sub)doc:e1; (sub)doc:e2; (sub)doc:e3; (sub)doc:main; challenges; count_record | direct |
| `src/app/api/elections/__tests__/routes.test.ts` | TEST/WRITE | 21 | (sub)doc:e1; (sub)doc:e2; (sub)doc:e3; (sub)doc:main; challenges; count_record | direct |
| `src/app/api/event-registrations/__tests__/cross-route-contradictions.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/event-registrations/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/event-registrations/__tests__/supa-contract-extensions.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/events/publish/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/events/publish/__tests__/route-supa-flag.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/events/publish/__tests__/supa-publish-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/circular-resolutions/__tests__/gov-gate.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/circular-resolutions/__tests__/sign-server-derived.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/consents/__tests__/gov-gate.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/decisions/__tests__/gov-gate.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/minutes/__tests__/gov-gate.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/motions/__tests__/gov-gate.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/urgent-decisions/__tests__/gov-gate-get.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/governance/urgent-decisions/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/leave/__tests__/leave-route.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/organizations/__tests__/post-auth.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/positions/__tests__/consent-gate.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/positions/__tests__/identity-backend-repoint.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/positions/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/skills/__tests__/route-supa-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/skills/migrate-legacy/__tests__/route-supa-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/sourcing/inquiries/__tests__/auth.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/store/orders/__tests__/orders-route.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/store/orders/__tests__/route-supa.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/store/orders/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/store/products/__tests__/route-supa.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/store/products/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/contracts-current.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/gapn1-notifications-mirror.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/route-list-fallback.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/route-list-fallback.test.ts` | TEST/READ | 2 | tasks | direct |
| `src/app/api/tasks/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/route-supa-seam.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/route.bug3-single-doc.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/route.step-resources.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/tasks/__tests__/supa-group2-fakes.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/tasks/__tests__/supa-group2-fakes.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/tasks/attach-upload/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/v1/certificates/__tests__/parity.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/v1/chapters/__tests__/route-contracts.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/app/api/v1/chapters/__tests__/route-contracts.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/app/api/v1/tickets/issue/__tests__/issuance-integrity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/v1/tickets/issue/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/v1/tickets/issue/__tests__/supa-issuance-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/webhooks/dispatch/__tests__/contracts.test.ts` | TEST/AUTH-EXEMPT | 4 | (auth) | direct |
| `src/app/api/webhooks/dispatch/__tests__/fresh-signup.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/app/api/webhooks/firestore/__tests__/contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/webhooks/firestore/__tests__/gapn1-notifications-mirror.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/webhooks/firestore/__tests__/supa-flag-on.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/workflows/__tests__/route-assignment-notifications.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/workflows/__tests__/route-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/workflows/__tests__/supa-pdf-export-data.contract.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/api/workflows/__tests__/supa-workflows-probe.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/registerForEvent/__tests__/route.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/app/registerForEvent/__tests__/supa-contract-extensions.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/components/admin/__tests__/admin-sidebar-custom-roles.test.tsx` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/components/admin/hierarchy/__tests__/hierarchy-canvas.test.tsx` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/components/admin/hierarchy/__tests__/role-clusters-overview.test.tsx` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/components/admin/roles/__tests__/role-permission-editor-custom.test.tsx` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/components/admin/roles/__tests__/role-permission-editor-expiry.test.tsx` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/components/profile/__tests__/workflow-visualizer-supa-disposition.test.ts` | TEST/LISTENER | 3 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) |
| `src/components/profile/__tests__/workflow-visualizer-supa-disposition.test.ts` | TEST/READ | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) |
| `src/lib/__tests__/announcements-rules.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/__tests__/announcements-supa-verdict.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/application-submit-rules.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/__tests__/applications-client-supa.test.ts` | TEST/BATCH | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) |
| `src/lib/__tests__/applications-client-supa.test.ts` | TEST/LISTENER | 2 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection) |
| `src/lib/__tests__/applications-supa.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/__tests__/applications-supa.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/__tests__/consent-bypass-inventory.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/__tests__/founder-transfer-raw-consumers.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/live-admin-hook-oneshot.test.tsx` | TEST/LISTENER | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/firebase/firestore/use-doc.tsx (useDoc) |
| `src/lib/__tests__/live-admin-hook-oneshot.test.tsx` | TEST/READ | 1 | (dynamic / via ref) | via-helper: src/firebase/firestore/use-collection.tsx (useCollection), src/firebase/firestore/use-doc.tsx (useDoc) |
| `src/lib/__tests__/projects-supa-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/role-management-custom.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/__tests__/role-management-expiry.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/supa-admin-tasks-helpers.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/supa-roles-callers.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/supa-roles-client-seam.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/__tests__/supa-wf-fixtures.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/__tests__/supa-wf-fixtures.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/__tests__/task-completion-update.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/task-pending-save-guard.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/tasks-status-semantics.contract.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/__tests__/workflow-step-sync-guard.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/auth/__tests__/ensure-user-profile.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/auth/__tests__/ensure-user-profile.test.ts` | TEST/READ | 1 | users | direct |
| `src/lib/drive/__tests__/governance-kind.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/events/__tests__/supa-events-list-detail-contracts.test.tsx` | TEST/READ | 2 | events | direct |
| `src/lib/events/__tests__/supa-events-seam-contracts.test.ts` | TEST/READ | 6 | (dynamic / via ref) | direct |
| `src/lib/events/__tests__/supa-events-seam-contracts.test.ts` | TEST/WRITE | 12 | (dynamic / via ref) | direct |
| `src/lib/finance/__tests__/fake-firestore.ts` | TEST/TRANSACTION | 1 | (dynamic / via ref) | direct |
| `src/lib/finance/__tests__/supa-seams.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/finance/__tests__/supa-timestamp-contracts.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/finance/__tests__/supa-timestamp-target.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/governance/__tests__/fake-firestore.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/retention/__tests__/engine.test.ts` | TEST/READ | 7 | (dynamic / via ref) | direct |
| `src/lib/retention/__tests__/erasure.test.ts` | TEST/READ | 6 | (dynamic / via ref) | direct |
| `src/lib/retention/__tests__/supa-contract-erasure.test.ts` | TEST/READ | 16 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/admin-analytics-supa.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/agm-notice.test.ts` | TEST/READ | 2 | agm_events; notices; recipients | direct |
| `src/lib/server/__tests__/consent-founder-act-agent13-cases.test.ts` | TEST/WRITE | 1 | role_assignments | direct |
| `src/lib/server/__tests__/custom-role-expiry-sweep.test.ts` | TEST/WRITE | 2 | audit_logs | direct |
| `src/lib/server/__tests__/custom-role-registry.test.ts` | TEST/WRITE | 1 | roleDefinitions | direct |
| `src/lib/server/__tests__/elections-agm-list.test.ts` | TEST/READ | 5 | (sub)doc:agm-2024; (sub)doc:agm-2025; (sub)doc:agm-2026; agm_events | direct |
| `src/lib/server/__tests__/elections-agm-list.test.ts` | TEST/WRITE | 11 | (sub)doc:agm-2024; (sub)doc:agm-2025; (sub)doc:agm-2026; agm_events | direct |
| `src/lib/server/__tests__/elections-agm-routes.test.ts` | TEST/READ | 11 | (sub)doc:agm1; (sub)doc:n1; agm_events; elections; notices; recipients | direct |
| `src/lib/server/__tests__/elections-agm-routes.test.ts` | TEST/WRITE | 18 | (sub)doc:agm1; (sub)doc:n1; agm_events; elections; notices; recipients | direct |
| `src/lib/server/__tests__/elections-ballot.test.ts` | TEST/READ | 2 | ballots; elections; eligibility_tokens; roles | direct |
| `src/lib/server/__tests__/elections-ballot.test.ts` | TEST/WRITE | 2 | ballots; elections; eligibility_tokens; roles | direct |
| `src/lib/server/__tests__/elections-cast-atomicity.test.ts` | TEST/READ | 25 | elections; eligibility_tokens; roles | direct |
| `src/lib/server/__tests__/elections-cast-atomicity.test.ts` | TEST/WRITE | 30 | elections; eligibility_tokens; roles | direct |
| `src/lib/server/__tests__/elections-closevote-failure.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/elections-closevote-failure.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/elections-declare.test.ts` | TEST/READ | 1 | elections; roles | direct |
| `src/lib/server/__tests__/elections-declare.test.ts` | TEST/WRITE | 2 | elections; roles | direct |
| `src/lib/server/__tests__/elections-nominations.test.ts` | TEST/WRITE | 2 | elections; nominations; roles | direct |
| `src/lib/server/__tests__/elections-roll.test.ts` | TEST/WRITE | 1 | roles | direct |
| `src/lib/server/__tests__/elections-supa-agm.test.ts` | TEST/READ | 17 | agm_events; notices; recipients | direct |
| `src/lib/server/__tests__/elections-supa-agm.test.ts` | TEST/WRITE | 7 | agm_events; notices; recipients | direct |
| `src/lib/server/__tests__/elections-supa-domain.test.ts` | TEST/READ | 11 | elections; roles; voter_roll | direct |
| `src/lib/server/__tests__/elections-supa-domain.test.ts` | TEST/WRITE | 18 | elections; roles; voter_roll | direct |
| `src/lib/server/__tests__/elections-supa-seam.test.ts` | TEST/READ | 8 | (sub)doc:e7; (sub)doc:e9; (sub)doc:fs-only; elections; roles | direct |
| `src/lib/server/__tests__/elections-supa-seam.test.ts` | TEST/WRITE | 12 | (sub)doc:e7; (sub)doc:e9; (sub)doc:fs-only; elections; roles | direct |
| `src/lib/server/__tests__/forms-resources-supa-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/server/__tests__/governance-votes-supa.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/governance-votes-supa.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/identity-cache-hardening.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-cache-integration.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-cache-race.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-cache-ta5-ta4.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-cache-write-invalidation-governors.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-cache-write-invalidation-ratification-chapter.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-cache-write-invalidation.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/identity-supa-parity.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/lifecycle-probation.test.ts` | TEST/WRITE | 2 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/member-lifecycle.test.ts` | TEST/READ | 11 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/member-lifecycle.test.ts` | TEST/WRITE | 7 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/permissions-custom-roles-auth.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/public-content-supa-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/server/__tests__/supa-contract-probation.test.ts` | TEST/WRITE | 2 | (dynamic / via ref) | direct |
| `src/lib/server/__tests__/supa-db-handle.test.ts` | TEST/BATCH | 1 | (sub)doc:points_ledger/l1; (sub)doc:points_ledger/l2; (sub)doc:settings/x; (sub)doc:tasks/a; (sub)doc:tasks/b; (sub)doc:tasks/c | direct |
| `src/lib/server/__tests__/supa-db-handle.test.ts` | TEST/READ | 28 | (sub)doc:points_ledger/l1; (sub)doc:points_ledger/l2; (sub)doc:settings/x; (sub)doc:tasks/a; (sub)doc:tasks/b; (sub)doc:tasks/c | direct |
| `src/lib/server/__tests__/supa-db-handle.test.ts` | TEST/TRANSACTION | 4 | (sub)doc:points_ledger/l1; (sub)doc:points_ledger/l2; (sub)doc:settings/x; (sub)doc:tasks/a; (sub)doc:tasks/b; (sub)doc:tasks/c | direct |
| `src/lib/server/__tests__/supa-db-handle.test.ts` | TEST/WRITE | 39 | (sub)doc:points_ledger/l1; (sub)doc:points_ledger/l2; (sub)doc:settings/x; (sub)doc:tasks/a; (sub)doc:tasks/b; (sub)doc:tasks/c | direct |
| `src/lib/server/__tests__/supa-elections-contracts.test.ts` | TEST/READ | 25 | (sub)doc:u-basic; (sub)doc:u-full; (sub)doc:u-legacy; (sub)doc:u-mirror; elections; roles | direct |
| `src/lib/server/__tests__/supa-elections-contracts.test.ts` | TEST/WRITE | 24 | (sub)doc:u-basic; (sub)doc:u-full; (sub)doc:u-legacy; (sub)doc:u-mirror; elections; roles | direct |
| `src/lib/server/__tests__/supa-roles-workflows-pin.test.ts` | TEST/AUTH-EXEMPT | 2 | (auth) | direct |
| `src/lib/server/__tests__/workflow-detail-supa.test.ts` | TEST/READ | 3 | (dynamic / via ref) | direct |
| `src/lib/server/cron/__tests__/g1-data.test.ts` | TEST/READ | 1 | tasks | via-helper: src/lib/server/firebase-admin.ts (getDb) |
| `src/lib/server/governance/__tests__/fake-supa-adapter.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/server/governance/__tests__/fake-supa-adapter.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/server/governance/__tests__/meetings.test.ts` | TEST/READ | 10 | (sub)doc:body-board; (sub)doc:body-nec; bodies | direct |
| `src/lib/server/governance/__tests__/meetings.test.ts` | TEST/WRITE | 5 | (sub)doc:body-board; (sub)doc:body-nec; bodies | direct |
| `src/lib/server/governance/__tests__/route-helpers.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/supa-events/__tests__/parity-audit-e2.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/supa-events/__tests__/registrations-parity.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/supa-events/__tests__/tickets.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/adapter-contracts.test.ts` | TEST/READ | 5 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/adapter-contracts.test.ts` | TEST/WRITE | 4 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/adapter.test.ts` | TEST/READ | 8 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/adapter.test.ts` | TEST/WRITE | 12 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/admin-parity.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/gamification-contracts.test.ts` | TEST/READ | 1 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/gamification-contracts.test.ts` | TEST/WRITE | 3 | (dynamic / via ref) | direct |
| `src/lib/supa/__tests__/store-contracts.test.ts` | TEST/AUTH-EXEMPT | 1 | (auth) | direct |
| `src/lib/supa/__tests__/store-contracts.test.ts` | TEST/READ | 5 | (dynamic / via ref) | direct |

## Surprises — what the migration record did not mention

1. **Cloud Functions are a whole second Firestore runtime, outside `src/`.** `functions/src/index.ts` (1,064 lines) registers Firestore triggers (`onDocumentCreated/onDocumentUpdated/onDocumentDeleted/onDocumentWritten` from `firebase-functions/v2/firestore`) and writes `users/{id}/activity`, `users/{id}/notifications`, `users/{id}/rewards`, `tasks`, `badges`, and `universal_submissions` (points increments, badge awards, notification fan-out). No DEPLOY_READY surface names it. As long as these functions are deployed, Firestore writes keep happening and dual-write mirrors can be re-triggered by them; the kill-switch list is incomplete without the functions deployment (its rows are in the `functions/` section above).
2. **The app's main client write path does not import the Firestore SDK.** `src/lib/client/firestore-wrapper.ts` re-exports `setDoc/updateDoc/addDoc/deleteDoc/getDoc` (with structured error normalization), and **72 files** import those names from the wrapper, not from `firebase/firestore`. Any census or conversion pass that greps only SDK imports silently misses most client writes — and, conversely, this one wrapper is the highest-leverage single conversion point for workstream 10.
3. **Admin `db.batch()` is a platform-wide atomicity dependency, not a niche.** Client `writeBatch(` appears on only 6 runtime lines, but Admin-SDK `.batch(` appears on **86 non-test lines in `src/`** and **51 runtime `src/` files** carry a BATCH row in this census (70 BATCH rows in total once `scripts/` and `functions/` are included), concentrated in finance routes. The inversion wave needs a batch primitive at that scale; the DEPLOY_READY report's batch caveat ("emulated batch/transaction atomicity" for cron) understates how many ordinary routes rely on it. TRANSACTION rows (22 files) are likewise mostly Admin `.runTransaction(` chains.
4. **A second Supabase transport family exists outside the adapter.** At least ten `*-supa` seam modules (e.g. `src/lib/inbox-supa.ts`, `src/lib/announcements-supa.ts`, `src/lib/applications-client-supa.ts`, `src/lib/server/admin-dashboard-supa.ts`, `src/lib/server/election-supa.ts`, `src/lib/server/identity-supa.ts`, `src/lib/server/notifications-supa-seam.ts`, `src/lib/server/workflow-detail-supa.ts`) reference `SUPABASE_URL`/`createClient(` outside `src/lib/supa/`. The listeners BUILDOUT noted the inbox bridge debt (its M3); the census confirms the pattern is a family, not one file. Decommission planning that assumes "the adapter" is the only Supabase path will miss these.
5. **A browser seed page writes production-shaped data directly.** `src/app/admin/seed/page.tsx` calls `setDoc` (via the wrapper) to create store products from the browser. It is in list (a); it is easy to mistake for tooling and leave behind as a live client writer.
6. **Named, self-documented unmirrored browser writes in `applications`.** `src/lib/applications-client-supa.ts` records in its own comments (L211, L303) that browser writes/reads were "Left on Firestore" for lack of an approved server replacement. They are rows in this census (applications surface) and are exactly the apps-2 blocker class; nothing in DEPLOY_READY's flip list names the file.
7. **Dead Firestore code, safe to delete (verified zero importers / zero calls in this tree):**
   - `src/hooks/use-blogs-fixed.ts` and `src/hooks/use-blogs-temp.ts` — full duplicate blog hooks with direct Firestore imports; no file imports either (grep for importers returns only the definitions).
   - Dead `onSnapshot` imports with zero call sites in the same file: `src/components/community/leaderboard.tsx`, `src/components/notifications/notification-center.tsx` (listens via `useCollection`), `src/components/profile/assigned-tasks.tsx`, `src/hooks/use-role-permissions.ts` (already flagged as Class D delete candidates in BUILDOUT_REPORT rows 37–39/47; reverified here).
   - `useSafeFirestoreDocuments` export in `src/hooks/use-safe-firestore-subscription.ts` — no consumers in `src/` (BUILDOUT row 26; reverified).
   - `src/components/profile/workflow-visualizer.tsx` is dormant (zero importers, BUILDOUT F2) yet carries a presence listener, two `useCollection` listeners, and writes — it inflates every listener/write count until it is deleted or formally kept.
8. **Operator scripts are a shadow write path.** `scripts/` holds 44+ files importing `firebase-admin`/`firebase/firestore` (backfills, `nuclear-cleanup.js`, `create-superadmin.js`, points fixers), and the repo root holds 18 more `.js` files referencing them (`test-firestore.js`, `create-founder-role.js`, `migrate-blog-status.js`, deploy helpers). None are app runtime, none appear in any surface list, and any of them run by hand after cutover writes straight back into Firestore. Decommission needs an explicit retire/re-point decision for this corpus.
9. **`useFirestore()` pass-through files are invisible to function-name greps.** The 11+ runtime files in the Indirect section hold no Firestore call at all; they fetch the instance and pass it into helpers. A conversion that only rewrites call sites will leave these holding a dead instance (harmless) or, worse, passing it into a helper that was only partly converted (not harmless). They are listed separately for that reason.
10. **No Firestore REST data path exists** — the only `firestore.googleapis.com` references in `src/` are the two preconnect hints in `src/app/layout.tsx`. One less bypass class to hunt; the hints themselves should be removed at kill-switch or they keep browsers warming connections to a dead backend.


## Appendix A — mention-only files in `src/` (no Firestore data call; comments/types/strings/pins only)

547 files. Listed so a post-kill-switch grep for "firestore" is not mistaken for surviving data paths:

```
src/app/actions/__tests__/chapter-applications.consent.test.ts
src/app/actions/__tests__/payment-methods-supa.test.ts
src/app/actions/__tests__/store-supa.test.ts
src/app/admin/__tests__/dashboard-live-admin.test.tsx
src/app/admin/applications/__tests__/approve-flow.test.tsx
src/app/admin/backup-restore/page.tsx
src/app/admin/blog/__tests__/blog-slug-autogen.test.ts
src/app/admin/blog/__tests__/live-admin-one-shot.test.tsx
src/app/admin/bug-reports/page.tsx
src/app/admin/certificates/__tests__/live-admin-one-shot.test.tsx
src/app/admin/events/edit/__tests__/delete-flow.test.tsx
src/app/admin/gallery/page.tsx
src/app/admin/sourcing/page.tsx
src/app/admin/submissions/__tests__/applications-inbox-mapping.test.tsx
src/app/admin/submissions/__tests__/leave-inbox-mapping.test.tsx
src/app/announcements/page.tsx
src/app/api/admin/__tests__/grove-item9-route.test.ts
src/app/api/admin/analytics/route.ts
src/app/api/admin/announcements/supa/route.ts
src/app/api/admin/audit-logs/route.ts
src/app/api/admin/backup-runs/__tests__/supa-flag-on.test.ts
src/app/api/admin/blogs/[id]/__tests__/delete-canonical-state.test.ts
src/app/api/admin/blogs/[id]/__tests__/route-parity.test.ts
src/app/api/admin/blogs/[id]/__tests__/slug-autofill.test.ts
src/app/api/admin/bug-reports/__tests__/route-parity.test.ts
src/app/api/admin/chapters/__tests__/consent-gate-founder.test.ts
src/app/api/admin/chapters/__tests__/supa-mirror.test.ts
src/app/api/admin/compliance/__tests__/notice-trigger-routes.test.ts
src/app/api/admin/compliance/notices/[id]/cure-review/route.ts
src/app/api/admin/compliance/obligations/[id]/cure/route.ts
src/app/api/admin/compliance/obligations/[id]/waive/route.ts
src/app/api/admin/dashboard/init/__tests__/grove-item3-route.test.ts
src/app/api/admin/dashboard/init/__tests__/route-supa.test.ts
src/app/api/admin/email-logs/__tests__/route-parity.test.ts
src/app/api/admin/erasure-requests/[id]/execute/__tests__/route-parity.test.ts
src/app/api/admin/erasure-requests/__tests__/route-parity.test.ts
src/app/api/admin/events/profit-settlement/__tests__/settlement-lock.test.ts
src/app/api/admin/events/profit-settlement/__tests__/supa-settlement-contracts.test.ts
src/app/api/admin/events/registrations/__tests__/route.test.ts
src/app/api/admin/events/registrations/route.ts
src/app/api/admin/founder-review/__tests__/route.test.ts
src/app/api/admin/founder-review/__tests__/supa-contract-reinstate-blacklist.test.ts
src/app/api/admin/governance-records/[recordId]/attach/route.ts
src/app/api/admin/governance-records/[recordId]/route.ts
src/app/api/admin/governance-records/[recordId]/transition/route.ts
src/app/api/admin/governance-records/__tests__/route.test.ts
src/app/api/admin/governance-records/export/__tests__/supa-flag-on.test.ts
src/app/api/admin/governance-records/export/route.ts
src/app/api/admin/governance-records/route.ts
src/app/api/admin/governors/export/__tests__/supa-flag-on.test.ts
src/app/api/admin/governors/export/route.ts
src/app/api/admin/hierarchy/__tests__/static-gates-parity.test.ts
src/app/api/admin/intake-windows/[windowId]/route.ts
src/app/api/admin/intake-windows/__tests__/route.test.ts
src/app/api/admin/intake-windows/__tests__/templates.test.ts
src/app/api/admin/intake-windows/config/route.ts
src/app/api/admin/intake-windows/route.ts
src/app/api/admin/intake-windows/shared.ts
src/app/api/admin/intake-windows/templates/route.ts
src/app/api/admin/partners/__tests__/supa-crm-wiring.test.ts
src/app/api/admin/partners/export/__tests__/supa-flag-on.test.ts
src/app/api/admin/partners/list/__tests__/list-route-contracts.test.ts
src/app/api/admin/partners/list/route.ts
src/app/api/admin/partners/route.ts
src/app/api/admin/performance-records/__tests__/route.test.ts
src/app/api/admin/platform-licence/__tests__/route.test.ts
src/app/api/admin/projects/supa/route.ts
src/app/api/admin/retention-policies/__tests__/route-parity.test.ts
src/app/api/admin/roles/__tests__/adopt-subset-rule.test.ts
src/app/api/admin/roles/__tests__/founder-delete-guard.test.ts
src/app/api/admin/roles/__tests__/role-permissions.test.ts
src/app/api/admin/roles/__tests__/slug-delete-founder-consent.test.ts
src/app/api/admin/roles/__tests__/slug-delete.test.ts
src/app/api/admin/roles/__tests__/supa-roles-founder-spec-fail.test.ts
src/app/api/admin/roles/__tests__/supa-roles-routes-contracts.test.ts
src/app/api/admin/roles/__tests__/supa-roles-routes-flag-on.test.ts
src/app/api/admin/roles/__tests__/write-assign-founder-consent.test.ts
src/app/api/admin/roles/__tests__/write-pregate-validation.test.ts
src/app/api/admin/site-settings/mirror/route.ts
src/app/api/admin/universal-review/__tests__/gapn1-notifications-mirror.test.ts
src/app/api/admin/universal-review/__tests__/universal-review-applications-skills.test.ts
src/app/api/admin/universal-review/__tests__/universal-review-cadetship.test.ts
src/app/api/admin/universal-review/__tests__/universal-review-leave.test.ts
src/app/api/admin/universal-review/__tests__/universal-review-parity.test.ts
src/app/api/admin/universal-review/__tests__/universal-review-points-idempotency.test.ts
src/app/api/admin/users/__tests__/route-expiry.test.ts
src/app/api/admin/users/__tests__/route-parity.test.ts
src/app/api/admin/users/__tests__/route-rolefilter.test.ts
src/app/api/admin/users/__tests__/route-supa-contract.test.ts
src/app/api/admin/users/__tests__/route-supa-flagon.test.ts
src/app/api/admin/users/__tests__/route.test.ts
src/app/api/ai/match-partners/__tests__/route.test.ts
src/app/api/ai/match-partners/__tests__/supa-crm-read.test.ts
src/app/api/announcements/visible/__tests__/route.test.ts
src/app/api/appointments/[instrumentId]/acceptance/check/route.ts
src/app/api/appointments/[instrumentId]/acceptance/route.ts
src/app/api/appointments/[instrumentId]/reissue/route.ts
src/app/api/appointments/__tests__/acceptance.test.ts
src/app/api/appointments/__tests__/letter.test.ts
src/app/api/appointments/route.ts
src/app/api/authors/__tests__/author-field-mapping.test.ts
src/app/api/authors/__tests__/deleted-exclusion.test.ts
src/app/api/blogs/[slug]/__tests__/slug-public-guard.test.ts
src/app/api/blogs/__tests__/author-field-mapping.test.ts
src/app/api/blogs/__tests__/deleted-exclusion.test.ts
src/app/api/blogs/__tests__/route-parity.test.ts
src/app/api/blogs/__tests__/slug-autofill.test.ts
src/app/api/cadetships/[id]/attest/route.ts
src/app/api/cadetships/__tests__/cadetship-routes.test.ts
src/app/api/compliance/__tests__/owner-admin-routes.test.ts
src/app/api/cron/backup/__tests__/route.test.ts
src/app/api/cron/backup/__tests__/supa-flag-on.test.ts
src/app/api/cron/check-deadlines/__tests__/contracts.test.ts
src/app/api/cron/check-deadlines/__tests__/custom-role-expiry-hosting.test.ts
src/app/api/cron/check-deadlines/__tests__/referral.test.ts
src/app/api/cron/check-deadlines/route.ts
src/app/api/cron/clear-probation/__tests__/contracts.test.ts
src/app/api/cron/clear-probation/__tests__/route.test.ts
src/app/api/cron/clear-probation/__tests__/supa-contract-blacklist.test.ts
src/app/api/cron/clear-probation/__tests__/supa-flag-on.test.ts
src/app/api/cron/consent-deadlines/__tests__/route.test.ts
src/app/api/cron/consent-deadlines/__tests__/supa-flag-on.test.ts
src/app/api/cron/custom-role-expiry-sweep/__tests__/contracts.test.ts
src/app/api/cron/custom-role-expiry-sweep/__tests__/supa-flag-on.test.ts
src/app/api/cron/custom-role-expiry-sweep/route.ts
src/app/api/cron/elections-lifecycle/__tests__/contracts.test.ts
src/app/api/cron/elections-lifecycle/__tests__/supa-flag-on.test.ts
src/app/api/cron/elections-lifecycle/route.ts
src/app/api/cron/governance/__tests__/contracts.test.ts
src/app/api/cron/governance/__tests__/supa-flag-on.test.ts
src/app/api/cron/governance/route.ts
src/app/api/cron/governors-term-sweep/__tests__/contracts.test.ts
src/app/api/cron/governors-term-sweep/route.ts
src/app/api/cron/overdue/__tests__/contracts.test.ts
src/app/api/cron/overdue/__tests__/route.test.ts
src/app/api/cron/overdue/__tests__/supa-flag-on.test.ts
src/app/api/cron/process-dlq/__tests__/contracts.test.ts
src/app/api/cron/process-dlq/__tests__/route.test.ts
src/app/api/cron/process-dlq/__tests__/supa-flag-on.test.ts
src/app/api/cron/reconcile-roles/__tests__/supa-flag-on.test.ts
src/app/api/cron/remind-deadlines/__tests__/contracts.test.ts
src/app/api/cron/remind-deadlines/__tests__/route.test.ts
src/app/api/cron/remind-deadlines/__tests__/supa-flag-on.test.ts
src/app/api/cron/remind-deadlines/route.ts
src/app/api/cron/retention/__tests__/contracts.test.ts
src/app/api/cron/retention/__tests__/supa-flag-on.test.ts
src/app/api/cron/retention/__tests__/supa-serializer-comparison.test.ts
src/app/api/discipline/cases/[caseId]/board/route.ts
src/app/api/discipline/cases/[caseId]/decide/route.ts
src/app/api/discipline/cases/[caseId]/referral/route.ts
src/app/api/discipline/cases/[caseId]/route.ts
src/app/api/discipline/my-cases/__tests__/route.test.ts
src/app/api/discipline/my-review/route.ts
src/app/api/events/public/route.ts
src/app/api/gallery-assets/__tests__/route.test.ts
src/app/api/governance-records/[recordId]/file/__tests__/route.test.ts
src/app/api/governance/circular-resolutions/[resolutionId]/circulate/route.ts
src/app/api/governance/circular-resolutions/[resolutionId]/route.ts
src/app/api/governance/circular-resolutions/[resolutionId]/sign/route.ts
src/app/api/governance/circular-resolutions/route.ts
src/app/api/governance/consents/decided/route.ts
src/app/api/governance/meetings/[meetingId]/attendance/route.ts
src/app/api/governance/meetings/[meetingId]/motions/route.ts
src/app/api/governance/meetings/[meetingId]/verify-quorum/route.ts
src/app/api/governance/meetings/__tests__/route-parity.test.ts
src/app/api/governance/meetings/route.ts
src/app/api/governance/minutes/[minutesId]/approve-link/route.ts
src/app/api/governance/minutes/[minutesId]/circulate/route.ts
src/app/api/governance/minutes/[minutesId]/route.ts
src/app/api/governance/minutes/[minutesId]/sign/route.ts
src/app/api/governance/minutes/route.ts
src/app/api/governance/motions/[motionId]/close/route.ts
src/app/api/governance/motions/[motionId]/demand-secret/route.ts
src/app/api/governance/motions/[motionId]/vote/route.ts
src/app/api/governance/settings/__tests__/mirror.test.ts
src/app/api/governance/settings/__tests__/route.test.ts
src/app/api/governance/urgent-decisions/[decisionId]/ratify/route.ts
src/app/api/governance/urgent-decisions/route.ts
src/app/api/governance/votes/__tests__/routes.test.ts
src/app/api/governance/votes/__tests__/supa-contract-h09-routes.test.ts
src/app/api/missions/[workflowId]/__tests__/route.test.ts
src/app/api/missions/[workflowId]/__tests__/supa-mission-contract.test.ts
src/app/api/missions/[workflowId]/__tests__/supa-mission-probe.test.ts
src/app/api/missions/[workflowId]/__tests__/supa-mission-reads.test.ts
src/app/api/notifications/__tests__/route.test.ts
src/app/api/profile/[userId]/__tests__/identity-backend-repoint.test.ts
src/app/api/profile/[userId]/__tests__/route-supa-contract.test.ts
src/app/api/profile/[userId]/__tests__/route-supa-profile.test.ts
src/app/api/profile/[userId]/telemetry/__tests__/route.test.ts
src/app/api/public/governance-documents/__tests__/route.test.ts
src/app/api/public/intake-window/__tests__/route.test.ts
src/app/api/public/skills-users/__tests__/route.test.ts
src/app/api/public/skills/__tests__/route.test.ts
src/app/api/public/skills/route.test.ts
src/app/api/public/warning-registry/__tests__/route.test.ts
src/app/api/submissions/__tests__/contracts-tasks-cluster.test.ts
src/app/api/submissions/__tests__/gapn1-notifications-mirror.test.ts
src/app/api/submissions/__tests__/route-supa.test.ts
src/app/api/submissions/__tests__/route.test.ts
src/app/api/tasks/__tests__/contracts-migration.test.ts
src/app/api/tasks/__tests__/contracts-secondary.test.ts
src/app/api/tasks/__tests__/supa-admin-tasks-endpoints.test.ts
src/app/api/tasks/__tests__/supa-group2-misc.test.ts
src/app/api/tasks/__tests__/supa-group2-team-review.test.ts
src/app/api/tasks/approval-rate/route.ts
src/app/api/tasks/batch/__tests__/contracts-current.test.ts
src/app/api/tasks/batch/__tests__/route-parity.test.ts
src/app/api/tasks/delegate/__tests__/contracts-current.test.ts
src/app/api/tasks/delegate/__tests__/gapn1-notifications-mirror.test.ts
src/app/api/tasks/delegate/__tests__/route.test.ts
src/app/api/tasks/team/__tests__/route-terminal-exclusion.test.ts
src/app/api/user/post-vacation/__tests__/return-ui.test.tsx
src/app/api/users/picker/__tests__/route-cache.test.ts
src/app/api/users/picker/__tests__/route-supa-contract.test.ts
src/app/api/users/picker/__tests__/route-supa-flagon.test.ts
src/app/api/v1/chapters/__tests__/supa-flag.test.ts
src/app/api/v1/chapters/invoice/__tests__/route-parity.test.ts
src/app/api/verify-appointment/[code]/route.ts
src/app/api/verify-appointment/__tests__/route.test.ts
src/app/api/webhooks/dispatch/__tests__/proxy-failure.test.ts
src/app/api/webhooks/dispatch/route.ts
src/app/api/workflows/[id]/__tests__/duplicate-parity.test.ts
src/app/api/workflows/[id]/__tests__/duplicate-supa-members.test.ts
src/app/blog/[slug]/page-client.tsx
src/app/blog/[slug]/page.tsx
src/app/blog/__tests__/post-page-no-mock.test.ts
src/app/community/page.tsx
src/app/competitions/__tests__/page.test.tsx
src/app/events/register/__tests__/payment-proof.test.tsx
src/app/governance/page.tsx
src/app/induction/loading.tsx
src/app/invite/page.tsx
src/app/missions/[workflowId]/__tests__/mission-page-data-paths.test.tsx
src/app/missions/[workflowId]/page.tsx
src/app/organizations-admin/page.tsx
src/app/page.tsx
src/app/profile/leave/page.tsx
src/app/projects/new/page.tsx
src/app/site-paused/page.tsx
src/app/timeline/page.tsx
src/app/verify/ticket/[ticketId]/__tests__/supa-verify-contracts.test.tsx
src/app/verify/ticket/[ticketId]/page.tsx
src/components/FirebaseErrorListener.tsx
src/components/admin/appointment-instrument-drawer.tsx
src/components/admin/consents/consent-api.ts
src/components/admin/consents/consent-attachment-field.tsx
src/components/admin/crm/partner-form-dialog.tsx
src/components/admin/hierarchy/__tests__/chapter-selector-live-admin.test.tsx
src/components/admin/hierarchy/__tests__/chapter-selector.test.tsx
src/components/admin/inspectors/__tests__/generic-inspector-applications.test.tsx
src/components/admin/inspectors/__tests__/generic-inspector-leave.test.tsx
src/components/admin/inspectors/leave-inspector.tsx
src/components/admin/inspectors/task-inspector.tsx
src/components/admin/roles/__tests__/role-registry-custom.test.tsx
src/components/admin/roles/__tests__/role-registry-expiry.test.tsx
src/components/admin/roles/__tests__/role-registry-levels.test.tsx
src/components/admin/roles/role-power-matrix.tsx
src/components/admin/tasks/__tests__/step-role-picker.test.tsx
src/components/admin/tasks/step-role-picker.tsx
src/components/admin/users/__tests__/user-table-columns-expiry.test.tsx
src/components/admin/users/__tests__/user-table-live-admin.test.tsx
src/components/admin/users/__tests__/user-table-supa-parity.test.tsx
src/components/admin/users/issue-warning-dialog.tsx
src/components/admin/users/user-table-columns.tsx
src/components/admin/workflows/missions-tab.tsx
src/components/blog/analog-archive.tsx
src/components/dashboard/post-vacation-summary.tsx
src/components/elections/api.ts
src/components/events/registration-deadline-countdown.tsx
src/components/inbox/instruction-inbox.tsx
src/components/notifications/__tests__/notification-center-active-gating.test.tsx
src/components/privacy/masked-contact.tsx
src/components/profile/leave-apply-form.tsx
src/components/roles/custom-role-registry.tsx
src/components/sections/news-and-blogs-section.tsx
src/components/sections/skills-page-section.tsx
src/components/workflow/__tests__/supa-presence-typing.contract.test.ts
src/config/permissions.config.ts
src/config/permissions.ts
src/firebase/error-emitter.ts
src/firebase/error-handler.ts
src/firebase/error-logging.ts
src/firebase/errors.ts
src/firebase/index.ts
src/hooks/__tests__/use-authorization-custom-roles.test.tsx
src/hooks/use-authorization.ts
src/hooks/use-blogs-temp.ts
src/hooks/use-firestore-pagination.ts
src/hooks/use-polling-refresh.ts
src/lib/__tests__/announcements-contracts.test.ts
src/lib/__tests__/announcements-supa-flag-on.test.ts
src/lib/__tests__/announcements-visibility.test.ts
src/lib/__tests__/applicant-status.test.ts
src/lib/__tests__/application-submit-joHL-regression.test.ts
src/lib/__tests__/brevo-mailer.test.ts
src/lib/__tests__/chapters-supa.test.ts
src/lib/__tests__/client-error-logging.test.ts
src/lib/__tests__/custom-role.test.ts
src/lib/__tests__/custom-roles.test.ts
src/lib/__tests__/event-public-exposure.test.ts
src/lib/__tests__/events-registrations-rules.test.ts
src/lib/__tests__/founder-client-permissions.test.ts
src/lib/__tests__/governors-term-math.test.ts
src/lib/__tests__/grove-item13-approval-rate.test.ts
src/lib/__tests__/helpers/fake-firestore.ts
src/lib/__tests__/inbox-supa.test.ts
src/lib/__tests__/induction-submit-user-identity.test.ts
src/lib/__tests__/legacy-junk-assign-guard.test.ts
src/lib/__tests__/mailer-brevo-logging.test.ts
src/lib/__tests__/notifications-supa-client-hook.test.tsx
src/lib/__tests__/notifications-supa-client.test.ts
src/lib/__tests__/p1-rules-text.test.ts
src/lib/__tests__/points-award-amount.test.ts
src/lib/__tests__/points-privileged-fields-rules.test.ts
src/lib/__tests__/projects-cached-supa.test.ts
src/lib/__tests__/projects-cached.test.ts
src/lib/__tests__/role-definitions-custom.test.ts
src/lib/__tests__/role-reconciliation.test.ts
src/lib/__tests__/role-writes-custom.test.ts
src/lib/__tests__/role-writes.test.ts
src/lib/__tests__/signup-basic-default.test.ts
src/lib/__tests__/task-management-contracts.test.ts
src/lib/__tests__/task-review-approval.test.ts
src/lib/__tests__/unified-roles-custom-assign-path.test.ts
src/lib/__tests__/unified-roles-custom.test.ts
src/lib/__tests__/users-roles-list-rules.test.ts
src/lib/__tests__/workflow-progress-supa-equivalence.test.ts
src/lib/__tests__/workflow-progress-supa-extra.test.ts
src/lib/applicant-status.ts
src/lib/appointment-letter-adapter.ts
src/lib/appointment-letter-pdf.ts
src/lib/appointments/register-adapter.ts
src/lib/backup/__tests__/engine.test.ts
src/lib/backup/__tests__/registry.test.ts
src/lib/backup/__tests__/restore-verify.test.ts
src/lib/backup/registry.ts
src/lib/blog-data-utils.ts
src/lib/blog-slug.ts
src/lib/brevo-mailer.ts
src/lib/cadetship/checklist.ts
src/lib/cadetship/types.ts
src/lib/client-error-logging.ts
src/lib/compliance/loader-core.ts
src/lib/compliance/seed-data.ts
src/lib/compliance/types.ts
src/lib/consents/consent-state.ts
src/lib/consents/reserved-matters.ts
src/lib/custom-role-sync.ts
src/lib/custom-roles.ts
src/lib/drive/client.ts
src/lib/drive/upload-handler.ts
src/lib/elections/client-supa.ts
src/lib/events/__tests__/supa-events-e2e02.test.tsx
src/lib/events/__tests__/supa-events-normalization.test.tsx
src/lib/events/datetime.ts
src/lib/events/venue-calculator.ts
src/lib/finance/__tests__/money-approval.test.ts
src/lib/finance/__tests__/supa-amount-precision.test.ts
src/lib/finance/order-canonical.ts
src/lib/finance/reports.ts
src/lib/governance/__tests__/meetings-integration.test.ts
src/lib/governance/__tests__/route-auth-parity.test.ts
src/lib/governance/bodies.ts
src/lib/governance/circular/threshold.ts
src/lib/governance/circular/types.ts
src/lib/governance/meeting-lifecycle.ts
src/lib/governance/meetings-adapter.ts
src/lib/governance/meetings/motions-types.ts
src/lib/governance/minutes-draft.ts
src/lib/governance/notice-periods.ts
src/lib/governance/quorum-engine.ts
src/lib/governance/record-io.ts
src/lib/governance/route-auth.ts
src/lib/governance/types.ts
src/lib/governance/urgent-decisions.ts
src/lib/governors.ts
src/lib/instruction-retention.ts
src/lib/intake-windows/__tests__/fake-firestore.ts
src/lib/intake-windows/resolve.ts
src/lib/notifications-supa-client.ts
src/lib/positions-types.ts
src/lib/privacy.ts
src/lib/profile-hub/telemetry.ts
src/lib/retention/policies.ts
src/lib/role-slug-classification.ts
src/lib/server/__tests__/admin-analytics-fixtures.ts
src/lib/server/__tests__/admin-audit-fixtures.ts
src/lib/server/__tests__/admin-audit-supa.test.ts
src/lib/server/__tests__/admin-dashboard-supa.test.ts
src/lib/server/__tests__/admin-parity-fixtures.ts
src/lib/server/__tests__/blog-related.test.ts
src/lib/server/__tests__/blog-supa-contracts.test.ts
src/lib/server/__tests__/bug4-proof-guards.test.ts
src/lib/server/__tests__/consent-founder-act-integration.test.ts
src/lib/server/__tests__/consent-gate-nonfounder-golden.test.ts
src/lib/server/__tests__/consent-gate.test.ts
src/lib/server/__tests__/consent-lookup.test.ts
src/lib/server/__tests__/consent-nonfounder-golden-integration.test.ts
src/lib/server/__tests__/consent-service.test.ts
src/lib/server/__tests__/crm-supa-contracts.test.ts
src/lib/server/__tests__/cron-gamification-leave.test.ts
src/lib/server/__tests__/elections-tomillis-contract.test.ts
src/lib/server/__tests__/fake-firestore.ts
src/lib/server/__tests__/founder-transfer-permissions.test.ts
src/lib/server/__tests__/full-member-derivation.test.ts
src/lib/server/__tests__/gamification-transaction.test.ts
src/lib/server/__tests__/gapn1-top-level-notifications.test.ts
src/lib/server/__tests__/governance-audit.test.ts
src/lib/server/__tests__/governance-settings.test.ts
src/lib/server/__tests__/governance-votes.test.ts
src/lib/server/__tests__/grove-item13-approval-rate-db.test.ts
src/lib/server/__tests__/grove-item9-generator.test.ts
src/lib/server/__tests__/helpers/counting-firestore.ts
src/lib/server/__tests__/helpers/fake-firestore.ts
src/lib/server/__tests__/helpers/identity-parity-fixtures.ts
src/lib/server/__tests__/hierarchy-validate-parity.test.ts
src/lib/server/__tests__/identity-backend.test.ts
src/lib/server/__tests__/identity-supa.test.ts
src/lib/server/__tests__/leave-exemption.test.ts
src/lib/server/__tests__/lifecycle-adapters.test.ts
src/lib/server/__tests__/lifecycle-cron.test.ts
src/lib/server/__tests__/lifecycle-ratification.test.ts
src/lib/server/__tests__/lifecycle-vacancy.test.ts
src/lib/server/__tests__/notifications-supa-mirror.test.ts
src/lib/server/__tests__/permissions-custom-roles.test.ts
src/lib/server/__tests__/permissions-one-answer.test.ts
src/lib/server/__tests__/role-holders.test.ts
src/lib/server/__tests__/rules-candidate-v2-custom-roles.test.ts
src/lib/server/__tests__/rules-candidate-v3-full-member.test.ts
src/lib/server/__tests__/rules-candidates.test.ts
src/lib/server/__tests__/skills-supa-contracts.test.ts
src/lib/server/__tests__/supa-contract-consent-gate-mode.test.ts
src/lib/server/__tests__/supa-contract-governance-votes-h09.test.ts
src/lib/server/__tests__/supa-custom-role-expiry-parity.test.ts
src/lib/server/__tests__/supa-role-reconciliation-parity.test.ts
src/lib/server/__tests__/supa-roles-flag-states.test.ts
src/lib/server/__tests__/supa-roles-mirror.test.ts
src/lib/server/__tests__/supa-roles-reconcile-seam.test.ts
src/lib/server/__tests__/supa-roles-resolution-core.test.ts
src/lib/server/__tests__/supa-roles-seam.test.ts
src/lib/server/__tests__/team-registry.test.ts
src/lib/server/__tests__/validation-notifications-resolve.test.ts
src/lib/server/__tests__/workflow-cascade-supa.test.ts
src/lib/server/__tests__/workflow-members-supa.test.ts
src/lib/server/admin-audit-supa.ts
src/lib/server/admin-dashboard-supa.ts
src/lib/server/backup-exports/__tests__/g4-data.test.ts
src/lib/server/backup-exports/g4-data.ts
src/lib/server/bug4-proof-guards.ts
src/lib/server/cadetship/__tests__/create-mirror.test.ts
src/lib/server/cadetship/__tests__/create.test.ts
src/lib/server/cadetship/__tests__/cron-stanza.test.ts
src/lib/server/cadetship/serialize.ts
src/lib/server/compliance/__tests__/cron.test.ts
src/lib/server/compliance/__tests__/generator.test.ts
src/lib/server/compliance/__tests__/report-service.test.ts
src/lib/server/compliance/report-aggregator.ts
src/lib/server/compliance/serialize.ts
src/lib/server/cron/__tests__/g2-data.test.ts
src/lib/server/cron/__tests__/g3-data.test.ts
src/lib/server/cron/g2-data.ts
src/lib/server/cron/g3-data.ts
src/lib/server/custom-role-registry.ts
src/lib/server/discipline/__tests__/apply-decision.test.ts
src/lib/server/discipline/__tests__/case-service.test.ts
src/lib/server/discipline/__tests__/derived-counter.test.ts
src/lib/server/discipline/__tests__/expulsion-vote.test.ts
src/lib/server/discipline/__tests__/fake-firestore.ts
src/lib/server/discipline/__tests__/grep-invariant.test.ts
src/lib/server/discipline/__tests__/grove-item18-diagnosis.test.ts
src/lib/server/discipline/__tests__/supa-contract-case-state-machine.test.ts
src/lib/server/discipline/__tests__/supa-contract-no-auto-ban.test.ts
src/lib/server/discipline/__tests__/supa-contract-warning-write-set.test.ts
src/lib/server/discipline/__tests__/suspension.test.ts
src/lib/server/election-route-helpers.ts
src/lib/server/firebase-admin.ts
src/lib/server/governance/__tests__/supa-decisions-seam.test.ts
src/lib/server/governance/__tests__/supa-meetings-seam.test.ts
src/lib/server/governance/__tests__/supa-motions-seam.test.ts
src/lib/server/governance/ballots.ts
src/lib/server/governance/circular.ts
src/lib/server/governance/consents-client.ts
src/lib/server/governance/decision-classes.ts
src/lib/server/governance/decisions-client.ts
src/lib/server/governance/minutes.ts
src/lib/server/governance/shared.ts
src/lib/server/governance/supa-shared.ts
src/lib/server/governance/urgent.ts
src/lib/server/governors/__tests__/register.test.ts
src/lib/server/governors/http.ts
src/lib/server/identity-backend.ts
src/lib/server/identity-cache.ts
src/lib/server/identity-supa.ts
src/lib/server/intake-windows.ts
src/lib/server/leave-exemption.ts
src/lib/server/platform-licence.ts
src/lib/server/public-misc-supa-shared.ts
src/lib/server/public-skills-supa.ts
src/lib/server/reviews/generator.ts
src/lib/server/role-reconciliation.ts
src/lib/server/supa-roles-route.ts
src/lib/server/upload-logger.ts
src/lib/server/webhooks/supa-handle.ts
src/lib/silence-escalation.ts
src/lib/site-settings-payload.ts
src/lib/sourcing-bridge-types.ts
src/lib/supa-events/__tests__/admin-events.test.ts
src/lib/supa-events/__tests__/parity-audit-e4-list.test.tsx
src/lib/supa-events/__tests__/parity-audit-e4.test.ts
src/lib/supa-events/__tests__/public-events.test.ts
src/lib/supa-events/__tests__/registrations.test.ts
src/lib/supa-events/__tests__/server-events.test.ts
src/lib/supa-events/public-events-client.ts
src/lib/supa-seams/__tests__/hr-cadetships.test.ts
src/lib/supa-seams/__tests__/hr-contracts.test.ts
src/lib/supa-seams/__tests__/hr-leave.test.ts
src/lib/supa-seams/__tests__/profile.test.ts
src/lib/supa-seams/users-directory.ts
src/lib/supa/__tests__/admin-parity-fixtures.ts
src/lib/supa/__tests__/admin-settings-writes.test.ts
src/lib/supa/__tests__/client.test.ts
src/lib/supa/__tests__/fake-supa.ts
src/lib/supa/__tests__/flags.test.ts
src/lib/supa/__tests__/seam-submissions.test.ts
src/lib/supa/__tests__/seam-tasks-route.test.ts
src/lib/supa/__tests__/store-orders-seam.test.ts
src/lib/supa/__tests__/store-products-seam.test.ts
src/lib/supa/client.ts
src/lib/supa/flags.ts
src/lib/supa/store-products.ts
src/lib/unified-roles.ts
src/types/appointment-instrument.ts
src/types/auction.ts
src/types/certificate.ts
src/types/chapter-application.ts
src/types/chapter.ts
src/types/consent.ts
src/types/event.ts
src/types/index.ts
src/types/intake-window.ts
src/types/leave.ts
src/types/lifecycle.ts
src/types/platform-licence.ts
src/types/site-settings.ts
src/types/store.ts
src/types/ticket.ts
src/types/user.ts
```
