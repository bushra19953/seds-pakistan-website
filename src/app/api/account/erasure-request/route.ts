import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  ERASURE_PROMISE_TEXT,
  requestErasure,
  withdrawErasure,
} from '@/lib/retention/erasure';
import { createErasureDepsForLifecycle } from '@/lib/retention/server-deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Member self-service erasure (Workstream F). POST starts the 14-day
// cooling-off (F-G1); DELETE withdraws the caller's own open request.
export async function POST(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    reason?: string;
  };
  try {
    const deps = createErasureDepsForLifecycle();
    const result = await requestErasure(
      deps,
      auth.user.userId,
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    return NextResponse.json(
      { ...result, promise: ERASURE_PROMISE_TEXT },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to request erasure' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const requestId = request.nextUrl.searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }
  try {
    const deps = createErasureDepsForLifecycle();
    await withdrawErasure(deps, requestId, auth.user.userId);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to withdraw request' },
      { status: 400 },
    );
  }
}
