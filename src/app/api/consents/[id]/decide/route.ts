import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isConsentDecider } from '@/lib/consents/consent-config';
import {
  ConsentServiceError,
  decideRequest,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

function handleError(err: unknown) {
  if (err instanceof ConsentServiceError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.fields) body.fields = err.fields;
    return NextResponse.json(body, { status: err.status });
  }
  console.error('[api/consents/[id]/decide] unexpected error', err);
  return NextResponse.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

/**
 * POST /api/consents/[id]/decide - Founder only.
 * The Founder gate runs in this route, BEFORE the body is parsed any
 * further: a non-decider (including a chief_technology_officer holder, a
 * superadmin, or a president who is not the Founder) gets 403 NOT_FOUNDER
 * and the service is never called.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) {
    return NextResponse.json(
      { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
      { status: 500 },
    );
  }

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const decider = await isConsentDecider(db, auth.user.userId);
  if (!decider) {
    return NextResponse.json(
      { error: 'Only the Founder decides Consent requests', code: 'NOT_FOUNDER' },
      { status: 403 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  try {
    const result: any = await decideRequest(
      db,
      params.id,
      auth.user.userId,
      body,
      new Date(),
    );
    return NextResponse.json(result ?? { id: params.id });
  } catch (err) {
    return handleError(err);
  }
}
