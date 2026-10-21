import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/issue-warning - RETIRED by the Phase 2 discipline
 * rebuild (spec E.6.5).
 *
 * Direct warning issuance no longer exists. A warning is now the
 * recorded outcome (Strike 1) of a decided disciplinary case, applied
 * by applyCaseDecision inside the case transaction. This endpoint
 * answers 410 Gone with a pointer to the case API for one release,
 * then it is deleted.
 */
function gone() {
  return NextResponse.json(
    {
      error: 'Gone',
      message:
        'Direct warning issuance has been retired. Open a disciplinary case instead: sanctions are applied only as the outcome of a decided case.',
      successor: '/api/discipline/cases',
    },
    { status: 410 }
  );
}

export async function POST(_request: NextRequest) {
  return gone();
}

export async function GET(_request: NextRequest) {
  return gone();
}
