import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { createMoneyApprovalRequest } from '@/lib/finance/money-approval';
import { deriveFyLabel } from '@/lib/finance/ledger';
import { financePrimaryEnabled } from '@/lib/finance/supa/primary';
import { EXPENDITURE_THRESHOLD_PKR } from '@/types/finance';
import { payoutHatNote } from '@/lib/store/hat-note';
import { updateVendorPayout } from '@/lib/server/vendor-shop';

/**
 * Submit a payout draft into the finance approvals queue (R-3).
 *
 * No vendor_payout target type exists. The payout rides the existing
 * ledger_post machinery: this route creates a company/shop-tagged
 * ledger_entries draft for netPkr, then raises a ledger_post approval
 * against it. The approval id becomes vendor_payouts.financeApprovalId.
 * A checker approves in the Finance approvals queue (maker != checker
 * is the engine's rule); approval posts the ledger entry. The payout
 * doc itself moves to approved when the Vendors tab summary reads the
 * linked approval as approved_applied, and mark-transferred performs
 * the entry and order flips after the real bank transfer.
 *
 * Company-hat money is not a society budget expense, so hook H1
 * (budget-line) does not apply and unbudgeted stays false; hook H2
 * (single expense over the threshold) is computed truthfully, so a
 * payout above PKR 250,000 still needs a decided Founder Consent
 * before the engine will post it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  const db = caller.db;
  const { id } = await params;
  try {
    if (!(await hasServerPermissionForUser(db, caller.uid, 'canManageStore'))) return httpError(403, 'Forbidden');

    // RISK-1 guard: with the finance write-primary on, GG does not mint
    // a payout approval in this build. Cheap insurance, kept per plan.
    if (financePrimaryEnabled()) {
      return NextResponse.json(
        { error: 'Vendor payout approvals need the Firestore finance path in the pilot', code: 'finance_primary_unsupported' },
        { status: 503 },
      );
    }

    const payoutSnap = await db.collection('vendor_payouts').doc(id).get();
    if (!payoutSnap.exists) return httpError(404, 'Payout not found');
    const payout = payoutSnap.data() as Record<string, unknown>;
    if (payout.status !== 'draft') {
      return NextResponse.json(
        { error: 'Only a draft payout can be submitted', code: 'payout_not_draft' },
        { status: 422 },
      );
    }
    const netPkr = payout.netPkr;
    if (typeof netPkr !== 'number' || !Number.isInteger(netPkr) || netPkr <= 0) {
      return httpError(422, 'Payout net amount is missing or invalid');
    }

    const vendorSnap = await db.collection('vendors').doc(String(payout.vendorId)).get();
    const businessName = vendorSnap.exists
      ? String((vendorSnap.data() as Record<string, unknown>).businessName ?? '')
      : '';
    const reason = payoutHatNote(businessName, String(payout.periodStart ?? ''), String(payout.periodEnd ?? ''));
    const date = new Date().toISOString().slice(0, 10);

    const entryRef = db.collection('ledger_entries').doc();
    const entry = {
      date,
      fyLabel: deriveFyLabel(date),
      type: 'expense',
      category: 'operations',
      amountPkr: netPkr,
      counterparty: businessName,
      counterpartyPartnerId: null,
      description: reason,
      budgetLineId: null,
      unbudgeted: false,
      overThreshold: netPkr > EXPENDITURE_THRESHOLD_PKR,
      consentId: null,
      paymentMethod: 'bank_transfer',
      accountLabel: '',
      receiptDriveId: null,
      receiptHash: null,
      relatedPartyEntryId: null,
      enteredBy: caller.uid,
      status: 'draft',
      postedBy: null,
      postedAt: null,
      sourceOrderId: null,
      reversalOf: null,
      reversedBy: null,
      entityTag: 'company',
      shopTag: 'vendor_payout',
      vendorId: String(payout.vendorId ?? ''),
      vendorPayoutId: id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await entryRef.set(entry);

    let approvalId: string;
    try {
      const created = await createMoneyApprovalRequest(
        db,
        { uid: caller.uid, role: caller.role },
        {
          targetType: 'ledger_post',
          targetId: entryRef.id,
          changePayload: { vendorPayoutId: id, vendorId: String(payout.vendorId ?? ''), netPkr },
          reason,
        },
      );
      approvalId = created.id;
    } catch (err) {
      // The approval was not created; remove the orphan ledger draft so
      // a retry starts clean, then surface the engine error verbatim.
      await entryRef.delete().catch(() => undefined);
      throw err;
    }

    await updateVendorPayout(db, id, { status: 'pending_approval', financeApprovalId: approvalId });
    return NextResponse.json({ ok: true, payoutId: id, financeApprovalId: approvalId, ledgerEntryId: entryRef.id });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
