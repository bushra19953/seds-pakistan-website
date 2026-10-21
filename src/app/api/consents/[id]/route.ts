import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';
import { REGISTER_STATUSES } from '@/lib/consents/consent-state';
import { resolveUserRoleKey } from '@/lib/server/role-holders';
import {
  ConsentServiceError,
  getRequest,
  updateDraft,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

function misconfigured() {
  return NextResponse.json(
    { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
    { status: 500 },
  );
}

function unauthorized() {
  return NextResponse.json(
    { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

function forbidden() {
  return NextResponse.json(
    { error: 'Forbidden', code: 'CONSENT_FORBIDDEN' },
    { status: 403 },
  );
}

function handleError(err: unknown) {
  if (err instanceof ConsentServiceError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.fields) body.fields = err.fields;
    return NextResponse.json(body, { status: err.status });
  }
  console.error('[api/consents/[id]] unexpected error', err);
  return NextResponse.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

async function readHistory(db: any, id: string): Promise<any[]> {
  try {
    if (!db || typeof db.collection !== 'function') return [];
    const snap = await db
      .collection('consent_requests')
      .doc(id)
      .collection('history')
      .orderBy('createdAt', 'asc')
      .get();
    if (!snap || !Array.isArray(snap.docs)) return [];
    return snap.docs.map((doc: any) => ({
      id: doc.id,
      ...(typeof doc.data === 'function' ? doc.data() : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * GET /api/consents/[id]
 * Access: the requester (own request, any status), the Founder (any request),
 * or the National General Secretary (decided / register statuses only).
 * Returns the request plus its history array.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) return unauthorized();

  const uid = auth.user.userId;
  const { id } = params;

  try {
    const record: any = await getRequest(db, id);
    if (!record) {
      return NextResponse.json(
        { error: 'Consent request not found', code: 'CONSENT_NOT_FOUND' },
        { status: 404 },
      );
    }

    let allowed = uid === record.requestedByUid || uid === FOUNDER_UID;
    if (!allowed) {
      const roleKey = await resolveUserRoleKey(db, uid);
      allowed =
        roleKey === 'national_general_secretary' &&
        (REGISTER_STATUSES as readonly string[]).includes(record.status);
    }
    if (!allowed) return forbidden();

    const history = Array.isArray(record.history)
      ? record.history
      : await readHistory(db, id);

    return NextResponse.json({ ...record, id: record.id ?? id, history });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * PATCH /api/consents/[id] - edit a draft. The service enforces
 * own-draft-only; a non-draft surfaces as 409 CONSENT_INVALID_TRANSITION.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) return unauthorized();

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  try {
    const result: any = await updateDraft(db, params.id, auth.user.userId, body);
    return NextResponse.json(result ?? { id: params.id });
  } catch (err) {
    return handleError(err);
  }
}
