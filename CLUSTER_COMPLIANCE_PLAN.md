# Supabase Migration — Design Plan: Cluster COMPLIANCE + DISCIPLINE

- Role: design verifier only. Written from the real code; contains NO migration code.
- Base tree verified: `feat/integration-wave3 @ 4d5a1e16` (worktree `~/workspace/fix-ab/wt-supa-compliance-0`, branch `feat/supa-compliance-0`). Zero live Firestore reads. All line numbers are from that tree.
- Adapter contract (sibling branch `feat/supa-adapter`, `src/lib/supa/{client,flags,adapter}.ts`; NOT in this base tree):
  - `getSupaClient(): SupabaseClient | null` — null when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` unset; never throws.
  - `useSupa(surface)` — parses `SUPA_SURFACES` (comma list, `*`=all, case-insensitive); default OFF.
  - `getSupaAdapter()` = `getDoc(path,id)`, `listDocs(path,{where?:[field,op,value][],orderBy?,limit?,startAfter?})`, `countDocs(path,where?)`, `setDoc(path,id,data,{merge?})`, `updateDoc(path,id,updates)`, `deleteDoc(path,id)`. Ops `== != < <= > >= in array-contains`. Returns `{id,...data}` / plain counts.
  - Tables: collection `X` -> `fs_X`; 3-segment path `a/{id}/b` -> `fs_group_b` by `parent_path`; row `{id text pk, firebase_uid, parent_path, data jsonb}`.
  - Adapter limits shaping this plan (adapter.ts header): numeric range/order compares TEXT extraction (`'100'<'99'`); `updateDoc` is racy read-modify-write; `setDoc merge` top-level only; NO transaction, NO batch, NO `serverTimestamp/increment/arrayUnion`, NO `.select()` projection, NO listener. Paths needing those stay Firestore or keep Firestore as writer with mirror-on-write (RESILIENCE_PLAN Phase 2).

## 0. Global rules, all groups

1. ONE seam module per group (below). No other file imports `@/lib/supa/*`. Other files keep today's Firestore calls or call the seam.
2. Gate at every seam entry: `if (useSupa('<surface>') && getSupaClient()) supa else existing Firestore path, byte-for-byte`. Flag OFF / client null = indistinguishable from today.
3. Byte-identical responses: same JSON shapes, status codes, and field presentation as today. Where today code calls `.toDate()/.toMillis()`, conversion happens inside the seam via ONE helper per seam, `toDateValue(v)` handling `string | Date | {toDate} | {seconds,nanoseconds} | null`. No shim objects pretending to be Timestamps; no scattered conversions.
4. Writes flip only when the surface is supa-primary for that collection; before that, transaction writers stay Firestore (per-group rulings) and reads flip last, only after dump/mirror data exists — an empty compliance/discipline read is a legal-semantics failure, not cosmetic.
5. Migration order inside each group: single-doc gets -> bounded lists -> full lists -> non-transactional single-doc writes -> everything else only as ruled.

---

## G1 — Discipline core (incl. threshold-ban + appeals data paths)

Surface: `useSupa('discipline')`. Seam: `src/lib/server/discipline/supa-seam.ts`, name `disciplineData`.
Wraps exactly: `getDoc/listDocs('disciplinary_cases',…)`, `getDoc/listDocs('deadline_miss_records',…)`, `listDocs('expulsions',{where:[['userId','==',uid],['status','==','active']]})`, `getDoc('settings','discipline')`, `getDoc('warningConfig','global')` (read half), `getDoc/listDocs('governance_votes',…)` + `listDocs('governance_votes/{voteId}/ballots')` (read half only).
NOT in seam: any write to `disciplinary_cases`, `users`, `users/{uid}/warnings`, `counters`, `audit_logs`, `points_audit`, `tasks`, `roles`.

### G1 files (24 server files; brief listed 8 lib + 5 routes — incomplete, see §5)

Lib, `src/lib/server/discipline/` (11) + threshold-ban:
- `apply-decision.ts` (549L): `runTransaction` x3 (L202, L407, L491); pre-tx `roles where role==` L68, `users.doc.get` L150; in-tx `tx.update(caseRef)`, `tx.set` on `users/{uid}/warnings` (L226, L249), `tx.update(userRef)` sanction fields; `Timestamp.fromDate` L259/272/273/425/505/506. Collections: disciplinary_cases, users, users/*/warnings, roles.
- `case-service.ts` (771L): create-case `runTransaction` L303 (counter `counters/disciplinary_cases_{year}` L298-307 + case set L378 in one tx); get L394; `ref.update` L627/644/757; FULL `governors.get` L610; list `disciplinary_cases where status==` L703-705 (expireStaleDrafts).
- `derived-counter.ts` (83L): projected query `where subjectUid== .select('status','strikeNumber','founderReview')` L22-25, L54-56 (adapter has NO projection — seam returns full docs, drop client-side); `tx.update(userRef,{warningCount})` L39; get+update L66/78.
- `miss-records.ts` (219L): get-then-set `deadline_miss_records.doc(id)` L56-72; `roles where role== limit(1)` L78, `roles where` L87 + `users.doc.get` L89; `tasks.doc.get` L108; `users.doc.get` L114; list `where status=='recorded'` L138; disciplinary_cases get L157-161; update L209.
- `referral.ts` (109L): two independent single-doc updates L65/L86/L106 — NOT transactional today; do not "improve" into a tx.
- `stanzas.ts` (89L): `users where privilegesSuspendedUntil != null` L27 + per-doc update L33; `disciplinary_cases where status=='notice_issued'` L72.
- `vote-adapter.ts` (186L): FULL `governors.get` L29; `governance_votes.doc().set` L56-57 + case update `{boardVoteId}` L71 (two writes, NOT a tx); vote get L82/141; SUBCOLLECTION `governance_votes/{id}/ballots.doc(voterUid).set` L91; ballots get L147 + vote update L152; case update L178.
- `adapters.ts` (250L): `roles.doc.get` L85/187, `users.doc.get` L95 (office resolution — FD-11, see invariants); audit write `audit_logs` via `tx.set` OR `ref.set` L137-151 (dual signature — seam must NOT unify); `tasks.doc().set` L238. All foreign-owned collections.
- `adapters-probation.ts` (73L): `probation_restores where status=='pending'` L27; per-doc update L53. G1 file, G2 collection: consumed through G2's seam; G1 must NOT build a second probation reader.
- `settings.ts` (53L): single get `settings/discipline` L33, in-code defaults on miss.
- `suspension.ts` (89L): `users.doc.get` L59/85; pure date logic, `toMillis` duck-type L21.
- `src/lib/server/threshold-ban.ts` (135L): ONLY live call = `expulsions where userId== where status=='active'` L93-96 (`hasExpulsionRecord`). Rest is pure: patterns L38-41, `evaluateRestoration`. Header L58-71: the threshold WRITE was already deleted.

