import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  ConsentServiceError,
  executeRequest,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

function handleError(err: unknown) {
  if (err instanceof ConsentServiceError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.fields) body.fields = err.fields;
    return NextResponse.json(body, { status: err.status });
  }
  console.error('[api/consents/[id]/execute] unexpected error', err);
  return NextResponse.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

/**
 * POST /api/consents/[id]/execute - requester marks an own consented /
 * conditional / waived request as executed. Body: { executionNote? }.
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

  let body: { executionNote?: string } = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  try {
    const result: any = await executeRequest(
      db,
      params.id,
      auth.user.userId,
      body.executionNote,
    );
    return NextResponse.json(result ?? { id: params.id });
  } catch (err) {
    return handleError(err);
  }
}
