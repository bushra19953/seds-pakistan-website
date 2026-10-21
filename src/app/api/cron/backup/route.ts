import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { createDefaultBackupDeps, runBackup } from '@/lib/backup/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/backup
 *
 * Scheduled server-side backup (Workstream F): exports every collection
 * in the backup registry to the private "SEDS Backups" Drive folder as
 * JSON plus a manifest, and writes a backup_runs run record.
 *
 * Authorization follows the /api/cron/clear-probation convention: Vercel
 * Cron supplies Authorization: Bearer <CRON_SECRET>; an authenticated
 * admin (canManagePermissions, the permission that gated the old manual
 * backup page) may also trigger it manually.
 *
 * Idempotency: each run gets a unique runId, collection files are named
 * with that runId, and the run record is written with set() semantics,
 * so a duplicate invocation creates a second complete run record rather
 * than corrupting the first.
 */
async function handleBackup(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const cronSecret = process.env.CRON_SECRET;
    const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
    if (!isCron) {
      const auth = await verifyAuthentication(req);
      if (!auth.authenticated || !auth.user?.role) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const allowed = await hasServerPermission(auth.user.role, 'canManagePermissions');
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const deps = createDefaultBackupDeps();
    const result = await runBackup(deps);

    return NextResponse.json({
      runId: result.runId,
      status: result.status,
      collections: result.totals.collections,
      documents: result.totals.documents,
    });
  } catch (error: any) {
    console.error('[cron/backup] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to run backup' },
      { status: 500 },
    );
  }
}

// Vercel Cron Jobs invoke the path with GET.
export async function GET(req: NextRequest) {
  return handleBackup(req);
}

// Manual / admin-triggered invocation.
export async function POST(req: NextRequest) {
  return handleBackup(req);
}
