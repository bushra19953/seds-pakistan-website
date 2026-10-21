import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  ConsentServiceError,
  supplyInformation,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

function handleError(err: unknown) {
  if (err instanceof ConsentServiceError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.fields) body.fields = err.fields;
    return NextResponse.json(body, { status: err.status });
  }
  console.error('[api/consents/[id]/information] unexpected error', err);
  return NextResponse.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

/**
 * POST /api/consents/[id]/information - requester supplies the further
 * information the Founder asked for. Body: { response }.
 * The service restarts the 30-day clock from the reply.
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

  let body: { response?: string } = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  try {
    const result: any = await supplyInformation(
      db,
      params.id,
      auth.user.userId,
      body.response as string,
      new Date(),
    );
    return NextResponse.json(result ?? { id: params.id });
  } catch (err) {
    return handleError(err);
  }
}