Routes (12):
- `api/discipline/cases/route.ts`: query built L84, `orderBy('initiatedAt','desc').limit(200)` L89 (ISO-string field; text order correct only because values are ISO — verify per contract test).
- `api/discipline/cases/[caseId]/route.ts` (112L), `[caseId]/decide` (37L), `[caseId]/board` (73L), `[caseId]/referral` (45L): no direct Firestore; delegates only.
- `api/discipline/miss-records/route.ts`: `deadline_miss_records where detectedAt >= since` L37-39 — RANGE on a date field; adapter compares TEXT. Safe only if `detectedAt` is ISO string in every doc; contract test must pin it, else this read stays Firestore.
- `api/discipline/my-cases/route.ts`: `disciplinary_cases where subjectUid==` L32-34.
- `api/discipline/my-review/route.ts` (54L): delegate only (brief omitted it).
- `api/discipline/request-founder-review/route.ts`: single case update L59 — an APPEALS data path, non-tx today.
- `api/admin/founder-review/route.ts` (255L): `runTransaction` x3 (L102/119/161): case founderReview + user sanction clearing + warning revoke `users/{uid}/warnings.doc(id).update({status:'revoked'})` L143-144 + recount reading ALL user warnings L182 + `points_audit.doc().set` (`Timestamp.fromDate` L191-197); non-tx case updates L228/236; `roles where role== limit(1)` L48.
- `api/admin/performance-records/route.ts`: cases list L54-57; per-uid `users.doc.get` L91; `deadline_miss_records .select('subjectUid')` L100 (projection again).
- `api/admin/banned-restore-report/route.ts`: `warningConfig/global.get` L67; users query L83-85; `audit_logs.add` L121 (`Timestamp.now` L127) — READ-mostly but has an audit WRITE; not a pure read.

