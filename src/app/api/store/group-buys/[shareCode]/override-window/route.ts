// POST /api/store/group-buys/[shareCode]/override-window - admin
// window override (PLAN-gh 3.6 / 5.5). canManageStore only, body
// allowlist is { windowHours } only, and the library enforces
// shorten-only on an open team. This is the fast path that lets the
// acceptance run expire a test team inside an hour.
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  GroupBuyError,
  overrideGroupBuyWindow,
  resolveGroupBuyByShareCode,
} from '@/lib/server/group-buys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shareCode: string }> },
) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const canManage = await hasServerPermissionForUser(db, uid, 'canManageStore');
  if (!canManage) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let windowHours: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    windowHours = body?.windowHours;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof windowHours !== 'number') {
    return NextResponse.json(
      { error: 'windowHours must be a number', code: 'INVALID_WINDOW' },
      { status: 422 },
    );
  }

  const { shareCode } = await params;
  const resolved = await resolveGroupBuyByShareCode(db, shareCode);
  if (!resolved) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const result = await overrideGroupBuyWindow(db, resolved.id, {
      adminUid: uid,
      windowHours,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof GroupBuyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.error('[group-buys] override-window failed', e);
    return NextResponse.json({ error: 'Could not override the team window' }, { status: 500 });
  }
}
