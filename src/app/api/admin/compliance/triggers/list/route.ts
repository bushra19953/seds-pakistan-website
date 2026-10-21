/**
 * GET /api/admin/compliance/triggers/list (phase2_spec.md G.7/G.8).
 * The trigger log (the POST recorder lives at /api/admin/compliance/
 * triggers). Founder / NGS / Audit Chair.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs, isAuditChair } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { datesToIso } from '@/lib/server/compliance/serialize';
import { tsToDate } from '@/lib/server/compliance/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();
    const allowed = isFounderUid(uid) || (await isNgs(uid)) || (await isAuditChair(uid));
    if (!allowed) return errorJson(403, 'FORBIDDEN');

    const snap = await db.collection('compliance_triggers').get();
    const rows = snap.docs
      .map((doc) => ({ id: doc.id, ...(datesToIso(doc.data()) as Record<string, unknown>), _at: tsToDate(doc.data().recordedAt)?.getTime() ?? 0 }))
      .sort((a, b) => b._at - a._at)
      .map(({ _at: _dropped, ...rest }) => rest);
    return NextResponse.json({ triggers: rows });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/triggers/list] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
