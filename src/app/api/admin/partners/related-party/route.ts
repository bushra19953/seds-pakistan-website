import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermission } from '@/lib/server/permissions';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { getConsentView, isDecidedApprovedConsent, deriveFounderConsentDate } from '@/lib/finance/adapters';
import { evaluateRelatedPartyGate, type ConsentViewLike } from '@/lib/finance/related-party-gate';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Related-party register API (spec Part C 4.7, CH-19). The founder consent
 * date is NEVER accepted from the client: it is derived from the linked
 * consent_requests record via the Phase 2 adapter. Money-bearing changes
 * (pledgedAmount, amountReceived, contractSumPkr) are not applied here:
 * they return 409 pointing at the approvals flow (crm_financial_edit).
 */

const RELATED_FIELDS = [
  'isRelatedParty',
  'isFounderCommercialEntity',
  'relatedParty.channel',
  'relatedParty.consentRequestId',
  'relatedParty.agreementRef',
  'relatedParty.contractSumPkr',
  'relatedParty.boardApprovalDate',
  'relatedParty.disclosure',
  'relatedParty.benchmarking',
  'relatedParty.disclosureRecorded',
  'relatedParty.benchmarkingRecorded',
] as const;

function toGateView(v: Awaited<ReturnType<typeof getConsentView>>): ConsentViewLike {
  return { exists: v.exists, decision: v.decision, decisionDate: v.decisionDate, amountPkr: v.amountPkr };
}

type PartnerRecordData = Record<string, unknown> & { id: string };

async function loadRecord(db: FirebaseFirestore.Firestore, id: string): Promise<PartnerRecordData | null> {
  const snap = await db.collection('sponsors_partners').doc(id).get();
  if (!snap.exists) return null;
  return { ...(snap.data() as Record<string, unknown>), id } as PartnerRecordData;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermission(caller.role, 'canManageSponsorsPartners'))) return httpError(403, 'Forbidden');
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return httpError(400, 'id is required');
    const record = await loadRecord(caller.db, id);
    if (!record) return httpError(404, 'Partner record not found');
    const rp = record.relatedParty as { consentRequestId?: string } | null;
    // getConsentView never returns null: an empty id yields the empty view.
    const view = await getConsentView(caller.db, rp?.consentRequestId ?? '');
    const gate = evaluateRelatedPartyGate(
      record as Parameters<typeof evaluateRelatedPartyGate>[0],
      toGateView(view),
    );
    return NextResponse.json({
      id,
      isRelatedParty: record.isRelatedParty === true,
      isFounderCommercialEntity: record.isFounderCommercialEntity === true,
      relatedParty: record.relatedParty ?? null,
      financials: record.financials ?? null,
      founderConsentDate: deriveFounderConsentDate(view),
      consentDecidedApproved: isDecidedApprovedConsent(view),
      gate,
    });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function PUT(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermission(caller.role, 'canManageSponsorsPartners'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as {
      id?: string;
      founderConsentDate?: string;
      financials?: Record<string, unknown>;
      changes?: Record<string, unknown>;
    };
    if (!body.id) return httpError(400, 'id is required');
    if (body.founderConsentDate !== undefined) {
      return httpError(422, 'founderConsentDate is derived from the linked consent record and cannot be set directly');
    }
    const record = await loadRecord(caller.db, body.id);
    if (!record) return httpError(404, 'Partner record not found');

    // Money-bearing changes must go through maker-checker.
    if (body.financials) {
      const current = (record.financials as Record<string, unknown> | undefined) ?? {};
      const moneyKeys = ['pledgedAmount', 'amountReceived', 'contractSumPkr'];
      const differs = moneyKeys.some((k) => body.financials![k] !== undefined && body.financials![k] !== current[k]);
      if (differs) {
        return NextResponse.json(
          { error: 'Money-bearing changes require the approvals flow', requiresApproval: 'crm_financial_edit' },
          { status: 409 },
        );
      }
    }

    const changes = body.changes ?? {};
    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    // Accumulate all relatedParty.* keys into ONE merged map (building it
    // fresh per key would drop earlier keys from the same call).
    let mergedRelated: Record<string, unknown> | null = null;
    for (const field of RELATED_FIELDS) {
      if (changes[field] === undefined) continue;
      if (field.startsWith('relatedParty.')) {
        const key = field.slice('relatedParty.'.length);
        if (!mergedRelated) {
          mergedRelated = { ...((record.relatedParty as Record<string, unknown> | null) ?? {}) };
        }
        mergedRelated[key] = changes[field];
      } else {
        updates[field] = changes[field];
      }
    }
    if (mergedRelated) updates.relatedParty = mergedRelated;
    const ref = caller.db.collection('sponsors_partners').doc(body.id);
    const batch = caller.db.batch();
    batch.update(ref, updates);
    await writeFinanceAudit(caller.db, batch, {
      action: 'CRM_RELATED_PARTY_UPDATED',
      actorUid: caller.uid,
      targetUidOrResource: `sponsors_partners/${body.id}`,
      payload: { fields: Object.keys(changes) },
    });
    await batch.commit();
    return NextResponse.json({ id: body.id, updated: Object.keys(changes) });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
