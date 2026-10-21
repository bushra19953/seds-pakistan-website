// Founder Consent adapter (Workstream D, spec 4.4). Reads the Phase 2
// consents collection by id only; consent data is never copied into a
// governance record. Fails closed: only 'given' passes downstream.

import type { Firestore } from 'firebase-admin/firestore';

export type ConsentState = 'given' | 'pending' | 'refused' | 'missing';

// ADAPTER(phase2-consents): reads the Phase 2 `consents` collection status field; revisit when the Phase 2 consent system lands its final status vocabulary.
export async function verifyConsentGiven(
  db: Firestore | null | undefined,
  consentId: string | null | undefined,
): Promise<ConsentState> {
  if (!db || !consentId) return 'missing';
  try {
    const snap = await db.collection('consents').doc(consentId).get();
    if (!snap.exists) return 'missing';
    const status = String(snap.data()?.status || '').trim().toLowerCase();
    if (status === 'decided' || status === 'given' || status === 'approved') return 'given';
    if (status === 'refused' || status === 'rejected') return 'refused';
    return 'pending';
  } catch (error) {
    console.error('[governance] verifyConsentGiven failed:', error);
    return 'missing';
  }
}
