import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET: recent backup_runs records for the admin backup page
// (Workstream F). Replaces the old page's client-side pseudo-backup.
export async function GET(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user?.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const allowed = await hasServerPermission(
    auth.user.role,
    'canManagePermissions',
  );
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not initialized' },
      { status: 500 },
    );
  }
  const snap = await db
    .collection('backup_runs')
    .orderBy('startedAt', 'desc')
    .limit(20)
    .get();
  const runs = snap.docs.map((d) => ({ runId: d.id, ...d.data() }));
  return NextResponse.json({ runs });
}
