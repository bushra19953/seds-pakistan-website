import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

/**
 * POST /api/users/vote — WS10 route for the two client vote
 * transactions (profile/unified page + community leaderboard),
 * previously direct-SDK runTransaction on
 * users/{target}/votes/{voter} + an increment on the target doc.
 *
 * The transaction moves server-side with identical semantics:
 * an existing vote doc aborts with 409 { error: 'already_voted' }
 * (both callers key their already-voted handling off that string);
 * otherwise the vote doc is set ({ type, voterUid, createdAt,
 * targetUserName when the leaderboard sends it }) and the target's
 * upvotes/downvotes increments by 1, atomically.
 *
 * Parity notes: the client transactions bypassed firestore-wrapper
 * (direct SDK), so NO webhook dispatch ever fired for a vote — the
 * replica's handleUserWritten (points/badges/leaderboard-cache arms)
 * never ran for the upvotes/downvotes change, and this route
 * deliberately adds no such effect. The votes subcollection has no
 * fs_* table (identity H-07): no mirror exists to write.
 * Gate: any verified session; the voter is the token UID.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  const voterUid = auth.user.userId;

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const targetUid = typeof body.targetUid === 'string' ? body.targetUid : '';
  const type = body.type === 'down' ? 'down' : body.type === 'up' ? 'up' : '';
  if (!targetUid || !type) {
    return NextResponse.json({ error: 'targetUid and type are required' }, { status: 400 });
  }

  const targetRef = db.collection('users').doc(targetUid);
  const voteRef = targetRef.collection('votes').doc(voterUid);

  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(voteRef);
      if (existing.exists) {
        throw new Error('already_voted');
      }
      tx.set(voteRef, {
        type,
        voterUid,
        createdAt: FieldValue.serverTimestamp(),
        ...(typeof body.targetUserName === 'string' && body.targetUserName
          ? { targetUserName: body.targetUserName }
          : {}),
      });
      tx.update(targetRef, {
        [type === 'up' ? 'upvotes' : 'downvotes']: FieldValue.increment(1),
      });
    });
  } catch (err: any) {
    if (err?.message === 'already_voted') {
      return NextResponse.json({ error: 'already_voted' }, { status: 409 });
    }
    console.error('[api/users/vote] transaction failed:', err);
    return NextResponse.json({ error: 'Vote failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
