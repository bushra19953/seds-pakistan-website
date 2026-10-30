// Consent gate lookup (spec Section 0.6). Workstream B consumes this
// exact signature; Workstream A implements the real lookup behind it
// (getDecidedConsent in consent-service.ts). Do not fork this signature.
//
// Fail-closed contract: in 'hard' mode, no decided consent (or a failed
// lookup) BLOCKS the gated act. In 'record' mode the act passes and the
// absence is reported in `reason` so the caller can write its record.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { ConsentRequest } from '@/types/consent';
import { getReservedMatter } from '@/lib/consents/reserved-matters';
import { getDecidedConsent as getDecidedConsentByMatter } from '@/lib/server/consent-service';
import type {
  ConsentMatterKey,
  ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';
import {
  GATE_TO_RESERVED_MATTER,
  consentActMatchFailure,
} from '@/lib/server/consent-subject';
import {
  consentsSupaEnabled,
  getConsentViaSeam,
  listConsentsViaSeam,
  mirrorConsentSet,
  mirrorConsentUpdate,
} from '@/lib/server/consents-supa';
import { runWithRequestCache } from '@/lib/server/request-cache';

export interface ConsentGateInput {
  matterKey: string;
  subjectId?: string;
  mode?: 'hard' | 'record';
}

export interface ConsentGateResult {
  allowed: boolean;
  mode: 'hard' | 'record';
  consent: ConsentRequest | null;
  reason?: string;
}

export async function checkConsentGate(
  db: Firestore,
  input: ConsentGateInput,
): Promise<ConsentGateResult> {
  // Request-cache scope for the gate path (see consent-gate.ts).
  return runWithRequestCache(() => checkConsentGateScoped(db, input));
}

async function checkConsentGateScoped(
  db: Firestore,
  input: ConsentGateInput,
): Promise<ConsentGateResult> {
  const matter = getReservedMatter(input.matterKey);
  const mode: 'hard' | 'record' =
    input.mode ??
    (matter
      ? matter.defaultGateMode === 'hard_block'
        ? 'hard'
        : 'record'
      : 'hard'); // unknown matter: fail closed

  if (!matter) {
    return {
      allowed: mode === 'record' ? true : false,
      mode,
      consent: null,
      reason: 'UNKNOWN_MATTER',
    };
  }

  try {
    const consent = await getDecidedConsentByMatter(db, {
      matterKey: input.matterKey,
      requestId: input.subjectId,
    });
    if (consent) {
      return { allowed: true, mode, consent };
    }
    return {
      allowed: mode === 'record',
      mode,
      consent: null,
      reason: 'NO_DECIDED_CONSENT',
    };
  } catch {
    // A failed lookup never opens a hard gate.
    return {
      allowed: mode === 'record',
      mode,
      consent: null,
      reason: 'CONSENT_LOOKUP_FAILED',
    };
  }
}

// ---------------------------------------------------------------------------
// Workstream B gate substrate (integration step 4): the by-id decided
// consent reader + single-use consumption Workstream B's gate core
// (consent-gate.ts assertConsentFor) consumes. NOTE: this
// getDecidedConsent(db, consentRequestId) is a BY-ID reader; the
// matter+subject lookup of the same name lives in consent-service.ts.
// Both read the real consent_requests collection; neither forks the
// other's signature.
// ---------------------------------------------------------------------------


export type ConsentDateValue =
  | FirebaseFirestore.Timestamp
  | Date
  | string
  | number
  | null
  | undefined;

/**
 * The consent_requests/{id} fields Workstream B consumes (spec B.2). A must
 * provide the consumption fields and the conditions-satisfied fields.
 */
export interface DecidedConsentDoc {
  id: string;
  matterKey: string;
  status: string;
  subjectRef: unknown;
  decidedAt?: ConsentDateValue;
  decidedBy?: string | null;
  proposedActDate?: ConsentDateValue;
  conditions?: unknown;
  conditionsSatisfied?: boolean;
  conditionsSatisfiedBy?: string | null;
  conditionsSatisfiedAt?: ConsentDateValue;
  conditionsVerifierUid?: string | null;
  consumedAt?: ConsentDateValue;
  consumedBy?: string | null;
  consumedActRef?: string | null;
  expiresAt?: ConsentDateValue;
  [key: string]: unknown;
}

export async function getDecidedConsent(
  db: Firestore,
  consentRequestId: string,
): Promise<DecidedConsentDoc | null> {
  // Seam (consents mirror program): mirror-first when the consents
  // surface is enabled; Firestore only on a seam miss or adapter
  // error. A trusted Firestore hit heals the mirror row so the miss
  // is paid at most once per doc.
  try {
    const via = await getConsentViaSeam(consentRequestId);
    if (via) return via as DecidedConsentDoc;
  } catch (err) {
    console.warn('[consent-lookup] seam by-id read failed; falling back to Firestore:', err);
  }
  const snap = await db.collection('consent_requests').doc(consentRequestId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  if (consentsSupaEnabled()) {
    await mirrorConsentSet(consentRequestId, data);
  }
  return { id: snap.id, ...data } as DecidedConsentDoc;
}

/**
 * Decided-consent candidates for a matter, newest first, for the gate's
 * founder-act dedupe (consent-gate.ts founderActPass Step B). Statuses are
 * 'consented' / 'conditional' only: an 'executed' consent is spent as a
 * basis for a new act and is deliberately excluded. Subject filtering
 * happens in memory in the gate, because Firestore cannot query the
 * variant-shaped subjectRef map. This query needs the composite index
 * the by-matter getDecidedConsent in consent-service.ts already needs
 * (matterKey + status + decidedAtSort); no new index family.
 */
export async function listDecidedConsentCandidates(
  db: Firestore,
  matterKey: string,
): Promise<DecidedConsentDoc[]> {
  // Seam (consents mirror program): same query shape through the
  // adapter when the consents surface is enabled; Firestore only on
  // seam-unavailable or adapter error.
  try {
    const via = await listConsentsViaSeam({
      where: [
        ['matterKey', '==', matterKey],
        ['status', 'in', ['consented', 'conditional']],
      ],
      orderBy: { field: 'decidedAtSort', direction: 'desc' },
      limit: 25,
    });
    if (via) return via as DecidedConsentDoc[];
  } catch (err) {
    console.warn('[consent-lookup] seam candidates read failed; falling back to Firestore:', err);
  }
  const snap = await db.collection('consent_requests')
    .where('matterKey', '==', matterKey)
    .where('status', 'in', ['consented', 'conditional'])
    .orderBy('decidedAtSort', 'desc')
    .limit(25)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as DecidedConsentDoc);
}

function decidedSortTime(doc: DecidedConsentDoc): number {
  for (const key of ['decidedAtSort', 'decisionDate', 'decidedAt'] as const) {
    const v = (doc as Record<string, unknown>)[key];
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string' || typeof v === 'number') {
      const t = new Date(v).getTime();
      if (!Number.isNaN(t)) return t;
    }
    if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
      const d = (v as { toDate: () => Date }).toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
    }
  }
  return 0;
}

