import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { LedgerEntry } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Reversal creation (spec Part C 4.2). Creates a DRAFT reversing entry for
 * a posted entry; the reversal itself posts through the normal ledger_post
 * approval, whose apply step stamps reversedBy on the original (the only
 * post-posting write ever made to a posted entry). Reversing an already
 * reversed entry, or reversing a reversal, is a 422.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as { entryId?: string; reason?: string; date?: string };
    if (!body.entryId || !body.reason?.trim() || !body.date) {
      return httpError(400, 'entryId, reason, and date are required');
    }
    const origRef = caller.db.collection('ledger_entries').doc(body.entryId);
    const snap = await origRef.get();
    if (!snap.exists) return httpError(404, 'Ledger entry not found');
    const orig = snap.data() as LedgerEntry;
    if (orig.status !== 'posted') return httpError(422, 'Only a posted entry can be reversed');
    if (orig.reversedBy) return httpError(422, 'Entry has already been reversed');
    if (orig.reversalOf) return httpError(422, 'A reversing entry cannot itself be reversed');

    const ref = caller.db.collection('ledger_entries').doc();
    const batch = caller.db.batch();
    batch.set(ref, {
      date: body.date,
      fyLabel: orig.fyLabel,
      type: orig.type === 'income' ? 'expense' : 'income',
      category: orig.category,
      amountPkr: orig.amountPkr,
      counterparty: orig.counterparty,
      counterpartyPartnerId: orig.counterpartyPartnerId,
      description: `Reversal of ${body.entryId}: ${body.reason}`,
      budgetLineId: orig.budgetLineId,
      unbudgeted: false,
      overThreshold: false,
      consentId: null,
      paymentMethod: orig.paymentMethod,
      accountLabel: orig.accountLabel,
      receiptDriveId: null,
      receiptHash: null,
      relatedPartyEntryId: orig.relatedPartyEntryId,
      enteredBy: caller.uid,
      status: 'draft',
      postedBy: null,
      postedAt: null,
      sourceOrderId: null,
      reversalOf: body.entryId,
      reversedBy: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'LEDGER_REVERSAL_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `ledger_entries/${ref.id}`,
      payload: { reversalOf: body.entryId, reason: body.reason },
    });
    await batch.commit();
    return NextResponse.json({ id: ref.id, reversalOf: body.entryId }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
