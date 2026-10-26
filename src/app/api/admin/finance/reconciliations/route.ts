import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { Reconciliation } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-reconciliations
import {
  FINANCE_RECONCILIATIONS_SURFACE,
  mirrorReconciliationSet,
  mirrorReconciliationUpdate,
  supaListReconciliations,
  supaReconciliationDoc,
} from '@/lib/finance/supa/reconciliations-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts.
import { callFinanceTx, financePayloadHash, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * Reconciliations (spec Part C 3.3 + 4.3). One document per account per
 * month, id `${accountSlug}-${periodMonth}` (slugified account label).
 * Completion is deliberately NOT routed through money_approvals: the
 * record carries its own two-person control (reconciledBy maker,
 * checkedBy checker) and completing one moves no money.
 */

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function monthPeriod(month: string): { periodStart: string; periodEnd: string } {
  const [y, m] = month.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(y, m, 0));
  const end = `${y}-${String(m).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return { periodStart: start, periodEnd: end };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney'));
    if (!can) return httpError(403, 'Forbidden');
    const month = new URL(request.url).searchParams.get('month');
    // MIGRATION SEAM: finance finance-reconciliations (R1)
    const supaRows = await supaListReconciliations(month);
    if (supaRows !== null) return NextResponse.json({ reconciliations: supaRows });
    let q: FirebaseFirestore.Query = caller.db.collection('finance_reconciliations');
    if (month) q = q.where('periodMonth', '==', month);
    const snap = await q.orderBy('createdAt', 'desc').limit(100).get();
    return NextResponse.json({ reconciliations: snap.docs.map((d) => ({ id: d.id, ...(d.data() as Reconciliation) })) });
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
    const body = (await request.json()) as {
      accountLabel?: string;
      periodMonth?: string;
      openingBalancePkr?: number;
      complianceObligationId?: string | null;
    };
    if (!body.accountLabel) return httpError(400, 'accountLabel is required');
    if (!body.periodMonth || !/^\d{4}-\d{2}$/.test(body.periodMonth)) {
      return httpError(400, 'periodMonth (YYYY-MM) is required');
    }
    if (!Number.isInteger(body.openingBalancePkr)) {
      return httpError(400, 'openingBalancePkr (integer) is required');
    }

    const id = `${slugify(body.accountLabel)}-${body.periodMonth}`;
    const ref = caller.db.collection('finance_reconciliations').doc(id);
    // MIGRATION SEAM: finance finance-reconciliations (R2 duplicate guard)
    const existing =
      (await supaReconciliationDoc(FINANCE_RECONCILIATIONS_SURFACE, id)) ?? (await ref.get());
    if (existing.exists) return httpError(409, `Reconciliation already exists for ${id}`);

    const { periodStart, periodEnd } = monthPeriod(body.periodMonth);
    // CUTOVER (F5j): the function relies on the deterministic-id PK for
    // the exists race and writes the draft + RECONCILIATION_CREATED in
    // one tx.
    if (financePrimaryEnabled()) {
      const res = await callFinanceTx(
        'finance_reconciliation_create',
        'tx_finance_reconciliation_create',
        {
          p_caller_uid: caller.uid,
          p_rec_id: id,
          p_rec: {
            accountLabel: body.accountLabel,
            periodMonth: body.periodMonth,
            periodStart,
            periodEnd,
            openingBalancePkr: body.openingBalancePkr,
            closingBalancePkr: null,
            ledgerBalancePkr: null,
            differencePkr: null,
            differenceExplanation: null,
            statementDriveId: null,
            reconciledBy: caller.uid,
            checkedBy: null,
            status: 'draft',
            completedAt: null,
            computedAt: null,
            complianceObligationId: body.complianceObligationId ?? null,
          },
          p_audit_action: 'RECONCILIATION_CREATED',
          p_audit_payload: { accountLabel: body.accountLabel, periodMonth: body.periodMonth },
        },
        `reconciliation_create:${id}:${caller.uid}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ id, status: 'draft' }, { status: 201 });
    }
    const newRec = {
      accountLabel: body.accountLabel,
      periodMonth: body.periodMonth,
      periodStart,
      periodEnd,
      openingBalancePkr: body.openingBalancePkr,
      closingBalancePkr: null,
      ledgerBalancePkr: null, // computed at completion from posted entries
      differencePkr: null,
      differenceExplanation: null,
      statementDriveId: null,
      reconciledBy: caller.uid,
      checkedBy: null,
      status: 'draft',
      completedAt: null,
      computedAt: null,
      complianceObligationId: body.complianceObligationId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const batch = caller.db.batch();
    batch.set(ref, newRec);
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${id}`,
      payload: { accountLabel: body.accountLabel, periodMonth: body.periodMonth },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-reconciliations (W1 mirror)
    await mirrorReconciliationSet(id, newRec as unknown as Record<string, unknown>);
    return NextResponse.json({ id, status: 'draft' }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function PUT(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as { id?: string } & Partial<Reconciliation>;
    if (!body.id) return httpError(400, 'id is required');
    const ref = caller.db.collection('finance_reconciliations').doc(body.id);
    // MIGRATION SEAM: finance finance-reconciliations (R3)
    const snap =
      (await supaReconciliationDoc(FINANCE_RECONCILIATIONS_SURFACE, body.id)) ?? (await ref.get());
    if (!snap.exists) return httpError(404, 'Reconciliation not found');
    const rec = snap.data() as Reconciliation;
    if (rec.status !== 'draft') return httpError(409, 'Completed reconciliations are immutable');
    if (rec.reconciledBy !== caller.uid) return httpError(403, 'Only the maker (reconciledBy) can edit a draft');
    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    // Only the statement-side fields are editable on a draft (spec 4.3).
    if (body.closingBalancePkr !== undefined) updates.closingBalancePkr = body.closingBalancePkr;
    if (body.statementDriveId !== undefined) updates.statementDriveId = body.statementDriveId;
    if (body.differenceExplanation !== undefined) updates.differenceExplanation = body.differenceExplanation;
    // CUTOVER (F5k): the function re-checks draft + maker-only under a
    // row lock, applies the statement-side fields, and writes
    // RECONCILIATION_EDITED in the same tx. The updatedAt sentinel is
    // stripped — the function stamps it SQL-side (timestamp law T6).
    if (financePrimaryEnabled()) {
      const editFields: Record<string, unknown> = { ...updates };
      delete editFields.updatedAt;
      const res = await callFinanceTx(
        'finance_reconciliation_edit',
        'tx_finance_reconciliation_edit',
        {
          p_caller_uid: caller.uid,
          p_rec_id: body.id,
          p_updates: editFields,
          p_fields: Object.keys(editFields),
          p_audit_action: 'RECONCILIATION_EDITED',
        },
        `reconciliation_edit:${body.id}:${caller.uid}:${financePayloadHash(editFields)}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ id: body.id });
    }
    const batch = caller.db.batch();
    batch.update(ref, updates);
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_EDITED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${body.id}`,
      payload: { fields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-reconciliations (W2 mirror)
    await mirrorReconciliationUpdate(body.id, {
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ id: body.id });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
