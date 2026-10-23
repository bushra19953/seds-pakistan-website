import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { Reconciliation } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

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
    if ((await ref.get()).exists) return httpError(409, `Reconciliation already exists for ${id}`);

    const { periodStart, periodEnd } = monthPeriod(body.periodMonth);
    const batch = caller.db.batch();
    batch.set(ref, {
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
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${id}`,
      payload: { accountLabel: body.accountLabel, periodMonth: body.periodMonth },
    });
    await batch.commit();
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
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Reconciliation not found');
    const rec = snap.data() as Reconciliation;
    if (rec.status !== 'draft') return httpError(409, 'Completed reconciliations are immutable');
    if (rec.reconciledBy !== caller.uid) return httpError(403, 'Only the maker (reconciledBy) can edit a draft');
    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    // Only the statement-side fields are editable on a draft (spec 4.3).
    if (body.closingBalancePkr !== undefined) updates.closingBalancePkr = body.closingBalancePkr;
    if (body.statementDriveId !== undefined) updates.statementDriveId = body.statementDriveId;
    if (body.differenceExplanation !== undefined) updates.differenceExplanation = body.differenceExplanation;
    const batch = caller.db.batch();
    batch.update(ref, updates);
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_EDITED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${body.id}`,
      payload: { fields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
    });
    await batch.commit();
    return NextResponse.json({ id: body.id });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
