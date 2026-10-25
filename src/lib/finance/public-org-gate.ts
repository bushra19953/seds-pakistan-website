import type { Firestore } from 'firebase-admin/firestore';
import { evaluateRelatedPartyGate, type ConsentViewLike } from '@/lib/finance/related-party-gate';
import { getConsentView } from '@/lib/finance/adapters';
import { supaPartnerDoc } from '@/lib/server/crm-supa';

/**
 * Public organizations gate (spec Part C 3.8 + 6.5, CH-20). An
 * organizations record linked to a CRM partner (partnerId) may be shown
 * publicly ONLY IF the CRM record is Active AND logo use was granted AND
 * (the partner is not a related party OR the related-party gate passes).
 * Organizations without a partnerId are unaffected. The rule: public
 * display follows the strictest applicable gate, and the least visible
 * place a logo appears sets the standard for everywhere it appears.
 */

export interface PublicOrgLike {
  id?: string;
  partnerId?: string | null;
  logoUseGranted?: boolean;
}

export interface PartnerGateLike {
  status?: string;
  isRelatedParty?: boolean;
  financials?: { pledgedAmount?: number } | null;
  relatedParty?: Parameters<typeof evaluateRelatedPartyGate>[0]['relatedParty'];
}

export function orgPassesPublicGate(
  org: PublicOrgLike,
  partner: PartnerGateLike | null,
  consentView: ConsentViewLike | null,
): boolean {
  if (!org.partnerId) return true; // unlinked organizations are unaffected
  if (!partner) return false;
  if (partner.status !== 'Active') return false;
  if (org.logoUseGranted !== true) return false;
  if (!partner.isRelatedParty) return true;
  return evaluateRelatedPartyGate(
    { isRelatedParty: true, financials: partner.financials ?? null, relatedParty: partner.relatedParty ?? null },
    consentView,
  ).canActivate;
}

/** Server-side filter for the organizations read paths (Admin SDK). */
export async function filterPublicOrganizations<T extends PublicOrgLike>(
  db: Firestore,
  orgs: T[],
): Promise<T[]> {
  const out: T[] = [];
  for (const org of orgs) {
    if (!org.partnerId) {
      out.push(org);
      continue;
    }
    // MIGRATION SEAM (Cluster F, surface 'crm'): the CRM-owned partner
    // doc is seam-served when ON; null falls back to the Firestore get
    // byte-identically. (Finance consumes the CRM table; it does not
    // own it — merge plan seam rule.)
    const seamSnap = await supaPartnerDoc(org.partnerId);
    const snap = seamSnap ?? (await db.collection('sponsors_partners').doc(org.partnerId).get());
    const partner = snap.exists ? (snap.data() as PartnerGateLike) : null;
    let consentView: ConsentViewLike | null = null;
    const consentId = partner?.relatedParty?.consentRequestId;
    if (partner?.isRelatedParty && consentId) {
      const view = await getConsentView(db, consentId);
      if (view) {
        consentView = {
          exists: view.exists,
          decision: view.decision,
          decisionDate: view.decisionDate,
          amountPkr: view.amountPkr,
        };
      }
    }
    if (orgPassesPublicGate(org, partner, consentView)) out.push(org);
  }
  return out;
}
