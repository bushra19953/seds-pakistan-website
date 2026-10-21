// ADAPTER(W-A): Minimal local implementation of Workstream A's consent lookup
// contract (spec Sections 0.6 and B.2). Workstream A owns consent_requests and
// implements the real getDecidedConsent behind this exact signature; at
// integration this module is replaced by A's implementation. Neither the gate
// nor any consumer may fork the signature.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';

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
  const snap = await db.collection('consent_requests').doc(consentRequestId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as Record<string, unknown>) } as DecidedConsentDoc;
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
  return db.runTransaction(async (tx) => {
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
}
