import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  crmSupaEnabled,
  supaListAllPartners,
  supaListPartnersByStatus,
  supaListPartnersPage,
} from '@/lib/server/crm-supa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/partners/list (Cluster F, merge plan step 7).
 *
 * The server endpoint the CRM client surfaces (admin CRM list B2 and
 * the sponsor-match panel P14) poll when the client 'crm' hint is ON.
 * This route is NOT a new Firestore list API: it serves ONLY when the
 * server 'crm' surface is ON and Supabase is configured. Flag OFF,
 * unconfigured, or any adapter error => 503, and the client falls back
 * to its Firestore read byte-identically (the public-events route
 * pattern). Auth + canManageSponsorsPartners are enforced exactly as on
 * the sibling partners routes, before the flag check's response shape
 * can leak anything (401/403 first, 503 after).
 *
 * Query params:
 *   status  optional exact status filter ('All' = no filter)
 *   limit   optional page size; absent = the WHOLE collection
 *           (adapter keyset-paged internally, never truncated)
 *   cursor  optional updatedAt-millis startAfter bound (with limit)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const callerUid = String((auth.user as { userId?: unknown }).userId || '');
  const db = getDb();
  if (!(await hasServerPermissionForUser(db as never, callerUid, 'canManageSponsorsPartners'))) {
    return NextResponse.json(
      { error: 'Forbidden: sponsor/partner management permission required' },
      { status: 403 },
    );
  }

  if (!crmSupaEnabled()) {
    return NextResponse.json({ error: 'crm supa surface off' }, { status: 503 });
  }

  const params = new URL(request.url).searchParams;
  const statusParam = params.get('status');
  const status = statusParam && statusParam !== 'All' ? statusParam : null;
  const limitRaw = params.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  const cursorRaw = params.get('cursor');
  const cursor = cursorRaw ? Number.parseInt(cursorRaw, 10) : NaN;

  if (Number.isFinite(limit) && limit > 0) {
    const page = await supaListPartnersPage({
      limit,
      cursor: Number.isFinite(cursor) ? cursor : null,
      status,
    });
    if (!page) {
      return NextResponse.json({ error: 'crm supa read failed' }, { status: 503 });
    }
    return NextResponse.json({ partners: page.partners, nextCursor: page.nextCursor });
  }

  const partners = status
    ? await supaListPartnersByStatus(status)
    : await supaListAllPartners();
  if (!partners) {
    return NextResponse.json({ error: 'crm supa read failed' }, { status: 503 });
  }
  return NextResponse.json({ partners, nextCursor: null });
}
