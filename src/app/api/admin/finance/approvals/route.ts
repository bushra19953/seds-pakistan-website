import { NextRequest, NextResponse } from 'next/server';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { PermissionKey } from '@/config/permissions.config';
import type { MoneyApproval, MoneyApprovalTargetType } from '@/types/finance';
import {
  createMoneyApprovalRequest,
  createOrConsumeMoneyApprovalRequest,
  expireIfNeeded,
  MoneyApprovalError,
} from '@/lib/finance/money-approval';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-approvals
import { supaListApprovals } from '@/lib/finance/supa/money-approvals-seam';

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
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageStore')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageSponsorsPartners'));
    if (!canSee) return httpError(403, 'Forbidden');

    const scope = new URL(request.url).searchParams.get('scope') ?? 'checkable';
    // MIGRATION SEAM: finance finance-approvals (R7 queue list)
    const supaRows = await supaListApprovals();
    const source: Array<MoneyApproval & { id: string }> | null =
      supaRows !== null ? (supaRows as unknown as Array<MoneyApproval & { id: string }>) : null;
    const snap =
      source === null
        ? await caller.db.collection('money_approvals').orderBy('createdAt', 'desc').limit(100).get()
        : null;
    const docs: Array<{ id: string; data: () => MoneyApproval }> =
      source !== null
        ? source.map((r) => ({ id: r.id, data: () => r }))
        : snap!.docs.map((d) => ({ id: d.id, data: () => d.data() as MoneyApproval }));
    // READ-BLEED FIX (rbt2): classify BOTH scopes in the single pass
    // below. The approvals tab used to fire this route twice per mount
    // (scope=checkable + scope=mine), re-running the whole limit-100
    // list read and the per-row lazy-expiry pass each time for two
    // disjoint slices of the same rows. scope=both now returns both
    // slices from ONE list read; the single-scope responses are
    // byte-identical to before (same rows, same order, same expiry
    // side effects over the full list).
    const checkable: Array<MoneyApproval & { id: string }> = [];
    const mine: Array<MoneyApproval & { id: string }> = [];
    for (const doc of docs) {
      const req = { id: doc.id, ...(doc.data() as MoneyApproval) };
      // Lazy expiry (spec 3.4): a pending request past expiresAt is stamped expired on read.
      if (await expireIfNeeded(caller.db, req)) req.status = 'expired';
      if (req.makerUid === caller.uid) mine.push(req);
      else if (req.status === 'pending') checkable.push(req);
    }
    if (scope === 'both') {
      return NextResponse.json({ approvals: checkable, checkable, mine });
    }
    return NextResponse.json({ approvals: scope === 'mine' ? mine : checkable });
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
      if (await hasServerPermissionForUser(caller.db, caller.uid, p as PermissionKey)) {
        allowed = true;
        break;
      }
    }
    // pages_donate destination proposals additionally require canManageFinance
    // alongside canManagePages (spec 3.9): a pages-only editor cannot even
    // propose a destination change alone.
    if (body.targetType === 'destination_change' && body.targetId === 'pages_donate') {
      allowed =
        (await hasServerPermissionForUser(caller.db, caller.uid, 'canManagePages')) &&
        (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'));
    }
    if (!allowed) return httpError(403, 'Forbidden');

    const input = {
      targetType: body.targetType,
      targetId: body.targetId,
      changePayload: body.changePayload ?? {},
      reason: body.reason ?? null,
    };
    // Defect 2: order verify actions consume an already-pending equivalent
    // request instead of dead-ending on the duplicate-pending 409. All
    // other target types keep the plain create contract (409 included).
    if (body.targetType === 'order_verify_payment' || body.targetType === 'order_mark_paid') {
      const { id, alreadyPending } = await createOrConsumeMoneyApprovalRequest(caller.db, caller, input);
      return NextResponse.json(
        { id, status: 'pending', alreadyPending },
        { status: alreadyPending ? 200 : 201 },
      );
    }
    const { id } = await createMoneyApprovalRequest(caller.db, caller, input);
    return NextResponse.json({ id, status: 'pending' }, { status: 201 });
  } catch (err) {
    if (err instanceof MoneyApprovalError) return financeErrorResponse(err);
    return financeErrorResponse(err);
  }
}
