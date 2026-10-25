import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { PermissionKey } from '@/config/permissions.config';
import {
  adminAuditSupaEnabled,
  getAdminAuditAdapter,
  getAuditTotalsSupa,
  listSuperadminRecentSupa,
  listAuditPageSupa,
  listAuditActionsSupa,
} from '@/lib/server/admin-audit-supa';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Supa-backed audit reads for the ADMIN AUDIT surface group.
 *
 * This route exists ONLY on the Supa path: there is no pre-existing
 * server route for audit logs (the pages read Firestore directly), so
 * when useSupa('admin-audit') is OFF — or the adapter is unavailable —
 * it responds 404 and the pages keep their Firestore code path
 * byte-untouched. The client only calls it when its own
 * NEXT_PUBLIC_SUPA_SURFACES flag includes 'admin-audit'.
 *
 * Modes (GET ?mode=):
 *   page (default)  contract merged-stream page: ?actor&action&cursor&pageSize
 *   actions         sorted unique actions (latest 200 per collection)
 *   totals          { totalUsers, totalAuditLogs } (audit_logs ONLY)
 *   recent          superadmin recent activity: first 50 audit_logs rows
 *
 * Auth posture mirrors the other /api/admin routes (e.g.
 * retention-policies): verifyAuthentication + a server permission check
 * (canViewAuditLogs, or canManagePermissions for the superadmin totals).
 */
async function authorize(request: NextRequest, permission: PermissionKey) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user?.role) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const db = getDb();
  if (!db) {
    return {
      error: NextResponse.json({ error: 'Database not initialized' }, { status: 500 }),
    };
  }
  const allowed = await hasServerPermissionForUser(db, auth.user.userId, permission);
  if (!allowed) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { uid: auth.user.userId };
}

export async function GET(request: NextRequest) {
  // Flag OFF (or adapter unavailable): no route. The pages only call
  // this when their client flag is on, so a 404 here is never user-facing
  // on the Firestore path.
  if (!adminAuditSupaEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const adapter = getAdminAuditAdapter();
  if (!adapter) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const params = request.nextUrl.searchParams;
  const mode = params.get('mode') || 'page';

  const gate = await authorize(
    request,
    mode === 'totals' || mode === 'recent' ? 'canManagePermissions' : 'canViewAuditLogs',
  );
  if (gate.error) return gate.error;

  try {
    if (mode === 'totals') {
      return NextResponse.json(await getAuditTotalsSupa(adapter));
    }
    if (mode === 'recent') {
      return NextResponse.json({ logs: await listSuperadminRecentSupa(adapter) });
    }
    if (mode === 'actions') {
      return NextResponse.json({ actions: await listAuditActionsSupa(adapter) });
    }
    const pageSizeRaw = Number(params.get('pageSize'));
    const page = await listAuditPageSupa(adapter, {
      actor: params.get('actor') || undefined,
      action: params.get('action') || undefined,
      cursor: params.get('cursor') || null,
      pageSize:
        Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined,
    });
    return NextResponse.json({
      logs: page.entries,
      total: page.total,
      nextCursor: page.nextCursor,
    });
  } catch (err) {
    console.error('[admin/audit-logs] Supa read failed:', err);
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
