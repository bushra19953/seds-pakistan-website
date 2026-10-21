import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  ConsentServiceError,
  createDraft,
  listMyRequests,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

function misconfigured() {
  return NextResponse.json(
    { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
    { status: 500 },
  );
}

function handleError(err: unknown) {
  if (err instanceof ConsentServiceError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.fields) body.fields = err.fields;
    return NextResponse.json(body, { status: err.status });
  }
  console.error('[api/consents] unexpected error', err);
  return NextResponse.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

/**
 * POST /api/consents - create a draft Consent request.
 * Any signed-in user. All body fields are optional at draft stage.
 * Identity comes from the verified session, never the body; the service
 * snapshots requestedByUid / requesterName / requesterRoleKey server-side.
 */
export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  try {
    const result: any = await createDraft(db, auth.user.userId, body);
    const id = typeof result === 'string' ? result : result?.id;
    return NextResponse.json(
      {
        id,
        status: result?.status ?? 'draft',
        requestNumber: result?.requestNumber ?? null,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * GET /api/consents?limit=&cursor= - the caller's own requests.
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const cursor = searchParams.get('cursor') ?? undefined;

  try {
    const result: any = await listMyRequests(db, auth.user.userId, {
      limit: Number.isFinite(limit as number) ? limit : undefined,
      cursor,
    });
    if (Array.isArray(result)) {
      return NextResponse.json({ requests: result });
    }
    return NextResponse.json(result ?? { requests: [] });
  } catch (err) {
    return handleError(err);
  }
}
