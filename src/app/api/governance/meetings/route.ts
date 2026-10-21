import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission, resolveUserRole } from '@/lib/server/permissions';
import {
  createMeeting,
  listMeetings,
  MeetingServiceError,
  type Meeting,
} from '@/lib/server/governance/meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
  const role = await resolveUserRole(getDb()!, uid);
  return hasServerPermission(role, key);
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

function serviceErrorResponse(e: unknown) {
  if (e instanceof MeetingServiceError) {
    return NextResponse.json(
      { error: e.message, error_code: e.error_code, earliestAllowed: e.earliestAllowed?.toISOString() ?? null },
      { status: e.status },
    );
  }
  return null;
}

/** GET /api/governance/meetings — list, gated on canViewGovernance. */
export async function GET(request: NextRequest) {
  const { auth, error } = await requireAuth(request);
  if (error) return error;
  const uid = (auth!.user as { userId: string }).userId;
  if (!(await requirePermission(uid, 'canViewGovernance')) && !(await requirePermission(uid, 'canManageMeetings'))) {
    return NextResponse.json({ error: 'Permission denied', error_code: 'permission_denied' }, { status: 403 });
  }
  const { db, error: dbError } = requireDb();
  if (dbError) return dbError;
  const bodyId = request.nextUrl.searchParams.get('bodyId') ?? undefined;
  const status = (request.nextUrl.searchParams.get('status') ?? undefined) as Meeting['status'] | undefined;
  const meetings = await listMeetings(db, { bodyId, status });
  return NextResponse.json({ meetings: meetings.map(serialize) });
}

/** POST /api/governance/meetings — create, gated on canManageMeetings. */
export async function POST(request: NextRequest) {
  const { auth, error } = await requireAuth(request);
  if (error) return error;
  const uid = (auth!.user as { userId: string }).userId;
  if (!(await requirePermission(uid, 'canManageMeetings'))) {
    return NextResponse.json({ error: 'Permission denied', error_code: 'permission_denied' }, { status: 403 });
  }
  const { db, error: dbError } = requireDb();
  if (dbError) return dbError;
  try {
    const body = await request.json();
    if (!body?.bodyId || !body?.type || !body?.title || !body?.scheduledAt) {
      return NextResponse.json({ error: 'bodyId, type, title and scheduledAt are required', error_code: 'validation_failed' }, { status: 400 });
    }
    const scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return NextResponse.json({ error: 'scheduledAt must be a valid date', error_code: 'validation_failed' }, { status: 400 });
    }
    const result = await createMeeting(db, {
      bodyId: body.bodyId,
      type: body.type,
      title: body.title,
      scheduledAt,
      durationMinutes: Number(body.durationMinutes ?? 60),
      location: body.location ?? null,
      meetingLink: body.meetingLink ?? null,
      consentId: body.consentId ?? null,
      consentState: body.consentState ?? null,
      agenda: Array.isArray(body.agenda) ? body.agenda : [],
      actorUid: uid,
    });
    return NextResponse.json(
      { meetingId: result.meetingId, status: result.status, quorumRequired: result.quorumRequired, warnings: result.warnings },
      { status: 201 },
    );
  } catch (e) {
    const mapped = serviceErrorResponse(e);
    if (mapped) return mapped;
    console.error('[governance/meetings POST]', e);
    return NextResponse.json({ error: 'Internal error', error_code: 'internal' }, { status: 500 });
  }
}
