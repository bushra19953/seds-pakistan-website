import { NextRequest, NextResponse } from 'next/server';
import { hasServerPermission } from '@/lib/server/permissions';
import type { MoneyApproval, MoneyApprovalTargetType } from '@/types/finance';
import {
  createMoneyApprovalRequest,
  expireIfNeeded,
  MoneyApprovalError,
} from '@/lib/finance/money-approval';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Money approvals queue (spec Part C 4.5). The ONLY route that applies
 * money state changes to orders, destinations, refunds, budgets, ledger
 * posts, and CRM money fields.
 */

const CREATE_PERMISSIONS: Record<MoneyApprovalTargetType, string[]> = {
  order_verify_payment: ['canManageStore'],
  order_mark_paid: ['canManageStore'],
  order_confirm_seat: ['canManageStore'],
  order_refund: ['canManageStore'],
  order_soft_delete: ['canManageStore'],
  destination_change: ['canManageFinance', 'canManageStore', 'canManagePages'],
  budget_approve: ['canManageFinance'],
  ledger_post: ['canManageFinance'],
  crm_financial_edit: ['canManageSponsorsPartners'],
  crm_status_active: ['canManageSponsorsPartners'],
};

export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const canSee =
      (await hasServerPermission(caller.role, 'canManageFinance')) ||
      (await hasServerPermission(caller.role, 'canApproveMoney')) ||
      (await hasServerPermission(caller.role, 'canManageStore')) ||
      (await hasServerPermission(caller.role, 'canManageSponsorsPartners'));
    if (!canSee) return httpError(403, 'Forbidden');

    const scope = new URL(request.url).searchParams.get('scope') ?? 'checkable';
    const snap = await caller.db.collection('money_approvals').orderBy('createdAt', 'desc').limit(100).get();
    const rows: Array<MoneyApproval & { id: string }> = [];
    for (const doc of snap.docs) {
      const req = { id: doc.id, ...(doc.data() as MoneyApproval) };
      // Lazy expiry (spec 3.4): a pending request past expiresAt is stamped expired on read.
      if (await expireIfNeeded(caller.db, req)) req.status = 'expired';
      if (scope === 'mine') {
        if (req.makerUid === caller.uid) rows.push(req);
      } else {
        if (req.status === 'pending' && req.makerUid !== caller.uid) rows.push(req);
      }
    }
    return NextResponse.json({ approvals: rows });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const body = (await request.json()) as {
      targetType?: MoneyApprovalTargetType;
      targetId?: string;
      changePayload?: Record<string, unknown>;
      reason?: string;
    };
    if (!body.targetType || !body.targetId) return httpError(400, 'targetType and targetId are required');
    const perms = CREATE_PERMISSIONS[body.targetType];
    if (!perms) return httpError(400, `Unknown targetType: ${body.targetType}`);

    let allowed = false;
    for (const p of perms) {
      if (await hasServerPermission(caller.role, p as never)) {
        allowed = true;
        break;
      }
    }
    // pages_donate destination proposals additionally require canManageFinance
    // alongside canManagePages (spec 3.9): a pages-only editor cannot even
    // propose a destination change alone.
    if (body.targetType === 'destination_change' && body.targetId === 'pages_donate') {
      allowed =
        (await hasServerPermission(caller.role, 'canManagePages')) &&
        (await hasServerPermission(caller.role, 'canManageFinance'));
    }
    if (!allowed) return httpError(403, 'Forbidden');

    const { id } = await createMoneyApprovalRequest(caller.db, caller, {
      targetType: body.targetType,
      targetId: body.targetId,
      changePayload: body.changePayload ?? {},
      reason: body.reason ?? null,
    });
    return NextResponse.json({ id, status: 'pending' }, { status: 201 });
  } catch (err) {
    if (err instanceof MoneyApprovalError) return financeErrorResponse(err);
    return financeErrorResponse(err);
  }
}
