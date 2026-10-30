/**
 * Consent gate on Reserved Matters (Phase 2, Workstream B - spec Section B.2).
 *
 * assertConsentFor is the ONLY place any route, action, or server function
 * checks Founder Consent for a gated act. Mode (hard | record) comes from
 * settings/governance on EVERY call - no cache - so a mode flip takes effect
 * on the next attempted act (spec B.8 rollback).
 *
 * Hard mode: the consent is CONSUMED inside the gate before returning, so
 * callers must call the gate as the LAST check before their write batch,
 * after all validation and permission checks. Consents are single-use.
 * Record mode: never blocks; writes the audit entry and creates the Founder's
 * retroactive-consent task (spec B.2.3).
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID, LEGACY_ROLE_MAP } from '@/lib/roles';
import { getDb } from '@/lib/server/firebase-admin';
import {
  CATEGORY_B_ROLE_KEYS,
  ConsentRequiredError,
  type ConsentBlockReason,
  type ConsentMatterKey,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';
import {
  consumeConsent,
  getDecidedConsent,
  listDecidedConsentCandidates,
  type DecidedConsentDoc,
} from '@/lib/server/consent-lookup';
import {
  getConsentMatterSettings,
  type ConsentMatterSettings,
} from '@/lib/server/governance-settings';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { getRoleDefinitionDoc } from '@/lib/server/role-definitions-cache';
import { isFounderUid } from '@/lib/server/founder-gate';
import { getSupaAdapter, isSupaPrimary, useSupa } from '@/lib/supa';
import { createFounderActConsent } from '@/lib/server/consent-service';
import {
  consentActMatchFailure,
  consentSubjectsMatch,
} from '@/lib/server/consent-subject';
import { notificationService } from '@/lib/server/notification-service';

export type { ConsentMatterKey, ConsentSubjectRef } from '@/lib/server/consent-gate-types';
export { ConsentRequiredError } from '@/lib/server/consent-gate-types';

export type ConsentGatePass =
  | { mode: 'hard' | 'record'; outcome: 'founder_act'; consentRequestId: string }
  // Retained ONLY for the allowFounderAutoConsent opt-out path (G12,
  // sync-user-role - a probe that never performs the act).
  | { mode: 'hard'; outcome: 'founder_actor' }
  | { mode: 'hard'; outcome: 'consented'; consentRequestId: string }
  | { mode: 'record'; outcome: 'recorded'; consentRequestId: string | null };

export interface AssertConsentArgs {
  db?: Firestore;
  actorUid: string;
  matterKey: ConsentMatterKey;
  consentRequestId?: string | null;
  subjectRef: ConsentSubjectRef;
  actSummary?: string;
  now?: Date;
  /**
   * Founder auto-consent (Fix 1). Defaults to true when absent.
   * Only consulted inside the founder branch: when false, a founder
   * actor takes the legacy record-free founder_actor pass. Set false
   * only at probe call sites that never perform the gated act (G12).
   */
  allowFounderAutoConsent?: boolean;
}

// ---------------------------------------------------------------------------
// Date normalisation (consent docs carry Timestamp | Date | string values).
// ---------------------------------------------------------------------------

