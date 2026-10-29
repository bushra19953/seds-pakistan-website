import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { evaluateRelatedPartyGate, type ConsentViewLike } from '@/lib/finance/related-party-gate';
import { getConsentView } from '@/lib/finance/adapters';
import { supaListAllPartners } from '@/lib/server/crm-supa';

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

/** Firestore 'in' operator value cap; partner-id queries chunk at this size. */
const PARTNER_ID_QUERY_CHUNK = 30;

/**
 * Load every linked partner record in ONE fetch instead of one document
 * read per organisation link.
 *
 * MIGRATION SEAM (Cluster F, surface 'crm'): the CRM-owned partner docs
 * are seam-served when ON — one whole-list seam read; a linked id absent
 * from that list is a missing partner, which is the same verdict the old
 * per-id seam doc read produced (it did not fall back for missing docs).
 * A null seam result (flag OFF / unconfigured / adapter error) falls
 * back to Firestore: chunked `documentId() in (...)` queries, one query
 * per chunk of PARTNER_ID_QUERY_CHUNK ids. (Finance consumes the CRM
 * table; it does not own it — merge plan seam rule.)
 *
 * Returns a map from partnerId to its record, or null when no such
 * partner record exists.
 */
async function loadLinkedPartners(
  db: Firestore,
  partnerIds: string[],
): Promise<Map<string, PartnerGateLike | null>> {
  const partners = new Map<string, PartnerGateLike | null>();
  if (partnerIds.length === 0) return partners;

  const seamPartners = await supaListAllPartners();
  if (seamPartners) {
    const byId = new Map(
      seamPartners.map((p) => [String(p.id), p as PartnerGateLike]),
    );
    for (const id of partnerIds) partners.set(id, byId.get(id) ?? null);
    return partners;
  }

  for (let i = 0; i < partnerIds.length; i += PARTNER_ID_QUERY_CHUNK) {
    const chunk = partnerIds.slice(i, i + PARTNER_ID_QUERY_CHUNK);
    const snap = await db
      .collection('sponsors_partners')
      .where(FieldPath.documentId(), 'in', chunk)
      .get();
    const found = new Map<string, PartnerGateLike>();
    snap.forEach((docSnap) => {
      found.set(docSnap.id, docSnap.data() as PartnerGateLike);
    });
    for (const id of chunk) partners.set(id, found.get(id) ?? null);
  }
  return partners;
}

/** Server-side filter for the organizations read paths (Admin SDK). */
export async function filterPublicOrganizations<T extends PublicOrgLike>(
  db: Firestore,
  orgs: T[],
): Promise<T[]> {
  // One batched partner fetch for all linked organisations (previously
  // one partner read per link). The gate evaluation below still runs
  // per organisation, in the original order, so the returned set and
  // order are unchanged.
  const linkedIds = [
    ...new Set(orgs.map((org) => org.partnerId).filter((id): id is string => !!id)),
  ];
  const partners = await loadLinkedPartners(db, linkedIds);

  // Consent views are shared per consentRequestId within one call.
  const consentViews = new Map<string, ConsentViewLike | null>();
  const loadConsentView = async (consentId: string): Promise<ConsentViewLike | null> => {
    if (!consentViews.has(consentId)) {
      const view = await getConsentView(db, consentId);
      consentViews.set(
        consentId,
        view
          ? {
              exists: view.exists,
              decision: view.decision,
              decisionDate: view.decisionDate,
              amountPkr: view.amountPkr,
            }
          : null,
      );
    }
    return consentViews.get(consentId) ?? null;
  };

  const out: T[] = [];
  for (const org of orgs) {
    if (!org.partnerId) {
      out.push(org);
      continue;
    }
    const partner = partners.get(org.partnerId) ?? null;
    let consentView: ConsentViewLike | null = null;
    const consentId = partner?.relatedParty?.consentRequestId;
    if (partner?.isRelatedParty && consentId) {
      consentView = await loadConsentView(consentId);
    }
    if (orgPassesPublicGate(org, partner, consentView)) out.push(org);
  }
  return out;
}