Client surfaces — OUT of G1 code scope (client/UI cluster), IN verification scope: `app/admin/discipline/{page,[caseId]/page,new/page}.tsx`, `app/profile/discipline/[caseId]/page.tsx`, `app/banned/page.tsx`, `components/admin/discipline/{discipline-queue,performance-records-panel}.tsx` — all fetch-only (verified). TWO direct client-SDK readers, assigned to the client cluster because the adapter is service-role/server-only (client.ts header forbids browser import): `components/admin/discipline/defaulters-register.tsx` (797L: client `getDocs` on warningConfig/global, chapters, `users where warningCount>0 / isBlacklisted==true / isBanned==true`, and `users/{uid}/warnings`) and `discipline-settings-panel.tsx` (client `getDoc warningConfig/global` + fetch to `/api/admin/discipline-settings`). The client cluster must not import `src/lib/supa/*`.

### G1 timestamp hotspots
- apply-decision: L259 warning `issuedAt`; L272-273 Strike-2 suspension window `now + days*DAY_MS` (days 1..60, validated L157-159); L425 `bannedAt`; L505-506 founder-review modify repeats it. Supa mirrors must store ISO strings, never `{seconds,nanoseconds}`.
- case-service: L554 `defenceDueAt = now+7d` ISO; L596 `boardVoteOpensAt = now+7d` ISO; L693-705 draft expiry, 14-day cutoff compared as ISO string L701 (text compare correct ONLY for ISO); L307 counter `Timestamp.fromDate`.
- stanzas L27 `where('privilegesSuspendedUntil','!=',null)`: adapter maps to `not is null` on TEXT extraction; absent-vs-null differs Firestore vs jsonb. Contract test required; on failure the lift scan STAYS Firestore.
- vote-adapter: L62/68/93/154 Timestamp writes. adapters-probation L41: `dueAt?.toDate ? toDate() : dueAt` — seam `toDateValue` must preserve this tolerance.