export function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof v.toDate === 'function') {
      const d = v.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    const seconds = typeof v.seconds === 'number' ? v.seconds : v._seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subject matching (spec B.2 step 8): discriminating fields per type.
// ---------------------------------------------------------------------------

/**
 * The gate's subject predicate is the shared consentSubjectsMatch
 * (consent-subject.ts) — the SAME function the founder-act writer's
 * dedupe re-check calls, so the two layers can never diverge again
 * (Reviewer 2 defect F1: the writer's old deep-equality re-check
 * rejected the role_definition permissions/scope pair this predicate
 * accepts, and minted duplicate decided consents in the race window).
 * This export is kept for existing importers/tests.
 */
export function subjectMatches(requestSubject: unknown, subjectRef: ConsentSubjectRef): boolean {
  return consentSubjectsMatch(requestSubject, subjectRef);
}

/** Canonical string stamped as consumedActRef (spec B.2 step 9). */
export function canonicalSubjectRefString(subjectRef: ConsentSubjectRef): string {
  switch (subjectRef.type) {
    case 'user_role':
    case 'position':
      return `roles/${subjectRef.targetUid}`;
    case 'chapter_application':
      return `chapter_applications/${subjectRef.applicationId}`;
    case 'chapter':
      return `chapters/${subjectRef.chapterId}`;
    case 'role_definition':
      return `roleDefinitions/${subjectRef.slug}`;
    case 'partner_record':
      return subjectRef.recordId != null
        ? `${subjectRef.collection}/${subjectRef.recordId}`
        : `${subjectRef.collection}/${subjectRef.organizationName ?? 'new'}`;
  }
}

/**
 * Consent validity window (spec B.2.1): earliest of proposedActDate + 30 days
 * and decidedAt + validityDays; an explicit expiresAt on the request wins if
 * earlier. Null when no bound is computable.
 */
export function consentExpiryDate(
  request: DecidedConsentDoc,
  validityDays: number,
): Date | null {
  const bounds: number[] = [];
  const proposed = toDate(request.proposedActDate);
  if (proposed) bounds.push(proposed.getTime() + 30 * 24 * 60 * 60 * 1000);
  const decided = toDate(request.decidedAt);
  if (decided) bounds.push(decided.getTime() + validityDays * 24 * 60 * 60 * 1000);
  const explicit = toDate(request.expiresAt);
  if (explicit) bounds.push(explicit.getTime());
  if (bounds.length === 0) return null;
  return new Date(Math.min(...bounds));
}

// ---------------------------------------------------------------------------
// HTTP mapping (spec B.2.4).
// ---------------------------------------------------------------------------

export function consentGateHttpError(err: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (err instanceof ConsentRequiredError) {
    return {
      status: 409,
      body: {
        error: 'CONSENT_REQUIRED',
        code: 'CONSENT_REQUIRED',
        matter: err.matterKey,
        reason: err.reason,
        subject: err.subjectRef,
        consentRequestId: err.consentRequestId,
        fileRequestUrl: err.fileRequestUrl,
      },
    };
  }
  return {
    status: 500,
    body: { error: 'CONSENT_CHECK_UNAVAILABLE', code: 'CONSENT_CHECK_UNAVAILABLE' },
  };
}

// ---------------------------------------------------------------------------
// Category B detection (spec B.3a).
// ---------------------------------------------------------------------------

/**
 * ADAPTER(Phase 1): the Phase 1 resolver canonicalises role keys. Until it
 * lands on this base, canonicalisation is trim/lowercase plus the existing
 * LEGACY_ROLE_MAP in src/lib/roles.ts (identity when unmapped).
 */
export function canonicaliseRoleKey(roleKey: string): string {
  const clean = String(roleKey ?? '').trim().toLowerCase();
  const mapped = LEGACY_ROLE_MAP[clean];
  return mapped ? mapped.role : clean;
}

/**
 * Gated-ness test for Category B: the role definition's `category` field is
 * authoritative (spec B.3a). Missing definition = NOT Category B (unknown
 * roles are Phase 1's allowlist problem).
 */
export async function isCategoryBRole(
  db: Firestore | null | undefined,
  roleKey: string,
): Promise<boolean> {
  const canonical = canonicaliseRoleKey(roleKey);
  if (!db) {
    // ADAPTER fallback: without a db handle the definition cannot be read;
    // fall back to the catalog key list so server routes still gate safely.
    return CATEGORY_B_ROLE_KEYS.includes(canonical);
  }
  // RBT2-C: read through the shared cached roleDefinitions reader
  // (seam-first via the roles seam, short-TTL cache) instead of an
  // uncached per-call doc get. Gate semantics identical: a missing
  // definition is NOT Category B, and a load error still propagates.
  const data = await getRoleDefinitionDoc(db, canonical);
  if (!data) return false;
  return data.category === 'B';
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

type GateArgs = AssertConsentArgs & { db: Firestore; now: Date };

function block(args: GateArgs, reason: ConsentBlockReason): ConsentRequiredError {
  return new ConsentRequiredError({
    matterKey: args.matterKey,
    subjectRef: args.subjectRef,
    consentRequestId: args.consentRequestId ?? null,
    reason,
  });
}

/**
 * Observe-only evaluation of hard-mode checks 3-9 (spec B.2.3 step 1): never
 * consumes, never throws for a block; infrastructure errors propagate.
 */
async function evaluateConsent(
  args: GateArgs,
  validityDays: number,
): Promise<{ ok: true; request: DecidedConsentDoc } | { ok: false; reason: ConsentBlockReason }> {
  const { db, consentRequestId, now } = args;
  if (!consentRequestId) return { ok: false, reason: 'missing' };
  const request = await getDecidedConsent(db, consentRequestId);
  if (!request) return { ok: false, reason: 'not_found' };
  if (request.status === 'refused') return { ok: false, reason: 'refused' };
  if (request.status === 'deemed_withheld') return { ok: false, reason: 'deemed_withheld' };
  if (request.status === 'conditional') {
    const satisfiedBy = request.conditionsSatisfiedBy ?? null;
    const byFounder = satisfiedBy === FOUNDER_UID;
    const byVerifier =
      satisfiedBy != null &&
      request.conditionsVerifierUid != null &&
      satisfiedBy === request.conditionsVerifierUid;
    // The requester can never satisfy their own conditions.
    const byRequester = satisfiedBy != null && satisfiedBy === args.actorUid && !byFounder && !byVerifier;
    if (request.conditionsSatisfied !== true || (!byFounder && !byVerifier) || byRequester) {
      return { ok: false, reason: 'conditional_unmet' };
    }
  } else if (request.status !== 'consented') {
    return { ok: false, reason: 'not_decided' };
  }
  // Matter + subject across every representation the system produces
  // (matcher fix, 2026-10-26): a consent filed through
  // /admin/consents/new carries a Reserved-Matter key and a free-text
  // Act, never this gate's matterKey/subjectRef pair - the old strict
  // equality here rejected every such record, so a filed, decided
  // consent (FC-2026-0020, FC-2026-0048) could never authorize the act
  // it was filed for. consentActMatchFailure keeps the same reasons.
  const matchFailure = consentActMatchFailure(request, args.matterKey, args.subjectRef);
  if (matchFailure) return { ok: false, reason: matchFailure };
  // Filed records carry their decision time in decisionDate /
  // decidedAtSort, not decidedAt: normalise before the expiry check
  // so their validity window is computed from the real decision.
  const expiryRequest: DecidedConsentDoc =
    request.decidedAt != null
      ? request
      : ({
          ...request,
          decidedAt:
            (request as Record<string, unknown>).decisionDate ??
            (request as Record<string, unknown>).decidedAtSort ??
            undefined,
        } as DecidedConsentDoc);
  const expiry = consentExpiryDate(expiryRequest, validityDays);
  if (expiry && now.getTime() > expiry.getTime()) return { ok: false, reason: 'expired' };
  if (request.consumedAt != null) return { ok: false, reason: 'already_consumed' };
  return { ok: true, request };
}

/** Record-mode stamp target (spec B.2.3 step 4); null when nothing stampable. */
function stampTarget(subjectRef: ConsentSubjectRef): { collection: string; id: string } | null {
  switch (subjectRef.type) {
    case 'chapter':
      return { collection: 'chapters', id: subjectRef.chapterId };
    case 'role_definition':
      return { collection: 'roleDefinitions', id: subjectRef.slug };
    case 'partner_record':
      return subjectRef.recordId != null
        ? { collection: subjectRef.collection, id: subjectRef.recordId }
        : null;
    case 'user_role':
    case 'position':
      return { collection: 'roles', id: subjectRef.targetUid };
    case 'chapter_application':
      return null;
  }
}

/**
 * Record-mode stamp write (identity census R-14/R-15 — the consent
 * gate's hidden writer on roles/{uid} and roleDefinitions/{slug}).
 *
 * Routed through the roles family's primacy law (identity design
 * G-ROLE-9; step-one re-key pattern + mirror discipline), for those
 * two collections ONLY — chapter / partner-record stamps belong to
 * other clusters and keep the plain Firestore write below:
 *
 * - isSupaPrimary('roles'): the adapter merge-set is the PRIMARY leg
 *   (written first), and the Firestore stamp follows as a best-effort
 *   reverse mirror (design decision (a) for G-ROLE-9).
 * - Non-primary with useSupa('roles') on (step-one mirror
 *   discipline): the Firestore stamp first (today's write), then a
 *   best-effort adapter merge-set mirror, so Supa-served role /
 *   definition reads see the stamp during the transition.
 * - Flag OFF: Firestore only, zero adapter calls — byte-identical.
 *
 * The stamp's contract is unchanged in every state: it NEVER fails
 * the gate. Adapter-leg failures are swallowed here; the Firestore
 * leg's failure propagates to recordMode's existing catch/log,
 * exactly as today.
 */
async function stampConsentTarget(
  db: Firestore,
  target: { collection: string; id: string },
): Promise<void> {
  const firestoreStamp = () =>
    db.collection(target.collection).doc(target.id).set(
      { consentMode: 'record', consentGateLoggedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  const rolesFamily =
    target.collection === 'roles' || target.collection === 'roleDefinitions';
  if (!rolesFamily) {
    await firestoreStamp();
    return;
  }
  const adapterStamp = async (): Promise<boolean> => {
    try {
      await getSupaAdapter().setDoc(
        target.collection,
        target.id,
        { consentMode: 'record', consentGateLoggedAt: new Date() },
        { merge: true },
      );
      return true;
    } catch {
      return false;
    }
  };
  if (isSupaPrimary('roles')) {
    await adapterStamp();
    try {
      await firestoreStamp();
    } catch (err) {
      // Reverse mirror is best-effort under primacy (G-ROLE-9 (a)).
      console.error('[consent-gate] record-mode stamp reverse mirror failed', err);
    }
    return;
  }
  await firestoreStamp();
  if (useSupa('roles')) {
    await adapterStamp();
  }
}

async function recordMode(args: GateArgs): Promise<ConsentGatePass> {
  const { db, actorUid, matterKey, subjectRef } = args;
  const consentRequestId = args.consentRequestId ?? null;
  let observation: string;
  try {
    const settings = await getConsentMatterSettings(db, matterKey);
    const evaluation = await evaluateConsent(args, settings.validityDays);
    observation = evaluation.ok ? 'would_pass' : `would_block:${evaluation.reason}`;
  } catch (err) {
    // Record mode must never become an accidental hard gate through an outage.
    console.error('[consent-gate] record-mode evaluation failed', err);
    observation = 'evaluation_unavailable';
  }

  // Audit entry (best effort in record mode; the act proceeds regardless).
  try {
    await writeGovernanceAuditOrThrow(db, {
      action: 'consent_gate_record',
      actorUid,
      targetType: 'consent_gate',
      targetId: matterKey,
      details: {
        matterKey,
        actorUid,
        subjectRef: subjectRef as unknown as Record<string, unknown>,
        actSummary: args.actSummary ?? null,
        consentRequestId,
        observation,
      },
    });
  } catch (err) {
    console.error('[consent-gate] record-mode audit write failed', err);
  }

  // Retroactive-consent task for the Founder (spec B.2.3 step 3). A task, not
  // a bare notification: it stays open in the Founder's queue until filed or
  // dismissed. Failure to create it does not block the act.
  try {
    const subjectString = canonicalSubjectRefString(subjectRef);
    await db.collection('tasks').add({
      title: `Retroactive consent needed: ${matterKey} - ${args.actSummary ?? subjectString}`,
      description: `A gated act was performed in record mode without a decided Founder Consent. File or dismiss the retroactive consent for ${subjectString}.`,
      assigneeIds: [FOUNDER_UID],
      createdBy: actorUid,
      status: 'pending',
      consentGateRecord: true,
      matterKey,
      subjectRef: subjectRef as unknown as Record<string, unknown>,
      subjectPath: subjectString,
      consentRequestId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await notificationService.send(
      FOUNDER_UID,
      {
        type: 'consent_gate_record',
        title: 'Retroactive consent needed',
        body: `${matterKey}: ${args.actSummary ?? subjectString} was recorded without a decided consent.`,
        link: '/admin/governance/consents',
        metadata: { matterKey, subjectPath: subjectString },
      },
      'P1',
    );
  } catch (err) {
    console.error('[consent-gate] retroactive task creation failed', err);
  }

  // Stamp the affected record where one exists (spec B.2.3 step 4).
  try {
    const target = stampTarget(subjectRef);
    if (target) {
      await stampConsentTarget(db, target);
    }
  } catch (err) {
    console.error('[consent-gate] record-mode stamp failed', err);
  }

  return { mode: 'record', outcome: 'recorded', consentRequestId };
}

/**
 * Founder recognition for the auto-consent branch: UID-ONLY
 * (security fix, Independent Security Reviewer 1, 2026-10-24).
 * Admission is exactly isFounderUid(actorUid) — UID equality against
 * FOUNDER_UID (src/config/founder.ts, via founder-gate). There is NO
 * role arm: a stored primary role of 'founder_patron' proves nothing,
 * because firestore.rules permits a non-founder holding
 * canManageRoles (or president/superadmin) to client-write
 * roles/{uid}.role='founder_patron' directly (only 'superadmin' and
 * 'president_national' values are blocked there), bypassing the
 * server-side reserved_role guard in role-writes.ts. Under the
 * previous role arm that planted write passed this gate and minted a
 * self-decided consent carrying the founder signature marker. At base
 * (a3c9702) this check was UID-only; the role arm was introduced by
 * this branch and is removed by this fix. The real Founder loses
 * nothing: the founder's own UID IS the founder UID. No role
 * (founder_patron, superadmin, CTO, president) qualifies, and neither
 * resolveUserRole nor hasServerPermission is ever consulted here.
 */
function isFounderActor(actorUid: string): boolean {
  return isFounderUid(actorUid);
}

async function writeFounderExistingAudit(
  args: GateArgs,
  settings: ConsentMatterSettings,
  consentRequestId: string,
): Promise<void> {
  const { db, actorUid, matterKey, subjectRef } = args;
  await writeGovernanceAuditOrThrow(db, {
    action: 'consent_gate_pass',
    actorUid,
    targetType: 'consent_gate',
    targetId: matterKey,
    details: {
      matterKey,
      consentRequestId,
      actorUid,
      subjectRef: subjectRef as unknown as Record<string, unknown>,
      mode: settings.mode,
      consentBasis: 'existing_decided',
    },
  });
}

/**
 * Founder-act pass (Fix 1): dedupe first (a caller-supplied decided
 * consent, then an existing decided consent for this subject+action),
 * and only then write the auto-consent record. A reused consent is
 * never consumed - the founder path has never consumed one. Any throw
 * from the writer propagates as a non-ConsentRequiredError (fail
 * closed); a founder act never silently degrades to the old
 * record-free pass.
 */
async function founderActPass(
  args: GateArgs,
  settings: ConsentMatterSettings,
): Promise<ConsentGatePass> {
  const { db, actorUid, matterKey, subjectRef } = args;

  // Step A — reuse a caller-supplied decided consent, without consuming it.
  if (args.consentRequestId) {
    const evaluation = await evaluateConsent(args, settings.validityDays);
    if (evaluation.ok) {
      await writeFounderExistingAudit(args, settings, args.consentRequestId);
      return { mode: settings.mode, outcome: 'founder_act', consentRequestId: args.consentRequestId };
    }
    // Any not-ok reason falls through to Step B without throwing.
  }

  // Step B — reuse an existing decided consent for this subject+action.
  const candidates = await listDecidedConsentCandidates(db, matterKey);
  for (const doc of candidates) {
    if (!subjectMatches(doc.subjectRef, args.subjectRef)) continue;
    if (doc.status === 'conditional') {
      const satisfiedBy = doc.conditionsSatisfiedBy ?? null;
      const byFounder = satisfiedBy === FOUNDER_UID;
      const byVerifier =
        satisfiedBy != null &&
        doc.conditionsVerifierUid != null &&
        satisfiedBy === doc.conditionsVerifierUid;
      // The requester can never satisfy their own conditions.
      const byRequester = satisfiedBy != null && satisfiedBy === args.actorUid && !byFounder && !byVerifier;
      if (doc.conditionsSatisfied !== true || (!byFounder && !byVerifier) || byRequester) {
        continue;
      }
    } else if (doc.status !== 'consented') {
      continue;
    }
    const expiry = consentExpiryDate(doc, settings.validityDays);
    if (expiry && args.now.getTime() > expiry.getTime()) continue;
    if (doc.consumedAt != null) continue;
    await writeFounderExistingAudit(args, settings, doc.id);
    return { mode: settings.mode, outcome: 'founder_act', consentRequestId: doc.id };
  }

  // Step C — write the auto-consent, then audit, then pass.
  const created = await createFounderActConsent(db, {
    actorUid,
    matterKey,
    subjectRef: subjectRef as unknown as Record<string, unknown>,
    proposedAct: args.actSummary ?? canonicalSubjectRefString(subjectRef),
    gateMode: settings.mode,
    now: args.now,
    validityDays: settings.validityDays,
  });
  if (created.reused) {
    // The writer's transaction re-check found a match: treat as Step B.
    await writeFounderExistingAudit(args, settings, created.id);
    return { mode: settings.mode, outcome: 'founder_act', consentRequestId: created.id };
  }
  await writeGovernanceAuditOrThrow(db, {
    action: 'consent_gate_pass',
    actorUid,
    targetType: 'consent_gate',
    targetId: matterKey,
    details: {
      consentBasis: 'founder_act',
      decidedVia: 'founder-act',
      matterKey,
      actorUid,
      subjectRef: subjectRef as unknown as Record<string, unknown>,
      consentRequestId: created.id,
      mode: settings.mode,
    },
  });
  return { mode: settings.mode, outcome: 'founder_act', consentRequestId: created.id };
}

export async function assertConsentFor(rawArgs: AssertConsentArgs): Promise<ConsentGatePass> {
  const db = rawArgs.db ?? getDb();
  if (!db) {
    // No database handle: hard mode cannot be evaluated. Throw a plain error;
    // consentGateHttpError maps it to 500 CONSENT_CHECK_UNAVAILABLE (fail
    // closed). Record mode cannot be determined without settings, and the
    // spec's degradation for a missing settings doc is record - but with no
    // db at all there is nothing to record into, so failing closed is the
    // only honest outcome.
    throw new Error('consent gate unavailable: no Firestore handle');
  }
  const args: GateArgs = { ...rawArgs, db, now: rawArgs.now ?? new Date() };
  const { actorUid, matterKey, subjectRef } = args;

  // Check 2 (moved up): mode lookup, read on every call (no cache).
  // getConsentMatterSettings never throws (it catches internally), so
  // reading settings before the founder branch cannot change
  // non-founder failure behaviour; the founder record needs
  // gateModeAtFiling and the founder return value needs the real mode.
  const settings = await getConsentMatterSettings(db, matterKey);
  if (settings.source !== 'doc') {
    try {
      await writeGovernanceAuditOrThrow(db, {
        action:
          settings.source === 'malformed'
            ? 'consent_gate_settings_malformed'
            : 'consent_gate_settings_missing',
        actorUid,
        targetType: 'consent_gate',
        targetId: matterKey,
        details: { matterKey, source: settings.source },
      });
    } catch (err) {
      console.error('[consent-gate] settings-warning audit write failed', err);
    }
  }

  // Check 1 (replaced, Fix 1): founder actors pass in BOTH modes, and
  // the pass is recorded as a decided consent (founderActPass) instead
  // of the old record-free exemption - except at opt-out probe sites
  // (allowFounderAutoConsent: false), which keep the legacy pass
  // verbatim below.
  const founder = isFounderActor(actorUid);
  if (founder && rawArgs.allowFounderAutoConsent !== false) {
    return founderActPass(args, settings);
  }
  if (founder && rawArgs.allowFounderAutoConsent === false) {
    await writeGovernanceAuditOrThrow(db, {
      action: 'consent_gate_pass',
      actorUid,
      targetType: 'consent_gate',
      targetId: matterKey,
      details: {
        consentBasis: 'founder_actor',
        matterKey,
        subjectRef: subjectRef as unknown as Record<string, unknown>,
        mode: 'hard',
      },
    });
    return { mode: 'hard', outcome: 'founder_actor' };
  }

  if (settings.mode === 'record') {
    return recordMode(args);
  }

  // Checks 3-9 (hard mode).
  const evaluation = await evaluateConsent(args, settings.validityDays);
  if (!evaluation.ok) {
    throw block(args, evaluation.reason);
  }
  const consentRequestId = args.consentRequestId as string;

  // Check 9 (consumption): single-use, inside the lookup transaction. Losing
  // the race throws already_consumed.
  const consumed = await consumeConsent(
    db,
    consentRequestId,
    actorUid,
    canonicalSubjectRefString(subjectRef),
  );
  if (consumed === 'already_consumed') {
    throw block(args, 'already_consumed');
  }

  // Check 10: audit. A throw here propagates as a plain error = fail closed.
  await writeGovernanceAuditOrThrow(db, {
    action: 'consent_gate_pass',
    actorUid,
    targetType: 'consent_gate',
    targetId: matterKey,
    details: {
      matterKey,
      consentRequestId,
      actorUid,
      subjectRef: subjectRef as unknown as Record<string, unknown>,
      mode: 'hard',
    },
  });

  return { mode: 'hard', outcome: 'consented', consentRequestId };
}
