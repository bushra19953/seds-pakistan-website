import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { FinanceReceipt } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-receipts
import { mirrorReceiptSet, supaListReceipts } from '@/lib/finance/supa/ledger-receipts-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts.
import { callFinanceTx, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * Receipts inbox (spec Part C 4.4). Any officer (canAccessAdmin) logs a
 * receipt for their own expense; the 14-day delivery SLA is visible in
 * the read model and a breach is data, never a silent miss. SLA fields
 * are computed on read from transactionDate; slaDueAt is stamped at
 * creation as transactionDate + 14 days.
 */

export interface ReceiptReadModel extends FinanceReceipt {
  id: string;
  slaBreached: boolean;
  daysRemaining: number | null;
}

function toReadModel(id: string, r: FinanceReceipt, now: Date): ReceiptReadModel {
  let slaBreached = false;
  let daysRemaining: number | null = null;
  if (!r.deliveredToTreasurerAt && r.slaDueAt) {
    // MIGRATION SEAM: finance finance-receipts — slaDueAt may arrive as an
    // ISO string (jsonb form, seam-normalized) as well as a Date or the
    // { seconds } Timestamp shape; all three must give the same instant.
    // (Before this, an ISO string produced NaN daysRemaining silently.)
    const due =
      r.slaDueAt instanceof Date
        ? r.slaDueAt
        : typeof r.slaDueAt === 'string'
          ? new Date(r.slaDueAt)
          : new Date((r.slaDueAt as { seconds: number }).seconds * 1000);
    daysRemaining = Math.ceil((due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    slaBreached = daysRemaining < 0;
  }
  return { id, ...r, slaBreached, daysRemaining };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canAccessAdmin'));
    if (!can) return httpError(403, 'Forbidden');
    const url = new URL(request.url);
    let q: FirebaseFirestore.Query = caller.db.collection('finance_receipts');
    const kind = url.searchParams.get('kind');
    if (kind) q = q.where('kind', '==', kind);
    const now = new Date();
    // MIGRATION SEAM: finance finance-receipts (R6)
    const supaRows = await supaListReceipts(kind);
    let rows =
      supaRows !== null
        ? supaRows.map((r) => {
            const { id, ...rest } = r;
            return toReadModel(String(id), rest as unknown as FinanceReceipt, now);
          })
        : (await q.orderBy('createdAt', 'desc').limit(200).get()).docs.map((d) =>
            toReadModel(d.id, d.data() as FinanceReceipt, now),
          );
    const sla = url.searchParams.get('sla');
    if (sla === 'breached') rows = rows.filter((r) => r.slaBreached);
    if (sla === 'outstanding') rows = rows.filter((r) => !r.deliveredToTreasurerAt && !r.slaBreached);
    return NextResponse.json({ receipts: rows });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canAccessAdmin'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as Partial<FinanceReceipt>;
    if (body.kind !== 'officer_expense') {
      return httpError(400, 'Only officer_expense receipts are created here; inbound_payment records are created by payment verification');
    }
    if (!body.transactionDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.transactionDate)) {
      return httpError(400, 'transactionDate (YYYY-MM-DD) is required');
    }
    if (!Number.isInteger(body.amountPkr) || (body.amountPkr as number) <= 0) {
      return httpError(400, 'amountPkr must be a positive integer');
    }
    if (!body.receiptDriveId && !body.receiptUrl) return httpError(400, 'A receipt reference (Drive id or URL) is required');
    const slaDueAt = new Date(`${body.transactionDate}T00:00:00Z`);
    slaDueAt.setUTCDate(slaDueAt.getUTCDate() + 14);

    // CUTOVER (F5e): the function derives slaDueAt SQL-side from
    // transactionDate 00:00Z + 14 days (timestamp law T5, base 1 — the
    // decide-created receipts use the verification-instant base
    // instead), stamps createdAt/updatedAt, and writes the receipt +
    // RECEIPT_LOGGED audit in one tx.
    if (financePrimaryEnabled()) {
      const newId = caller.db.collection('finance_receipts').doc().id;
      const res = await callFinanceTx(
        'finance_receipt_log',
        'tx_finance_receipt_log',
        {
          p_caller_uid: caller.uid,
          p_new_id: newId,
          p_transaction_date: body.transactionDate,
          p_receipt: {
            officerUid: caller.uid,
            officerName: '',
            kind: 'officer_expense',
            transactionDate: body.transactionDate,
            amountPkr: body.amountPkr,
            description: body.description ?? '',
            receiptDriveId: body.receiptDriveId ?? '',
            receiptUrl: body.receiptUrl ?? '',
            receiptHash: body.receiptHash ?? null,
            sourceOrderId: null,
            ledgerEntryId: null,
            deliveredToTreasurerAt: null,
            createdBy: caller.uid,
          },
          p_audit_action: 'RECEIPT_LOGGED',
        },
        `receipt_log:${newId}:${caller.uid}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json(
        { id: (res.id as string) ?? newId, slaDueAt: (res.slaDueAt as string) ?? slaDueAt.toISOString() },
        { status: 201 },
      );
    }

    const ref = caller.db.collection('finance_receipts').doc();
    const newReceipt = {
      officerUid: caller.uid,
      officerName: '',
      kind: 'officer_expense',
      transactionDate: body.transactionDate,
      amountPkr: body.amountPkr,
      description: body.description ?? '',
      receiptDriveId: body.receiptDriveId ?? '',
      receiptUrl: body.receiptUrl ?? '',
      receiptHash: body.receiptHash ?? null,
      sourceOrderId: null,
      ledgerEntryId: null,
      deliveredToTreasurerAt: null,
      slaDueAt,
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const batch = caller.db.batch();
    batch.set(ref, newReceipt);
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECEIPT_LOGGED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_receipts/${ref.id}`,
      payload: { amountPkr: body.amountPkr, transactionDate: body.transactionDate },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-receipts (W5 mirror, MANUAL_LIST M-FG123-5)
    await mirrorReceiptSet(ref.id, newReceipt as unknown as Record<string, unknown>);
    return NextResponse.json({ id: ref.id, slaDueAt: slaDueAt.toISOString() }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
