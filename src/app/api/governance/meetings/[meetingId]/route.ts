import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  cancelMeeting,
  getMeeting,
  MeetingServiceError,
  type Meeting,
} from '@/lib/server/governance/meetings';

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

async function requirePermission(uid: string, key: 'canManageMeetings' | 'canViewGovernance') {
  return hasServerPermissionForUser(getDb()!, uid, key);
}

function serialize(m: Meeting) {
  return {
    ...m,
    scheduledAt: m.scheduledAt?.toISOString() ?? null,
    noticeSentAt: m.noticeSentAt?.toISOString() ?? null,
    deemedReceivedAt: m.deemedReceivedAt?.toISOString() ?? null,
    quorumVerifiedAt: m.quorumVerifiedAt?.toISOString() ?? null,
    createdAt: m.createdAt?.toISOString() ?? null,
    updatedAt: m.updatedAt?.toISOString() ?? null,
  };
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const { auth, error } = await requireAuth(request);
  if (error) return error;
  const uid = (auth!.user as { userId: string }).userId;
  if (!(await requirePermission(uid, 'canViewGovernance')) && !(await requirePermission(uid, 'canManageMeetings'))) {
    return NextResponse.json({ error: 'Permission denied', error_code: 'permission_denied' }, { status: 403 });
  }
  const { db, error: dbError } = requireDb();
  if (dbError) return dbError;
  const { meetingId } = await ctx.params;
  const meeting = await getMeeting(db, meetingId);
  if (!meeting) return NextResponse.json({ error: 'Meeting not found', error_code: 'meeting_not_found' }, { status: 404 });
  return NextResponse.json({ meeting: serialize(meeting) });
}

/** PATCH: reschedule / edit fields, or cancel when cancelReason is supplied. */
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const { auth, error } = await requireAuth(request);
  if (error) return error;
  const uid = (auth!.user as { userId: string }).userId;
  if (!(await requirePermission(uid, 'canManageMeetings'))) {
    return NextResponse.json({ error: 'Permission denied', error_code: 'permission_denied' }, { status: 403 });
  }
  const { db, error: dbError } = requireDb();
  if (dbError) return dbError;
  const { meetingId } = await ctx.params;
  try {
    const body = await request.json();
    if (typeof body?.cancelReason === 'string' && body.cancelReason.trim()) {
      await cancelMeeting(db, { meetingId, actorUid: uid, cancelReason: body.cancelReason });
      return NextResponse.json({ meetingId, status: 'cancelled' });
    }
    const meeting = await getMeeting(db, meetingId);
    if (!meeting) return NextResponse.json({ error: 'Meeting not found', error_code: 'meeting_not_found' }, { status: 404 });
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body?.title === 'string') patch.title = body.title;
    if (body?.scheduledAt) {
      const d = new Date(body.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'scheduledAt must be a valid date', error_code: 'validation_failed' }, { status: 400 });
      }
      patch.scheduledAt = d;
    }
    if (typeof body?.durationMinutes === 'number') patch.durationMinutes = body.durationMinutes;
    if ('location' in body) patch.location = body.location ?? null;
    if ('meetingLink' in body) patch.meetingLink = body.meetingLink ?? null;
    await db.collection('meetings').doc(meetingId).update(patch);
    const updated = await getMeeting(db, meetingId);
    return NextResponse.json({ meeting: updated ? serialize(updated) : null });
  } catch (e) {
    if (e instanceof MeetingServiceError) {
      return NextResponse.json({ error: e.message, error_code: e.error_code }, { status: e.status });
    }
    console.error('[governance/meetings PATCH]', e);
    return NextResponse.json({ error: 'Internal error', error_code: 'internal' }, { status: 500 });
  }
}
