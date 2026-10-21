import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission, resolveUserRole } from '@/lib/server/permissions';
import { listAttendance, MeetingServiceError, recordAttendance } from '@/lib/server/governance/meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ meetingId: string }> };

async function requireAuth(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return { auth: null, error: NextResponse.json({ error: 'Unauthorized', error_code: 'unauthorized' }, { status: 401 }) };
  }
  return { auth, error: null };
}

function requireDb() {
  ensureAdminInitialized();
  const db = getDb();
  if (!db) return { db: null, error: NextResponse.json({ error: 'Firestore not initialized', error_code: 'db_unavailable' }, { status: 500 }) };
  return { db, error: null };
}

/** GET attendance list for a meeting. */
export async function GET(request: NextRequest, ctx: Ctx) {
  const { auth, error } = await requireAuth(request);
  if (error) return error;
  const { db, error: dbError } = requireDb();
  if (dbError) return dbError;
  const { meetingId } = await ctx.params;
  const attendance = await listAttendance(db, meetingId);
  return NextResponse.json({
    attendance: attendance.map((a) => ({
      ...a,
      checkedInAt: a.checkedInAt?.toISOString() ?? null,
      leftAt: a.leftAt?.toISOString() ?? null,
      updatedAt: a.updatedAt?.toISOString() ?? null,
    })),
  });
}

/**
 * POST check-in. Body { uid?, mode, displayName? }.
 * The actor may check in themselves; checking in someone else needs
 * canManageMeetings (same helper pattern as other /api routes).
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const { auth, error } = await requireAuth(request);
  if (error) return error;
  const actorUid = (auth!.user as { userId: string }).userId;
  const { db, error: dbError } = requireDb();
  if (dbError) return dbError;
  const { meetingId } = await ctx.params;
  try {
    const body = await request.json();
    const targetUid = typeof body?.uid === 'string' && body.uid ? body.uid : actorUid;
    const mode = body?.mode;
    if (mode !== 'in_person' && mode !== 'electronic' && mode !== 'absent') {
      return NextResponse.json({ error: 'mode must be in_person, electronic or absent', error_code: 'validation_failed' }, { status: 400 });
    }
    if (targetUid !== actorUid) {
      const role = await resolveUserRole(getDb()!, actorUid);
      if (!(await hasServerPermission(role, 'canManageMeetings'))) {
        return NextResponse.json({ error: 'Permission denied', error_code: 'permission_denied' }, { status: 403 });
      }
    }
    const record = await recordAttendance(db, {
      meetingId,
      uid: targetUid,
      mode,
      actorUid,
      displayName: typeof body?.displayName === 'string' ? body.displayName : undefined,
    });
    return NextResponse.json(
      {
        attendance: {
          ...record,
          checkedInAt: record.checkedInAt?.toISOString() ?? null,
          leftAt: null,
          updatedAt: record.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof MeetingServiceError) {
      return NextResponse.json({ error: e.message, error_code: e.error_code }, { status: e.status });
    }
    console.error('[governance/attendance POST]', e);
    return NextResponse.json({ error: 'Internal error', error_code: 'internal' }, { status: 500 });
  }
}
