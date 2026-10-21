import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';
import { resolveUserRoleKey } from '@/lib/server/role-holders';
import {
  ConsentServiceError,
  listRegister,
  toRegisterCsv,
  type RegisterFilters,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/consents/register - the Register of Consents.
 * Access: the Founder, or a caller whose server-resolved role key is
 * national_general_secretary (the register's keeper). The service
 * hard-filters to decided statuses regardless of query params.
 * ?format=csv returns the register as a CSV attachment (spec A.7).
 */
export async function GET(request: NextRequest) {
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

  const uid = auth.user.userId;
  let allowed = uid === FOUNDER_UID;
  if (!allowed) {
    const roleKey = await resolveUserRoleKey(db, uid);
    allowed = roleKey === 'national_general_secretary';
  }
  if (!allowed) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'CONSENT_FORBIDDEN' },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const filters: RegisterFilters = {};
  const status = searchParams.get('status');
  if (status) filters.status = status;
  const matterKey = searchParams.get('matterKey');
  if (matterKey) filters.matterKey = matterKey;
  const q = searchParams.get('q');
  if (q) filters.q = q;
  const fromRaw = searchParams.get('from');
  if (fromRaw) {
    const from = new Date(fromRaw);
    if (!Number.isNaN(from.getTime())) filters.from = from;
  }
  const toRaw = searchParams.get('to');
  if (toRaw) {
    const to = new Date(toRaw);
    if (!Number.isNaN(to.getTime())) filters.to = to;
  }
  const limitRaw = searchParams.get('limit');
  if (limitRaw) {
    const limit = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(limit)) filters.limit = limit;
  }

  try {
    const rows = await listRegister(db, filters);
    if (searchParams.get('format') === 'csv') {
      return new NextResponse(toRegisterCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition':
            'attachment; filename="register-of-consents.csv"',
        },
      });
    }
    return NextResponse.json({ register: rows });
  } catch (err) {
    if (err instanceof ConsentServiceError) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.fields) body.fields = err.fields;
      return NextResponse.json(body, { status: err.status });
    }
    console.error('[api/consents/register] unexpected error', err);
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
