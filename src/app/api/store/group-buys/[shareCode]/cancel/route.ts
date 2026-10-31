// POST /api/store/group-buys/[shareCode]/cancel - opener cancel
// (PLAN-gh 3.5). Only the opener, only while sole seated member (or
// none seated), only while open. Guards are re-checked inside the
// cancel transaction in the library.
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import {
  GroupBuyError,
  cancelGroupBuyTeam,
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

  const { shareCode } = await params;
  const resolved = await resolveGroupBuyByShareCode(db, shareCode);
  if (!resolved) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const result = await cancelGroupBuyTeam(db, resolved.id, { userId: uid });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof GroupBuyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.error('[group-buys] cancel failed', e);
    return NextResponse.json({ error: 'Could not cancel the team' }, { status: 500 });
  }
}