### G1 never-bulk-migrate (rulings)
STAY Firestore writer; reads flip last, via seam, only after a mirror exists:
1. `applyCaseDecision` tx (apply-decision:202) — case + warning subcollection + user warningCount/suspension atomically. No adapter tx; `updateDoc` is racy read-modify-write.
2. `applyExpulsionBan` tx (apply-decision:407) — the ONLY `isBanned:true` writer platform-wide. No exceptions.
3. Founder-review txs (apply-decision:491 AND founder-review route:102/119/161 — TWO implementations exist; do not merge them) — sanction clearing + warning revoke + points_audit atomically.
4. Case creation tx (case-service:303) — counter increment + case doc; case numbers must not duplicate. (A Postgres sequence is a redesign, not a migration.)
Mirror-on-write for 1-4, if added, is post-commit/best-effort/logged in the owning route — never inside the tx, never by the seam.
MAY migrate as plain seam writes (non-tx today): transitionCase updates (L627), notice stamp (L644), referral updates, request-founder-review update, vote ballot set + vote close (preserve today's ordering/failure window), miss-record idempotent set. G1 has NO `writeBatch` today; do not introduce one.

### G1 legal-semantics invariants (preserve exactly)
- Nothing blacklists/bans at 3 warnings: threshold WRITE removed (threshold-ban.ts:58-71, "a threshold crossing writes NOTHING"); patterns L38-41 are read-only matchers for legacy strings. DECISION_PACK item 40 restates policy to the decided-case regime. Do not rebuild auto-blacklisting in any seam.
- A warning is the Strike-1 outcome of a DECIDED case: apply-decision L226/249-267 — warning doc created only in the decision tx on `decision==='strike1'`, `warningCount` set to the DERIVED count, never blindly incremented.
- `warningCount` is derived: derived-counter.ts:15-35 — cases with `status in (sanction_applied, closed)` AND `strikeNumber != null` AND `founderReview.outcome != 'revoke_sanction'`. Sole writers = apply-decision, derived-counter, clear-probation (grep-invariant.test.ts:29-34, T-GREP-1). A seam writing `warningCount` fails T-GREP-1.
- `isBanned:true` sole writer = expulsion branch; `isBlacklisted` written only by founder reinstatement, to `false` (grep-invariant:22-28). Legacy `isBlacklisted` NEVER auto-clears: `evaluateRestoration` (R5) clears a ban only in the same write that clears the blacklist, only for a threshold-pattern banReason, only with NO active expulsion record.
- State machine EXACTLY `case-service.ts:21-36` (initiated, notice_draft, notice_issued, defence_received, defence_window_closed, hearing, decided, board_notice_issued, board_vote_open, board_decided, decided_outcome_failed, sanction_applied, closed, dismissed) + `TRANSITIONS` :405-425. `transitionCase` is the only status writer outside the decision tx (header :1-10); `decided`/`sanction_applied` are `actor:'internal'`, rejected in transitionCase. A seam transports status; it never transitions it.
- FD-11 (office resolvers in adapters.ts are primary-role-only) is a known defect: reproduce, do not fix in migration.

---

## G2 — Probation + compliance

Surface: `useSupa('compliance')` (probation uses the SAME surface — clear-probation hosts both; do not invent a second flag). Seam: `src/lib/server/compliance/supa-seam.ts`, name `complianceData`.
Wraps exactly: `getDoc/listDocs` for `compliance_obligations`, `default_notices`, `compliance_templates`, `compliance_reports`, `compliance_triggers`, `probation_restores`; `getDoc('compliance_meta','generator')` + `setDoc('compliance_meta','generator',…,{merge:true})`; `updateDoc('probation_restores',…)`; and the shared loaders `loadObligation/loadNotice` (access.ts:44-62) re-pointed at the seam so all loader-based routes migrate at once.
NOT in seam: `users`, `roles`, `chapters`, `audit_logs` (foreign clusters — compliance code keeps its Firestore handle for those), and `serverTimestamp` writes (see hotspot rule).

### G2 files (32 server files; brief named lifecycle-probation + clear-probation + admin routes only — the server lib and owner routes were omitted)

Lib (11):
- `src/lib/server/lifecycle-probation.ts` (498L): `probation_restores.doc(warningId).get/set` L85-127 (capture; id=warningId), update L197-198, get+update L232-279 (process), `roles.doc.get` L92/354, `users.doc.get` L179/246, FULL `probation_restores.get` L411 (retry), FULL `users.get` L443 + FULL `audit_logs.get` L446 (backfill), set L457-478. Exports: capture L81, processProbationRestore L227, retry L406, backfill L437.
- `compliance/access.ts` (62L): `users.doc.get` L39; `loadObligation` obligations get L48-49; `loadNotice` default_notices get L58-59. THE chokepoint — cure/waive/cure-review/intervention/evidence/review routes all load here.
- `compliance/cron.ts` (488L): FULL obligations get L77; FULL templates get L89; per-row `ref.update` L105/142/217/227; `default_notices.doc().set` L291-292; notice get L351-352 + update L367; `default_notices where issuedAt != null` L399; update L434. `serverTimestamp` L108/144/161/311/312/370/436.
- `compliance/generator.ts` (313L): `templates where active==true` L246; FULL `chapters.get` L253 (foreign); `compliance_meta/generator` get L257-258; per-instance obligations get L270-271 + set L277 (deterministic docId, get-then-set idempotent); meta `set {merge}` L309; `Timestamp.fromDate(dueDate)` L287.
- `compliance/report-service.ts` (193L): parallel FULL gets L53-55 (obligations, default_notices, `audit_logs where governance==true` with `.catch(()=>null)` — preserve that tolerance); reports get/set L87-102, get L116-117; users get L136-138; obligations scan L166-168 + `candidate.ref.update` L174.
- `compliance/report-aggregator.ts` (321L): NO Firestore; pure over fetched rows; `toDate()` normalizer L136; header L7-8 source precedence: default_notices WIN over audit_logs, discrepancy counted. Seam must feed identical row shapes.
- `compliance/serialize.ts` (27L): pure; Timestamp-like/Date -> ISO. The existing precedent for the seam's `toDateValue`.
- `compliance/transitions.ts` (88L): pure status tables — obligation/notice vocabularies. Transport, never alter.
- `compliance/http.ts` (20L), `compliance/owner-resolution.ts` (56L): no Firestore calls (verified) — listed so implementers do not hunt in them.

Routes — admin (14): `admin/compliance/notices/route.ts` (FULL default_notices get L25); `notices/[id]/issue/route.ts` (`runTransaction` L50 + post-tx delivery-receipt update L111); `notices/[id]/cure-review/route.ts` (notice L48 + obligation L70 + notice L76 sequential non-tx updates via loaders); `notices/[id]/intervention/route.ts` (obligation update L60; NEW obligation `doc({templateKey}__evt__intervention-{id}).set` L73-75, `Timestamp.fromDate(newDueDate)` L85; updates L104/113/119); `obligations/route.ts` (FULL get L41); `obligations/[id]/cure/route.ts` (notice update via loader); `obligations/[id]/waive/route.ts` (obligation update L48); `reports/route.ts` (FULL get L28); `reports/[quarterKey]/generate` + `/deliver` (delegate to report-service); `templates/route.ts` (FULL get L22); `templates/[key]/route.ts` (get L42, get L60-61, update L72); `triggers/route.ts` (triggers query L71-74, template get L85, `triggers.doc().set` L111-115 + `obligations.doc().set` L131-141 — paired creation, NOT a tx); `triggers/list/route.ts` (FULL get L24).
Routes — owner-facing (4; BRIEF MISSED THESE, they are `/api/compliance/**` not admin): `compliance/mine/route.ts` (`roles.doc.get` L26 + obligations query L30-32); `compliance/obligations/[id]/route.ts` (template get L33, notice get L52, audit_logs get L57-59); `…/evidence/route.ts` (template get L45, obligation update L71); `…/review/route.ts` (template get L35, obligation updates L63/87 — the FD-13 route: POST lacks the founder-UID arm its GET sibling has; reproduce, do not fix).
Crons (3): `cron/clear-probation` (326L — shared host, detailed in G3), `cron/compliance` (64L, delegates to compliance/cron.ts), `cron/compliance-report` (49L, delegates to report-service). Both compliance crons have NO manual arm (FD-22); migration adds none.
Admin pages (5): `app/admin/compliance/{page,notices/page,obligations/[id]/page,templates/page,triggers/page}.tsx` — ALL fetch-only, no client-SDK Firestore (verified). IN this cluster's verification scope (their payloads are the contract), OUT of its code scope.

### G2 timestamp hotspots
- `FieldValue.serverTimestamp()` on nearly every compliance write (cron x7, generator L302-303/309, report-service L102/156/185, every admin route update). Adapter has none. Seam rule: seam writes substitute `new Date().toISOString()`. That changes stored type, so compliance WRITES flip only when supa-primary for that collection; reads must tolerate both shapes (serialize.ts already does).
- `dueDate` is a real Firestore Timestamp (generator:287, triggers:141, intervention:85). In jsonb it must be an ISO string; cron L62 / aggregator L136 `toDate()` normalizers + ladder/cure-clock comparisons are the date-sensitive core. Adapter range/order on `dueDate` is TEXT — correct for ISO, wrong for `{seconds,nanoseconds}`. Contract test pins the dumped shape BEFORE cron reads flip.
- `lifecycle-probation.ts:378` writes `updatedAt: new Date()` (JS Date — existing inconsistency; reproduce).
- cron.ts:399 `where('issuedAt','!=',null)` — same null-vs-absent hazard as G1 stanzas.

### G2 never-bulk-migrate (rulings)
1. `notices/[id]/issue` tx (L50) — obligation + notice with cure clock starting atomically. STAYS Firestore; the post-tx receipt update (L111) migrates only with it.
2. Probation process/restore (lifecycle-probation L227-398) — writes probation_restores + role reappointment on `roles` + user fields, mode-dependent (`probationRestoreMode`). Cross-cluster. STAYS Firestore writer; probation_restores READS (retry L411, pending list adapters-probation:27) flip via seam only after a mirror exists. FD-23: settings GET reports mode `auto` while the runner executes `reappoint` semantics (FOUNDER_ACCESS_MAP) — reproduce, flag, do not fix.
3. Generator creation (L270-309) — MAY migrate as seam getDoc+setDoc (idempotency is by deterministic docId, not tx) but ONLY as one unit with the meta doc; obligations-without-meta double-generates.
4. Triggers paired set — non-tx today; MAY migrate as two seam setDocs in the SAME order; do not add atomicity.
5. Backfill (L437-498) — full users + audit_logs scans, one-shot operational code. OUT of migration; stays Firestore.

### G2 legal-semantics invariants
- Status vocabularies/transitions are transitions.ts + access.ts loaders; the seam never validates or advances status.
- Report precedence: report-aggregator.ts:7-8 (notices win, discrepancy counted, never silently resolved).
- Cure clock starts ONLY in the issue transaction; no migrated cron/route may set `issuedAt` or cure deadlines elsewhere.
- No lawful manual trigger for compliance crons (FD-22): add no arms/tokens/shortcuts.
- Probation restore restores the role snapshot from captureProbationRestore (L85-127) and NEVER writes warning fields (keeps T-GREP-1 green).

---

## G3 — Erasure + warnings readers + consent-gate reads

Surface: `useSupa('erasure-consent')` (one surface for the group; NOT `consent` alone — consent WRITES are the governance cluster's, §4). Seam: `src/lib/retention/supa-seam.ts`, name `retentionConsentData`.
Wraps exactly: `getDoc/listDocs('erasure_requests',…)` incl. `orderBy requestedAt desc, limit`; `setDoc/updateDoc('erasure_requests',…)` via the deps adapter below; `getDoc/listDocs('consent_requests',…)`; `getDoc('governance_settings','phase2')`; `getDoc('settings','consent_config')`.
Key design point: erasure is ALREADY seam-shaped. `ErasureDeps {db, deleteAuthUser, writeAudit, now}` is injected (`src/lib/retention/server-deps.ts`, 23L). Migration = a second factory `createErasureDepsSupa()` beside `createErasureDeps()`, selected by the flag in the two route files. `erasure.ts` changes ZERO lines. Same wrap-don't-rewrite pattern for consent-lookup (its functions take `db`).

### G3 files (verified)
- `src/lib/retention/erasure.ts` (188L): `ERASURE_REQUESTS_COLLECTION = 'erasure_requests'` L21 (CONFIRMS: not `data_erasure_requests`); duplicate-open-request query L51-54; `.add({...})` L62 (auto-id — supa deps must generate the id and use setDoc, preserving the returned shape); get L100-101; execute: `users.doc.set` pseudonym overwrite L121-123, `roles.doc.get` L130 + update `{memberStatus:'erased'}` L132, `points_ledger where…get` L137-139 + per-doc update `{userId: pseudonym}` L141, request update L149; withdraw get L173-174 + update L181. All dates ISO via `deps.now()` — NO Timestamp hotspots here.
- `api/account/erasure-request/route.ts` (61L): no direct Firestore; deps + requestErasure/withdrawErasure. Only change: deps-factory selection. (14-day cooling-off, per its header.)
- `api/admin/erasure-requests/route.ts` (34L): DIRECT `erasure_requests orderBy('requestedAt','desc').limit(50)` L28-31 -> seam listDocs (ISO strings, text order correct).
- `api/admin/erasure-requests/[id]/execute/route.ts` (36L): no direct Firestore; deps + executeErasure. The ONLY path that deletes a Firebase Auth account (header) — Auth deletion is not a data-migration item and stays Firebase regardless.
- `src/lib/retention/server-deps.ts` (23L): `audit_logs.add({…, timestamp: new Date()})` L16 — stays Firestore (foreign cluster); the supa factory reuses this exact writeAudit.
- `src/lib/retention/engine.ts` (227L): GENERIC: `collection(policy.collection).get` L127, per-doc update/delete/scrub L167-210, `toDate()` normalizer L73. Ruling: OUT of this cluster (shared infra; migrating it migrates every retention policy at once).
- `src/lib/retention/policies.ts` (190L): catalog rows in code — `warnings` L59-67 (retain 10y, F-G5 interim pending Decision 14), `consents` L81+; live store `retention_policies` get L124-126 + set-merge L185-187. Ruling: catalog rows change zero lines; the doc-store flip is the retention cluster's single decision for ALL policies (§4).
- `src/lib/server/member-lifecycle.ts` (297L): ERASURE TOUCHPOINT CHECKED — header L12: erasure "belongs only to the separate erasure flow, which is out of scope here". Only shared surface = vocabulary `MemberStatus 'active'|'departed'|'erased'` L18 + normalization L84. Its writes (`role_history.add` L101, roles L103-106, positions L131-144, users + `db.batch()` L170-204, audit_logs L221/287) belong to the lifecycle/roles cluster. ZERO G3 lines. Invariant: `erased` stays terminal and distinct from `departed` ("Departed members are never erased" — execute route header).
- `src/lib/server/consent-gate.ts` (600L): mode via `getConsentMatterSettings(db, matterKey)` — import L33, call sites L291 (recordMode) and L518 (assertConsentFor; read EVERY call, no cache); decided consent via consent-lookup; `roleDefinitions.doc.get` L207 (foreign). Writes: `tasks.add` L325 (retroactive-consent task, record mode); dynamic-target stamp `doc(target.collection).doc(target.id).set({consentMode:'record', consentGateLoggedAt: serverTimestamp},{merge})` L358-359 (targets resolved L268-283: chapters/roleDefinitions/roles/partner records); audit via adapters (foreign). Date normalizer L71-84 feeding `consentExpiryDate` L134.
- `src/lib/server/consent-lookup.ts` (177L): `consent_requests.doc.get` L121; find-decided query L140-145; `consumeConsent` `runTransaction` L161-171 (`tx.update {consumedAt: serverTimestamp}`) — single-use consumption. Timestamp union type L86.
- `src/lib/consents/consent-config.ts` (59L): reads `settings/consent_config` L22 — `getConsentConfig` (filingsEnabled + founderRootMode; defaults L16-19; ANY error -> defaults) and `isConsentDecider` L44-59 (Decision 6 switch: founder-only in BOTH modes until Decision 6 lands). It does NOT read the gate mode (see §5.5).
- `src/lib/server/governance-settings.ts` (214L): THE ACTUAL GATE-MODE READER (brief omitted it): `getGovernanceSettings` reads `governance_settings/phase2`; `getConsentGateMode` L108-115; `getConsentMatterSettings` L178-205; `isPhase2Live` L118-151 (dual call-shape + raw-doc second read L146). All uncached, per call.

Warnings readers (readers of `users/{uid}/warnings`; none is a writer):
- `api/profile/[userId]/route.ts`: subcollection get L162-165; mapping L424-431 with section-status envelope (error -> `warnings: []`, `sectionStatuses.warnings.success=false`, L417-431). Its requester-blind 60s cache (H-25) is preserved exactly.
- `api/profile/[userId]/telemetry/route.ts`: subcollection get L85 in a 6-way `Promise.all` L79; raw warnings mapped L112; probation countdown from warning dates — DATE-SENSITIVE.
- `components/admin/discipline/defaulters-register.tsx`: client-SDK reader — client cluster per G1 ruling; listed here so its expected shapes stay the ones the seams emit.
- `src/lib/backup/registry.ts` (137L): RULING — OUT, with reason: static catalog, zero Firestore calls (rows: warnings/warningConfig L48-49, consents/compliance_obligations L116-117, erasure_requests L120). Nothing to migrate. It IS a handoff dependency: every flipped collection already has a registry row (verified), and the backup cluster must be told storage moved or backups keep snapshotting Firestore. One-line note, no code.
- Also found (brief omitted): `src/lib/warning-restore.ts` (CLIENT MIRROR of threshold-ban.ts — header there says keep in sync; client cluster), `api/public/warning-registry/route.ts` (gated by `warningRegistryVariant`), `api/admin/discipline-settings/route.ts` (`settings/discipline` + warningConfig; READ halves via G1 seam, write halves stay with the settings cluster).

### G3 timestamp hotspots
- consent-gate L71-84 + `consentExpiryDate` L134: validity (default 90 days, governance-settings `DEFAULT_VALIDITY_DAYS`) computed from decided-consent dates arriving as `Timestamp | Date | string` (consent-lookup:86). In jsonb they arrive as strings/objects only — seam `toDateValue` must handle `{seconds,nanoseconds}` dump shapes or HARD mode passes/blocks wrongly. Highest-risk hotspot in the cluster.
- consent-lookup:171 `consumedAt: serverTimestamp` (inside the tx; stays Firestore).
- telemetry: warning `issuedAt/expiresAt` drive the countdown; Strike-1 warnings carry `expiresAt: null` (apply-decision:261) = non-expiring; readers must keep that.
- erasure: none. Erasure-request lifecycle is the safest first flip in the whole cluster.

### G3 never-bulk-migrate (rulings)
1. `consumeConsent` tx (consent-lookup:161) — consumption must stay atomic; two concurrent gated acts must not consume one consent twice. STAYS Firestore. Consequence: `consent_requests` reads (L121/L140) flip ONLY if a mirror exists that the governance cluster's consent-service writes on every decide/consume; otherwise the gate reads stale "unconsumed" Postgres state. Default: consent_requests reads flip LAST in this cluster, gated on that mirror.
2. `executeErasure` (erasure.ts:100-160) — multi-collection destructive sequence + Auth deletion, sequential (not a tx) today. Ruling: execute path STAYS on Firestore deps this wave; only the request lifecycle (request/withdraw/list) flips via the supa deps factory. A half-executed erasure against a second store doubles the failure surface of the platform's only irreversible, legally-loaded operation.
3. `consent-service.ts` — NOT this cluster (governance): founder-act tx L365, batches L500/1053/1118/1174, txs L883/1208. The gate imports `createFounderActConsent` from it (consent-gate:38); seam boundary = that function call, unchanged.

### G3 legal-semantics invariants + THE CONSENT INCONSISTENCY (flag, do NOT fix)
- THE TWO MODE READERS DISAGREE ON ABSENCE:
  - `getConsentMatterSettings` (governance-settings.ts:178-205) — the reader the LIVE gate uses (consent-gate.ts:33, :291, :518): doc missing -> `{mode:'record', source:'missing'}` :187 (catch path :190); matter key absent -> `{mode:'record', source:'missing'}` :202; malformed -> `{mode:'record', source:'malformed'}` :204. FAILS OPEN to record.
  - `getConsentGateMode` (governance-settings.ts:108-115): missing key -> `'hard'`. FAILS CLOSED. ZERO production consumers (verified: no non-test caller outside governance-settings.ts).
  - Acknowledged in code at governance-settings.ts:153-167 ("Both contracts are kept as their specs wrote them; the divergence is recorded in the integration log"); confirmed live as H-20 in FOUNDER_ACCESS_MAP_2026-10-25.
  - Settings-API half (FD-23): `api/governance/settings/route.ts` writes `consentGateMode` (:96-112), `probationRestoreMode` (:114-119), `warningRegistryVariant` (:121-126), flags — but CANNOT write `lifecycleEnforce` or `ratificationRevocationArmed` (absent from the route), while written `consentLive`/`disciplineLive` have zero consumers. That route is the governance cluster's; this plan requires only: the seam's `getDoc('governance_settings','phase2')` must make `getConsentMatterSettings` classify Firestore-absent, supa-absent, and supa-present-but-field-absent IDENTICALLY — `missing`, never `doc`.
  - Defaults mismatch (H-20): 3 of 5 `DEFAULT_GOVERNANCE_SETTINGS.consentGateMode` keys (governance-settings.ts:44-50) match no matter key some gate paths query. Preserved as-is.
- `isConsentDecider` (consent-config.ts:44-59): founder-only in both modes until Decision 6; a supa-side config must never widen it. `getConsentConfig` fails to DEFAULTS on any error — the seam must return null-on-miss and let that try/catch semantics run, never throw past it.
- Erasure: 14-day cooling-off; withdraw only by owner; execute only after cooling-off; departed != erased; pseudonym deterministic `erased-{sha256(uid)[:12]}` (erasure.ts:42).
- Profile warnings: a supa failure must land in the existing error branch (`[]` + section status false), never 500 the profile.
