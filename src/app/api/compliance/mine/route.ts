/**
 * GET /api/compliance/mine (phase2_spec.md G.7).
 *
 * The instances of every office the CALLER holds (role resolved from the
 * authoritative role store), all states, due-sorted. Chapter offices are
 * scoped to the caller's chapter. An empty list is a normal answer (the
 * profile nav entry hides itself in that case).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, callerRoleKey } from '@/lib/server/compliance/access';
import { obligationToJson } from '@/lib/server/compliance/serialize';
import { tsToDate } from '@/lib/server/compliance/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();
    const roleKey = await callerRoleKey(uid);
    if (!roleKey) return NextResponse.json({ obligations: [], officeRole: null });

    const roleSnap = await db.collection('roles').doc(uid).get();
    const callerChapterId = (roleSnap.data()?.chapterId as string | undefined) ?? null;

    const snap = await db
      .collection('compliance_obligations')
      .where('officeRole', '==', roleKey)
      .get();
    const rows = snap.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, any>) }))
      .filter((o) => !o.officeRole.startsWith('chapter_') || (o.chapterId ?? null) === callerChapterId)
      .sort((a, b) => (tsToDate(a.dueDate)?.getTime() ?? 0) - (tsToDate(b.dueDate)?.getTime() ?? 0))
      .map((o) => obligationToJson(o.id, o));
    return NextResponse.json({ obligations: rows, officeRole: roleKey });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/mine] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
