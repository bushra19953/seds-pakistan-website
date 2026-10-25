import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  adminAnalyticsSupaEnabled,
  getAdminAnalyticsSupaAdapter,
  getAnalyticsSupa,
} from '@/lib/server/admin-analytics-supa';

export const dynamic = 'force-dynamic';

/**
 * GET: admin analytics view model served from Supabase.
 *
 * This is a NEW route — no pre-existing server route exists for the
 * analytics page (it read Firestore client-side), so there is nothing
 * to fall back to here: when the 'admin-analytics' Supa surface is OFF
 * (or the adapter is unavailable) the route 404s, and the page only
 * calls it when its client flag (NEXT_PUBLIC_SUPA_SURFACES) is on.
 *
 * Admin-auth posture mirrors the existing /api/admin routes:
 * verifyAuthentication -> 401, canViewAnalytics (the permission the
 * analytics page itself gates on) -> 403.
 */
export async function GET(request: NextRequest) {
  if (!adminAnalyticsSupaEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const adapter = getAdminAnalyticsSupaAdapter();
  if (!adapter) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const canView = await hasServerPermissionForUser(
      getDb()!,
      auth.user.userId,
      'canViewAnalytics',
    );
    if (!canView) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions to view analytics' },
        { status: 403 },
      );
    }

    const viewModel = await getAnalyticsSupa(adapter, { nowMs: Date.now() });
    return NextResponse.json(viewModel);
  } catch (error) {
    console.error('[admin/analytics] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 });
  }
}
