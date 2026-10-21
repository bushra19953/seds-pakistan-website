import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermission } from '@/lib/server/permissions';
import type { Reconciliation } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Reconciliations (spec Part C 4.3). Completion is deliberately NOT routed
 * through money_approvals: the record carries its own two-person control
 * (reconciledBy != completedBy) and completing one moves no money. Doc id
 * is `${accountSlug}-${YYYY-MM}` so exactly one record exists per account
 * per month; a second POST for the same id is a 409.
 */

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
      (await hasServerPermission(caller.role, 'canManageFinance')) ||
      (await hasServerPermission(caller.role, 'canApproveMoney'));
    if (!can) return httpError(403, 'Forbidden');
    const month = new URL(request.url).searchParams.get('month');
    let q: FirebaseFirestore.Query = caller.db.collection('finance_reconciliations');
    if (month) q = q.where('month', '==', month);
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
    if (!(await hasServerPermission(caller.role, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as Partial<Reconciliation>;
    if (!body.accountLabel || !body.accountSlug) return httpError(400, 'accountLabel and accountSlug are required');
    if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) return httpError(400, 'month (YYYY-MM) is required');
    if (!Number.isInteger(body.openingBalancePkr)) return httpError(400, 'openingBalancePkr (integer) is required');
    if (!Number.isInteger(body.statementBalancePkr)) return httpError(400, 'statementBalancePkr (integer) is required');

    const id = `${body.accountSlug}-${body.month}`;
    const ref = caller.db.collection('finance_reconciliations').doc(id);
    if ((await ref.get()).exists) return httpError(409, `Reconciliation already exists for ${id}`);

    const { periodStart, periodEnd } = monthPeriod(body.month);
    const batch = caller.db.batch();
    batch.set(ref, {
      accountLabel: body.accountLabel,
      accountSlug: body.accountSlug,
      month: body.month,
      periodStart,
      periodEnd,
      openingBalancePkr: body.openingBalancePkr,
      ledgerBalancePkr: null, // computed at completion from posted entries
      statementBalancePkr: body.statementBalancePkr,
      differencePkr: null,
      differenceExplanation: '',
      statementDriveId: '',
      statementDriveUrl: '',
      reconciledBy: caller.uid,
      completedBy: null,
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'RECONCILIATION_DRAFT_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_reconciliations/${id}`,
      payload: { accountLabel: body.accountLabel, month: body.month },
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
    if (!(await hasServerPermission(caller.role, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as { id?: string } & Partial<Reconciliation>;
    if (!body.id) return httpError(400, 'id is required');
    const ref = caller.db.collection('finance_reconciliations').doc(body.id);
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Reconciliation not found');
    const rec = snap.data() as Reconciliation;
    if (rec.status !== 'draft') return httpError(409, 'Completed reconciliations are immutable');
    if (rec.reconciledBy !== caller.uid) return httpError(403, 'Only the maker (reconciledBy) can edit a draft');
    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    for (const k of ['openingBalancePkr', 'statementBalancePkr', 'differenceExplanation', 'statementDriveId', 'statementDriveUrl'] as const) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    await ref.update(updates);
    return NextResponse.json({ id: body.id });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
