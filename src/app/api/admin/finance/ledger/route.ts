import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { FINANCE_CATEGORIES, type LedgerEntry } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { computeEntryFlags, getFinanceAccounts } from '@/lib/finance/ledger';
import { categoryMatchesChannel } from '@/lib/finance/related-party-gate';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-ledger
import {
  FINANCE_LEDGER_SURFACE,
  mirrorLedgerDelete,
  mirrorLedgerSet,
  mirrorLedgerUpdate,
  supaLedgerEntryDoc,
  supaListLedgerEntries,
  supaRelatedPartyDoc,
} from '@/lib/finance/supa/ledger-receipts-seam';
import type { WhereClause } from '@/lib/supa';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts. ON: the tx_finance_* function is the
// only writer (no Firestore batch, no post-commit mirror). OFF: the
// Firestore batch + mirror below run byte-identically.
import { callFinanceTx, financePayloadHash, financePrimaryEnabled } from '@/lib/finance/supa/primary';

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
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canViewAuditLogs'));
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
    // MIGRATION SEAM: finance finance-ledger (R1)
    const where: WhereClause[] = [];
    if (fy) where.push(['fyLabel', '==', fy]);
    if (status) where.push(['status', '==', status]);
    if (account) where.push(['accountLabel', '==', account]);
    if (budgetLineId) where.push(['budgetLineId', '==', budgetLineId]);
    if (relatedParty === 'true') where.push(['relatedPartyEntryId', '!=', null]);
    const supaEntries = await supaListLedgerEntries(where);
    if (supaEntries !== null) {
      return NextResponse.json({ entries: supaEntries });
    }
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
    if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) return httpError(403, 'Forbidden');
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
      // MIGRATION SEAM: finance finance-ledger (R2; sponsors_partners is CRM-owned)
      const rpSnap =
        (await supaRelatedPartyDoc(body.relatedPartyEntryId)) ??
        (await caller.db.collection('sponsors_partners').doc(body.relatedPartyEntryId).get());
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

    // CUTOVER (F5a): the function stamps createdAt/updatedAt SQL-side
    // (timestamp law T6 — no timestamp fields are passed in), writes
    // the draft + LEDGER_DRAFT_CREATED audit in one tx, and re-verifies
    // the integer amount invariant before writing.
    if (financePrimaryEnabled()) {
      const newId = caller.db.collection('ledger_entries').doc().id;
      const res = await callFinanceTx(
        'finance_ledger_create_draft',
        'tx_finance_ledger_create_draft',
        {
          p_caller_uid: caller.uid,
          p_new_id: newId,
          p_entry: {
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
          },
          p_audit_action: 'LEDGER_DRAFT_CREATED',
          p_audit_payload: {
            amountPkr: body.amountPkr,
            type: body.type,
            unbudgeted: flags.unbudgeted,
            overThreshold: flags.overThreshold,
          },
        },
        `ledger_create:${newId}:${caller.uid}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json(
        {
          id: (res.id as string) ?? newId,
          fyLabel: (res.fyLabel as string) ?? flags.fyLabel,
          unbudgeted: (res.unbudgeted as boolean) ?? flags.unbudgeted,
          overThreshold: (res.overThreshold as boolean) ?? flags.overThreshold,
        },
        { status: 201 },
      );
    }

    const ref = caller.db.collection('ledger_entries').doc();
    const newEntry = {
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
    };
    const batch = caller.db.batch();
    batch.set(ref, newEntry);
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_DRAFT_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { amountPkr: body.amountPkr, type: body.type, unbudgeted: flags.unbudgeted, overThreshold: flags.overThreshold },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-ledger (W1 mirror, MANUAL_LIST M-FG123-5)
    await mirrorLedgerSet(ref.id, newEntry as unknown as Record<string, unknown>);
    return NextResponse.json({ id: ref.id, ...flags }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

async function loadOwnedDraft(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth;
  const { caller } = auth;
  if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) {
    return { response: httpError(403, 'Forbidden') };
  }
  const body = (await request.json()) as { id?: string } & Partial<LedgerEntry>;
  if (!body.id) return { response: httpError(400, 'id is required') };
  const ref = caller.db.collection('ledger_entries').doc(body.id);
  // MIGRATION SEAM: finance finance-ledger (R4)
  const snap = (await supaLedgerEntryDoc(FINANCE_LEDGER_SURFACE, body.id)) ?? (await ref.get());
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
    // CUTOVER (F5b): the function re-checks owner + draft under a row
    // lock (closing the read-then-write gap), applies the edit + flags,
    // and writes LEDGER_DRAFT_EDITED in the same tx.
    if (financePrimaryEnabled()) {
      const res = await callFinanceTx(
        'finance_ledger_edit_draft',
        'tx_finance_ledger_edit_draft',
        {
          p_caller_uid: caller.uid,
          p_entry_id: ref.id,
          p_editable: editable as Record<string, unknown>,
          p_fields: Object.keys(editable),
          p_flags: { fyLabel: flags.fyLabel, unbudgeted: flags.unbudgeted, overThreshold: flags.overThreshold },
          p_audit_action: 'LEDGER_DRAFT_EDITED',
        },
        `ledger_edit:${ref.id}:${caller.uid}:${financePayloadHash({ editable, flags })}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ id: ref.id, ...flags });
    }
    const batch = caller.db.batch();
    batch.update(ref, { ...editable, fyLabel: flags.fyLabel, unbudgeted: flags.unbudgeted, overThreshold: flags.overThreshold, updatedAt: FieldValue.serverTimestamp() });
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_DRAFT_EDITED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { fields: Object.keys(editable) },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-ledger (W2 mirror, MANUAL_LIST M-FG123-5)
    await mirrorLedgerUpdate(ref.id, {
      ...editable,
      fyLabel: flags.fyLabel,
      unbudgeted: flags.unbudgeted,
      overThreshold: flags.overThreshold,
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>);
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
    // CUTOVER (F5c): the function re-checks owner + draft under a row
    // lock, deletes, and writes LEDGER_DRAFT_DELETED (payload taken
    // from the locked row) in the same tx.
    if (financePrimaryEnabled()) {
      const res = await callFinanceTx(
        'finance_ledger_delete_draft',
        'tx_finance_ledger_delete_draft',
        {
          p_caller_uid: caller.uid,
          p_entry_id: ref.id,
          p_audit_action: 'LEDGER_DRAFT_DELETED',
        },
        `ledger_delete:${ref.id}:${caller.uid}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ id: ref.id, deleted: true });
    }
    const batch = caller.db.batch();
    batch.delete(ref);
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_DRAFT_DELETED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { amountPkr: loaded.entry.amountPkr, type: loaded.entry.type },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-ledger (W3 mirror, MANUAL_LIST M-FG123-5)
    await mirrorLedgerDelete(ref.id);
    return NextResponse.json({ id: ref.id, deleted: true });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
