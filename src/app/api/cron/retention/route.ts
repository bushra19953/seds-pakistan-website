import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';
import {
  resolveBackupFolderId,
  serializeFirestoreValue,
} from '@/lib/backup/engine';
import { uploadToVault } from '@/lib/drive/client';
import { runRetention, type RetentionDeps } from '@/lib/retention/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/retention
 *
 * Retention job (Workstream F): applies retention_policies - archives
 * expired records into the private "SEDS Backups" Drive folder BEFORE
 * any scrub or delete, scrubs rejected-application PII at 24 months
 * (F-G2), deletes audit logs at 10 years only after archiving (F-G3),
 * and never touches governance classes (flag-for-review only).
 * Authorization mirrors /api/cron/backup: Bearer CRON_SECRET, or an
 * admin holding canManagePermissions for a manual run.
 */
async function handleRetention(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const cronSecret = process.env.CRON_SECRET;
    const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
    if (!isCron) {
      const auth = await verifyAuthentication(req);
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
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 },
      );
    }

    const deps: RetentionDeps = {
      db: db as unknown as RetentionDeps['db'],
      archiveDocs: async (collection, docs) => {
        const folderId = await resolveBackupFolderId();
        const payload = {
          collection,
          exportedAt: new Date().toISOString(),
          count: docs.length,
          docs: docs.map((d) => ({
            id: d.id,
            data: serializeFirestoreValue(d.data),
          })),
        };
        const buffer = Buffer.from(
          JSON.stringify(payload, null, 2),
          'utf8',
        );
        await uploadToVault(
          `retention_${collection}_${new Date().toISOString().slice(0, 10)}.json`,
          'application/json',
          buffer,
          folderId,
          { makePublic: false },
        );
      },
      now: () => new Date(),
    };

    const report = await runRetention(deps);
    await db.collection('audit_logs').add({
      type: 'RETENTION_RUN',
      actorId: isCron ? 'cron' : 'admin',
      targetId: null,
      data: {
        startedAt: report.startedAt,
        classes: report.classes.map((c) => ({
          key: c.key,
          archived: c.archived,
          scrubbed: c.scrubbed,
          deleted: c.deleted,
          flaggedForReview: c.flaggedForReview,
          errors: c.errors,
        })),
      },
      timestamp: new Date(),
    });

    return NextResponse.json({
      startedAt: report.startedAt,
      classes: report.classes,
    });
  } catch (error: any) {
    console.error('[cron/retention] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to run retention' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handleRetention(req);
}

export async function POST(req: NextRequest) {
  return handleRetention(req);
}
