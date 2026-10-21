import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermission } from '@/lib/server/permissions';
import { FINANCE_CATEGORIES, type LedgerEntry } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { computeEntryFlags, getFinanceAccounts } from '@/lib/finance/ledger';
import { categoryMatchesChannel } from '@/lib/finance/related-party-gate';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Ledger API (spec Part C 4.2). Draft CRUD only: POSTING is a money state
 * change and happens exclusively through the approvals flow
 * (targetType ledger_post). A posted entry is immutable here - PUT and
 * DELETE on it return 409; corrections are reversing entries.
 */

const PAYMENT_METHODS = ['bank_transfer', 'raast', 'easypaisa', 'jazzcash', 'sadapay', 'cash', 'other'];

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermission(caller.role, 'canManageFinance')) ||
      (await hasServerPermission(caller.role, 'canApproveMoney')) ||
      (await hasServerPermission(caller.role, 'canViewAuditLogs'));
    if (!can) return httpError(403, 'Forbidden');
    const url = new URL(request.url);
    let q: FirebaseFirestore.Query = caller.db.collection('ledger_entries');
    const fy = url.searchParams.get('fy');
    const status = url.searchParams.get('status');
    const account = url.searchParams.get('account');
    const budgetLineId = url.searchParams.get('budgetLineId');
    const relatedParty = url.searchParams.get('relatedParty');
    if (fy) q = q.where('fyLabel', '==', fy);
    if (status) q = q.where('status', '==', status);
    if (account) q = q.where('accountLabel', '==', account);
    if (budgetLineId) q = q.where('budgetLineId', '==', budgetLineId);
    if (relatedParty === 'true') q = q.where('relatedPartyEntryId', '!=', null);
    const snap = await q.orderBy('createdAt', 'desc').limit(200).get();
    const entries = snap.docs.map((d) => ({ id: d.id, ...(d.data() as LedgerEntry) }));
    return NextResponse.json({ entries });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermission(caller.role, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as Partial<LedgerEntry>;

    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return httpError(400, 'date (YYYY-MM-DD) is required');
    if (body.type !== 'income' && body.type !== 'expense') return httpError(400, 'type must be income or expense');
    if (!Number.isInteger(body.amountPkr) || (body.amountPkr as number) <= 0) {
      return httpError(400, 'amountPkr must be a positive integer (rupees)');
    }
    if (!body.category || !FINANCE_CATEGORIES.includes(body.category)) return httpError(400, 'category is invalid');
    if (!body.paymentMethod || !PAYMENT_METHODS.includes(body.paymentMethod)) {
      return httpError(400, 'paymentMethod is invalid');
    }
    if (!body.accountLabel) return httpError(400, 'accountLabel is required');
    const accounts = await getFinanceAccounts(caller.db);
    if (accounts.length > 0 && !accounts.some((a) => a.label === body.accountLabel)) {
      return httpError(422, `Unknown account label: ${body.accountLabel}`);
    }

    // Related-party consistency (spec 3.2): record exists, is a related
    // party, and the category matches the record's channel.
    if (body.relatedPartyEntryId) {
      const rpSnap = await caller.db.collection('sponsors_partners').doc(body.relatedPartyEntryId).get();
      if (!rpSnap.exists) return httpError(422, 'Related-party record not found');
      const rp = rpSnap.data() as { isRelatedParty?: boolean; relatedParty?: { channel?: number } | null };
      if (!rp.isRelatedParty) return httpError(422, 'Counterparty record is not flagged as a related party');
      const channel = rp.relatedParty?.channel;
      if (typeof channel === 'number' && !categoryMatchesChannel(body.category, channel)) {
        return httpError(422, `Category ${body.category} is inconsistent with related-party channel ${channel}`);
      }
    }

    const flags = await computeEntryFlags(caller.db, {
      date: body.date,
      type: body.type,
      amountPkr: body.amountPkr as number,
      budgetLineId: body.budgetLineId ?? null,
    });

    const ref = caller.db.collection('ledger_entries').doc();
    const batch = caller.db.batch();
    batch.set(ref, {
      date: body.date,
      fyLabel: flags.fyLabel,
      type: body.type,
      category: body.category,
      amountPkr: body.amountPkr,
      counterparty: body.counterparty ?? '',
      counterpartyPartnerId: body.counterpartyPartnerId ?? null,
      description: body.description ?? '',
      budgetLineId: body.budgetLineId ?? null,
      unbudgeted: flags.unbudgeted,
      overThreshold: flags.overThreshold,
      consentId: body.consentId ?? null,
      paymentMethod: body.paymentMethod,
      accountLabel: body.accountLabel,
      receiptDriveId: body.receiptDriveId ?? null,
      receiptHash: body.receiptHash ?? null,
      relatedPartyEntryId: body.relatedPartyEntryId ?? null,
      enteredBy: caller.uid,
      status: 'draft',
      postedBy: null,
      postedAt: null,
      sourceOrderId: body.sourceOrderId ?? null,
      reversalOf: null,
      reversedBy: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_DRAFT_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { amountPkr: body.amountPkr, type: body.type, unbudgeted: flags.unbudgeted, overThreshold: flags.overThreshold },
    });
    await batch.commit();
    return NextResponse.json({ id: ref.id, fyLabel: flags.fyLabel, ...flags }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

async function loadOwnedDraft(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth;
  const { caller } = auth;
  if (!(await hasServerPermission(caller.role, 'canManageFinance'))) {
    return { response: httpError(403, 'Forbidden') };
  }
  const body = (await request.json()) as { id?: string } & Partial<LedgerEntry>;
  if (!body.id) return { response: httpError(400, 'id is required') };
  const ref = caller.db.collection('ledger_entries').doc(body.id);
  const snap = await ref.get();
  if (!snap.exists) return { response: httpError(404, 'Ledger entry not found') };
  const entry = snap.data() as LedgerEntry;
  if (entry.status === 'posted') {
    return {
      response: httpError(409, 'Posted entries are immutable; corrections are reversing entries'),
    };
  }
  if (entry.enteredBy !== caller.uid) {
    return { response: httpError(403, 'Only the maker can edit or delete a draft entry') };
  }
  return { caller, body, ref, entry };
}

export async function PUT(request: NextRequest) {
  try {
    const loaded = await loadOwnedDraft(request);
    if ('response' in loaded) return loaded.response;
    const { caller, body, ref } = loaded;
    const editable: Partial<LedgerEntry> = {};
    for (const k of [
      'date', 'type', 'category', 'amountPkr', 'counterparty', 'counterpartyPartnerId', 'description',
      'budgetLineId', 'consentId', 'paymentMethod', 'accountLabel', 'receiptDriveId', 'receiptHash',
      'relatedPartyEntryId',
    ] as const) {
      if (body[k] !== undefined) (editable as Record<string, unknown>)[k] = body[k];
    }
    if (editable.amountPkr !== undefined && (!Number.isInteger(editable.amountPkr) || (editable.amountPkr as number) <= 0)) {
      return httpError(400, 'amountPkr must be a positive integer (rupees)');
    }
    // Recompute derived flags when the inputs change.
    const merged = { ...loaded.entry, ...editable };
    const flags = await computeEntryFlags(caller.db, {
      date: merged.date,
      type: merged.type,
      amountPkr: merged.amountPkr,
      budgetLineId: merged.budgetLineId,
    });
    const batch = caller.db.batch();
    batch.update(ref, { ...editable, fyLabel: flags.fyLabel, unbudgeted: flags.unbudgeted, overThreshold: flags.overThreshold, updatedAt: FieldValue.serverTimestamp() });
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_DRAFT_EDITED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { fields: Object.keys(editable) },
    });
    await batch.commit();
    return NextResponse.json({ id: ref.id, ...flags });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const loaded = await loadOwnedDraft(request);
    if ('response' in loaded) return loaded.response;
    const { caller, ref } = loaded;
    const batch = caller.db.batch();
    batch.delete(ref);
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_DRAFT_DELETED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { amountPkr: loaded.entry.amountPkr, type: loaded.entry.type },
    });
    await batch.commit();
    return NextResponse.json({ id: ref.id, deleted: true });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