/**
 * Thrown by listDecidedConsentsForAct when at least one arm failed or
 * timed out AND no arm produced a match. The decided-consents endpoint
 * maps this to 503 so the picker renders its load-error state ("The
 * list could not be read just now") instead of the empty state ("No
 * decided consent for this act yet") - a degraded lookup that matched
 * nothing is NOT evidence that no decided consent exists (live
 * 2026-10-30 16:14 PKT: an arm-level failure on the picker read left
 * FC-2026-0054, on file and consented, invisible for exactly the role
 * creations it was filed for, and one reproduction of the endpoint
 * returned a confident empty 200 while a later identical call took
 * ~41s and returned the record).
 */
export class ConsentLookupDegradedError extends Error {
  readonly armFailures: string[];
  constructor(armFailures: string[]) {
    super(
      `decided-consent lookup degraded: ${armFailures.length} arm(s) failed ` +
        `(${armFailures.join('; ')}) and no arm matched`,
    );
    this.name = 'ConsentLookupDegradedError';
    this.armFailures = armFailures;
  }
}

/**
 * Per-arm TOTAL budget for the picker lookup (see the error above).
 * One arm's sub-reads (the mirror attempt, then the Firestore
 * fallback) share this single budget via a deadline - they do not
 * each get a fresh timeout - and the arms run in parallel, so the
 * whole lookup is bounded by roughly this value instead of the sum
 * of every sub-read's timeout (the sequential shape is what let one
 * live call take ~41s: five sub-reads at up to 8s each, end to end).
 */
export const CONSENT_LOOKUP_ARM_TIMEOUT_MS = 8000;

