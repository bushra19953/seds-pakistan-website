import type { Firestore } from 'firebase-admin/firestore';

/**
 * ADAPTER layer to Phase 2 substrates (Founder Consent system, Compliance
 * engine). Phase 2 is a parallel build; everything in this file is a thin
 * ADAPTER against the Phase 2 spec (phase2_spec.md A.4) so the finance
 * module never hard-depends on Phase 2 internals. When Phase 2 lands, only
 * this file should need adjustment.
 *
 * Phase 2 consent_requests shape relied on here (spec A.4):
 *   decision: 'consent_given' | 'consent_refused' | 'conditional_consent' | null
 *   decisionDate: Timestamp | null
 *   decidedAtSort: Timestamp | null (server-maintained sort key)
 *   amountPkr: number | null
 *   status: string (lifecycle enum)
 */

export interface ConsentView {
  exists: boolean;
  status: string | null;
  decision: string | null;
  /** ISO date (YYYY-MM-DD) derived from decisionDate / decidedAtSort. */
  decisionDate: string | null;
  amountPkr: number | null;
}

const EMPTY_CONSENT: ConsentView = {
  exists: false,
  status: null,
  decision: null,
  decisionDate: null,
  amountPkr: null,
};

function timestampToIsoDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = v as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === 'function') return t.toDate().toISOString().slice(0, 10);
  if (typeof t.seconds === 'number') return new Date(t.seconds * 1000).toISOString().slice(0, 10);
  return null;
}

/**
 * ADAPTER: read one consent_requests record into the finance ConsentView.
 * Never throws on a missing record (exists: false); read errors propagate,
 * because a consent check that silently fails open would defeat hooks
 * H1/H2 and the related-party gate.
 */
export async function getConsentView(db: Firestore, consentId: string): Promise<ConsentView> {
  if (!consentId) return { ...EMPTY_CONSENT };
  const snap = await db.collection('consent_requests').doc(consentId).get();
  if (!snap.exists) return { ...EMPTY_CONSENT };
  const d = snap.data() as Record<string, unknown>;
  return {
    exists: true,
    status: typeof d.status === 'string' ? d.status : null,
    decision: typeof d.decision === 'string' ? d.decision : null,
    decisionDate: timestampToIsoDate(d.decisionDate) ?? timestampToIsoDate(d.decidedAtSort),
    amountPkr: typeof d.amountPkr === 'number' ? d.amountPkr : null,
  };
}

/**
 * ADAPTER: is this consent decided-approved for finance purposes?
 * consent_given and conditional_consent both count as approved (the
 * conditions are enforced by the Phase 2 machinery; finance records the
 * link). When minAmountPkr is given and the consent carries an amount,
 * the consent amount must cover it; a consent with no amount is treated
 * as not amount-scoped and passes the amount check.
 */
export function isDecidedApprovedConsent(view: ConsentView, minAmountPkr?: number): boolean {
  if (!view.exists) return false;
  if (view.decision !== 'consent_given' && view.decision !== 'conditional_consent') return false;
  if (minAmountPkr != null && view.amountPkr != null && view.amountPkr < minAmountPkr) return false;
  return true;
}

/**
 * ADAPTER: the Founder Consent date for display (spec 3.7). Derived from
 * the linked consent record, never a free-typed date: returns the
 * record's decision date when decided-approved, else null.
 */
export function deriveFounderConsentDate(view: ConsentView): string | null {
  return isDecidedApprovedConsent(view) ? view.decisionDate : null;
}

/**
 * ADAPTER: stamp the Phase 2 compliance_obligations instance for a
 * month's reconciliation duty as completed, with the reconciliation doc
 * as evidence (spec 3.3). BEST-EFFORT by design - the one explicitly
 * best-effort write in this workstream: the obligation system belongs to
 * another workstream, so a missing/failed stamp must NOT fail the
 * reconciliation completion. Never throws.
 */
export async function stampComplianceObligation(
  db: Firestore,
  obligationId: string | null,
  reconciliationDocId: string,
): Promise<void> {
  if (!obligationId) return;
  try {
    await db.collection('compliance_obligations').doc(obligationId).set(
      {
        status: 'completed',
        evidenceDocId: reconciliationDocId,
        evidenceCollection: 'finance_reconciliations',
      },
      { merge: true },
    );
  } catch {
    // Best-effort link write only; completion of the reconciliation stands.
  }
}
