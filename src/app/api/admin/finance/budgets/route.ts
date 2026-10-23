import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { FINANCE_CATEGORIES, type Budget, type BudgetLine, type FinanceAccount } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { computeLineActuals, getFinanceAccounts, setFinanceAccounts } from '@/lib/finance/ledger';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Budgets API (spec Part C 4.1). Budget APPROVAL is not here: it is a
 * money state change and goes through POST /api/admin/finance/approvals
 * with targetType budget_approve. This route owns draft CRUD plus the
 * settings/finance accounts list (labels only, not a destination).
 */

function validateLines(lines: unknown): lines is BudgetLine[] {
  if (!Array.isArray(lines)) return false;
  const ids = new Set<string>();
  for (const l of lines as BudgetLine[]) {
    if (!l.lineId || ids.has(l.lineId)) return false;
    ids.add(l.lineId);
    if (!Number.isInteger(l.allocatedPkr) || l.allocatedPkr < 0) return false;
    if (!FINANCE_CATEGORIES.includes(l.category)) return false;
  }
  return true;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('resource') === 'accounts') {
      if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) return httpError(403, 'Forbidden');
      return NextResponse.json({ accounts: await getFinanceAccounts(caller.db) });
    }
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney'));
    if (!can) return httpError(403, 'Forbidden');

    let q = caller.db.collection('finance_budgets').orderBy('createdAt', 'desc');
    const fy = url.searchParams.get('fy');
    if (fy) q = caller.db.collection('finance_budgets').where('fyLabel', '==', fy) as never;
    const snap = await q.get();
    const budgets: Array<Budget & { computedActuals?: Record<string, { incomePkr: number; expensePkr: number }> }> = [];
    for (const doc of snap.docs) {
      const b = { id: doc.id, ...(doc.data() as Budget) };
      const actuals = await computeLineActuals(caller.db, b.fyLabel);
      budgets.push({ ...b, computedActuals: Object.fromEntries(actuals) });
    }
    return NextResponse.json({ budgets });
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
    const body = (await request.json()) as Partial<Budget> & { revisionOf?: string };
    if (!body.fyLabel || !/^fy\d{4}-\d{2}$/.test(body.fyLabel)) return httpError(400, 'fyLabel must look like fy2026-27');
    if (!body.fyStart || !body.fyEnd) return httpError(400, 'fyStart and fyEnd are required');
    if (!validateLines(body.lines)) {
      return httpError(400, 'lines must have unique lineIds, valid categories, and integer allocations >= 0');
    }
    const lines = body.lines as BudgetLine[];
    const totalAllocatedPkr = lines.reduce((s, l) => s + l.allocatedPkr, 0);

    let revision = 1;
    let docId = body.fyLabel;
    if (body.revisionOf) {
      const prev = await caller.db.collection('finance_budgets').doc(body.revisionOf).get();
      if (!prev.exists) return httpError(404, 'revisionOf budget not found');
      revision = ((prev.data() as Budget).revision ?? 1) + 1;
      docId = `${body.fyLabel}-v${revision}`;
    }
    const ref = caller.db.collection('finance_budgets').doc(docId);
    if ((await ref.get()).exists) return httpError(409, `Budget document ${docId} already exists`);

    const batch = caller.db.batch();
    batch.set(ref, {
      fyLabel: body.fyLabel,
      fyStart: body.fyStart,
      fyEnd: body.fyEnd,
      status: 'draft',
      revision,
      lines,
      totalAllocatedPkr,
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      approvedBy: null,
      approvalId: null,
      consentId: body.consentId ?? null,
      consentPending: false,
      approvedAt: null,
      supersededBy: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'BUDGET_CREATED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_budgets/${docId}`,
      payload: { fyLabel: body.fyLabel, revision, totalAllocatedPkr },
    });
    await batch.commit();
    return NextResponse.json({ id: docId, status: 'draft' }, { status: 201 });
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
    const url = new URL(request.url);
    const body = (await request.json()) as { id?: string; lines?: BudgetLine[]; accounts?: FinanceAccount[] };

    if (url.searchParams.get('resource') === 'accounts') {
      if (!Array.isArray(body.accounts)) return httpError(400, 'accounts array is required');
      for (const a of body.accounts) {
        if (!a.label || !a.slug || (a.type !== 'bank' && a.type !== 'wallet')) {
          return httpError(400, 'each account needs label, slug, and type bank|wallet');
        }
      }
      await setFinanceAccounts(caller.db, body.accounts, caller.uid);
      return NextResponse.json({ accounts: body.accounts });
    }

    if (!body.id) return httpError(400, 'id is required');
    const ref = caller.db.collection('finance_budgets').doc(body.id);
    const snap = await ref.get();
    if (!snap.exists) return httpError(404, 'Budget not found');
    const budget = snap.data() as Budget;
    if (budget.status !== 'draft') {
      return httpError(409, 'Only a draft budget can be edited; create a new revision instead');
    }
    if (!validateLines(body.lines)) {
      return httpError(400, 'lines must have unique lineIds, valid categories, and integer allocations >= 0');
    }
    const lines = body.lines as BudgetLine[];
    const totalAllocatedPkr = lines.reduce((s, l) => s + l.allocatedPkr, 0);
    const batch = caller.db.batch();
    batch.update(ref, { lines, totalAllocatedPkr, updatedAt: FieldValue.serverTimestamp() });
    await writeFinanceAudit(caller.db, batch, {
      action: 'BUDGET_DRAFT_EDITED',
      actorUid: caller.uid,
      targetUidOrResource: `finance_budgets/${body.id}`,
      payload: { totalAllocatedPkr },
    });
    await batch.commit();
    return NextResponse.json({ id: body.id, totalAllocatedPkr });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