/**
 * Race one arm read against a hard timeout. Neither the Supabase
 * adapter nor the Firestore client call carries a deadline of its
 * own, so a hung arm would otherwise hang the whole picker request
 * until the platform edge gives up - which the picker can only
 * render as a load error after a long wait. A timeout is an arm
 * failure, exactly like a thrown error; the losing read may still
 * settle later and is deliberately swallowed.
 */
async function withArmTimeout<T>(
  label: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`consent lookup arm "${label}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decided consents for ONE gate act, across every representation the
 * system produces (matcher fix, 2026-10-26) - the read behind the
 * picker's endpoint GET /api/admin/governance/consents/decided, which
 * did not exist before this fix (the picker fetched it, got a 404,
 * and always rendered "No decided consent for this act yet.").
 *
 * Arms: (a) gate-shaped records via listDecidedConsentCandidates
 * (matterKey = gate key); (b) post-fix stamped filings, found by
 * their gateMatterKey field (single-field query, statuses filtered
 * in memory - no new composite index family); (c) legacy user-filed
 * records under the equivalent Reserved Matter, matched by Act text.
 * A record is returned only when consentActMatchFailure finds the act
 * match AND it is unconsumed; status is enforced by the queries /
 * in-memory filters ('consented' / 'conditional' only, the picker
 * disables unmet-condition rows itself). Expiry is the caller's check
 * (it needs the matter's validityDays from governance settings).
 * Sorted newest decision first.
 */
interface ConsentArmOutcome {
  docs: DecidedConsentDoc[];
  failure?: string;
}

/**
 * Gate-shaped candidates arm. Guarded like every arm: one arm's
 * failure must not hide records another arm can read. Unguarded, a
 * Firestore outage (e.g. RESOURCE_EXHAUSTED, live 2026-10-30) threw
 * here, the decided endpoint 500'd, and the picker rendered "No
 * decided consent for this act yet." while a valid filed consent
 * (FC-2026-0054) sat readable in the arms below. The endpoint still
 * fails closed overall: a record that cannot be read by ANY arm
 * cannot match. The arm's reads carry a hard timeout
 * (withArmTimeout): a hung arm is an arm failure, never a hung
 * request.
 */
async function runCandidatesArm(
  db: Firestore,
  matterKey: ConsentMatterKey,
  armTimeoutMs: number,
): Promise<ConsentArmOutcome> {
  try {
    const docs = await withArmTimeout('candidates', armTimeoutMs, () =>
      listDecidedConsentCandidates(db, matterKey),
    );
    return { docs };
  } catch (err) {
    console.error('[consent-lookup] gate-shaped candidates arm failed', err);
    return {
      docs: [],
      failure: `candidates: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * One filed-consent arm (a single-field query on consent_requests).
 * The mirror attempt and the Firestore fallback share ONE deadline
 * (the arm budget), so a slow seam cannot leave the fallback its own
 * fresh timeout on top - the sub-reads race whatever budget remains,
 * and an exhausted budget fails the arm without issuing another
 * read. A seam error alone is not an arm failure (the fallback
 * decides), exactly as before; the arm fails only when neither read
 * produced the records.
 */
async function runFiledArm(
  db: Firestore,
  arm: { field: string; value: string },
  armTimeoutMs: number,
): Promise<ConsentArmOutcome> {
  const deadline = Date.now() + armTimeoutMs;
  const budgetLeft = () => Math.max(0, deadline - Date.now());
  try {
    // Seam (consents mirror program): the filed arm reads the mirror
    // when the consents surface is enabled; a seam error falls
    // through to the Firestore read below, and seam-unavailable
    // (null) runs the Firestore read directly.
    let via: Array<Record<string, any>> | null = null;
    try {
      if (budgetLeft() <= 0) {
        throw new Error(`consent lookup arm "filed:${arm.field}" timed out after ${armTimeoutMs}ms`);
      }
      via = await withArmTimeout(`filed:${arm.field}:seam`, budgetLeft(), () =>
        listConsentsViaSeam({
          where: [[arm.field, '==', arm.value]],
          limit: 50,
        }),
      );
    } catch (seamErr) {
      console.warn('[consent-lookup] seam filed arm failed; using Firestore arm:', seamErr);
      via = null;
    }
    if (via) {
      const docs: DecidedConsentDoc[] = [];
      for (const doc of via) {
        if (doc.status !== 'consented' && doc.status !== 'conditional') continue;
        docs.push(doc as DecidedConsentDoc);
      }
      return { docs };
    }
    if (budgetLeft() <= 0) {
      throw new Error(`consent lookup arm "filed:${arm.field}" timed out after ${armTimeoutMs}ms`);
    }
    const snap = await withArmTimeout(`filed:${arm.field}:firestore`, budgetLeft(), () =>
      db
        .collection('consent_requests')
        .where(arm.field, '==', arm.value)
        .limit(50)
        .get(),
    );
    const docs: DecidedConsentDoc[] = [];
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (data.status !== 'consented' && data.status !== 'conditional') continue;
      docs.push({ id: d.id, ...data } as DecidedConsentDoc);
    }
    return { docs };
  } catch (err) {
    // A failed auxiliary arm must not hide the proven gate-shaped
    // arm; the endpoint still fails closed overall because a record
    // that cannot be read cannot match.
    console.error('[consent-lookup] filed-consent arm failed', arm, err);
    return {
      docs: [],
      failure: `filed:${arm.field}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function listDecidedConsentsForAct(
  db: Firestore,
  matterKey: ConsentMatterKey,
  subjectRef: ConsentSubjectRef,
  options?: { armTimeoutMs?: number },
): Promise<DecidedConsentDoc[]> {
  const armTimeoutMs = options?.armTimeoutMs ?? CONSENT_LOOKUP_ARM_TIMEOUT_MS;

  // The three arms are independent reads of the same collection, so
  // they run in PARALLEL: the lookup costs the slowest arm, not the
  // sum of the arms. Each arm isolates its own failure (an arm that
  // throws or times out contributes its failure label and no docs),
  // and outcomes merge in the original arm order (candidates,
  // gateMatterKey, matterKey) so first-occurrence dedupe precedence
  // is unchanged from the sequential shape.
  const filedArms: Array<{ field: string; value: string }> = [
    { field: 'gateMatterKey', value: matterKey },
    { field: 'matterKey', value: GATE_TO_RESERVED_MATTER[matterKey] },
  ];
  const outcomes = await Promise.all([
    runCandidatesArm(db, matterKey, armTimeoutMs),
    ...filedArms.map((arm) => runFiledArm(db, arm, armTimeoutMs)),
  ]);
  const armFailures: string[] = [];
  const byId = new Map<string, DecidedConsentDoc>();
  for (const outcome of outcomes) {
    if (outcome.failure) armFailures.push(outcome.failure);
    for (const doc of outcome.docs) {
      if (!byId.has(doc.id)) byId.set(doc.id, doc);
    }
  }

  const matched = [...byId.values()]
    .filter((doc) => doc.consumedAt == null)
    .filter((doc) => consentActMatchFailure(doc, matterKey, subjectRef) === null)
    .sort((a, b) => decidedSortTime(b) - decidedSortTime(a));

  // Degraded-and-empty is not "no consent": if any arm failed or
  // timed out and nothing matched, the caller must hear about the
  // degradation (the endpoint answers 503 and the picker shows its
  // load-error state) rather than receive a confident empty list the
  // picker renders as "No decided consent for this act yet." Matches
  // found by the surviving arms stay authoritative and are returned
  // exactly as before.
  if (matched.length === 0 && armFailures.length > 0) {
    throw new ConsentLookupDegradedError(armFailures);
  }
  return matched;
}

/**
 * Single-use consumption (spec B.2 step 9): inside one transaction, re-check
 * consumedAt was empty, then stamp consumedAt / consumedBy / consumedActRef.
 * Losing the race returns 'already_consumed'.
 */
export async function consumeConsent(
  db: Firestore,
  consentRequestId: string,
  consumedBy: string,
  consumedActRef: string,
): Promise<'consumed' | 'already_consumed'> {
  const ref = db.collection('consent_requests').doc(consentRequestId);
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error(`consent request ${consentRequestId} disappeared during consumption`);
    }
    const data = snap.data() as Record<string, unknown>;
    if (data.consumedAt != null) {
      return 'already_consumed' as const;
    }
    tx.update(ref, {
      consumedAt: FieldValue.serverTimestamp(),
      consumedBy,
      consumedActRef,
    });
    return 'consumed' as const;
  });
  if (outcome === 'consumed') {
    // Dual-write (consents mirror program): stamp the mirror from the
    // in-memory consumption values; consumedAt is the write instant,
    // the same approximation the mirror serializer uses for
    // serverTimestamp sentinels. Never throws.
    await mirrorConsentUpdate(consentRequestId, {
      consumedAt: new Date(),
      consumedBy,
      consumedActRef,
    });
  }
  return outcome;
}
