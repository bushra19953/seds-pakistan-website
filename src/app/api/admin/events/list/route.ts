import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { listAllEventsFromSupa } from '@/lib/supa-events/admin-events';
import { toPublicJson } from '@/lib/supa-events/public-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/events/list (E5 admin-events seam, surface
 * 'events-admin').
 *
 * The server endpoint the admin CRM page's associated-events read
 * calls when the client 'events-admin' hint is ON. It serves ONLY
 * from fs_events via the seam: flag off, Supabase unconfigured, or
 * any adapter error => 503, and the client falls back to its bounded
 * Firestore fetch. This route is NOT a new Firestore list API.
 *
 * Auth + canManageSponsorsPartners are enforced exactly as on the
 * sibling partners list route (the CRM page is the consumer), before
 * the seam check's response shape can leak anything (401/403 first,
 * 503 after).
 *
 * Response: a plain JSON array of normalized event docs (id +
 * fields), newest first, timestamps serialized to ISO-8601 strings
 * (toPublicJson) — the same wire shape as GET /api/events/public.
 * The adapter keyset-pages internally, so the array is the whole
 * collection, never truncated.
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

  const events = await listAllEventsFromSupa();
  if (!events) {
    return NextResponse.json({ error: 'events supa unavailable' }, { status: 503 });
  }
  return NextResponse.json(toPublicJson(events));
}
