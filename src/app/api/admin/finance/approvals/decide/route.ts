import { NextRequest, NextResponse } from 'next/server';
import { decideMoneyApproval } from '@/lib/finance/money-approval';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * Checker decision endpoint (spec Part C 4.5). Enforces, in order: request
 * pending, not expired, checker != maker (422 MAKER_EQUALS_CHECKER, itself
 * audit-logged), beforeSnapshot still matches the live target, then the
 * apply handler runs in the same transaction as the decision stamp.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const body = (await request.json()) as {
      approvalId?: string;
      decision?: 'approve' | 'reject';
      note?: string;
    };
    if (!body.approvalId || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return httpError(400, 'approvalId and decision (approve|reject) are required');
    }
    if (body.decision === 'reject' && !body.note?.trim()) {
      return httpError(400, 'Rejection requires a note');
    }
    const result = await decideMoneyApproval(caller.db, caller, body.approvalId, body.decision, body.note);
    return NextResponse.json(result);
  } catch (err) {
    return financeErrorResponse(err);
  }
}
