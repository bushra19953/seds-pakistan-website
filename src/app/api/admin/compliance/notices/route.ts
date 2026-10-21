/**
 * GET /api/admin/compliance/notices (phase2_spec.md G.7).
 * The notice register for governance officers: drafts awaiting issue,
 * issued notices with receipt states, cures awaiting review. Founder /
 * NGS / Audit Chair.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs, isAuditChair } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { noticeToJson } from '@/lib/server/compliance/serialize';
import { tsToDate } from '@/lib/server/compliance/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();
    const allowed = isFounderUid(uid) || (await isNgs(uid)) || (await isAuditChair(uid));
    if (!allowed) return errorJson(403, 'FORBIDDEN');

    const snap = await db.collection('default_notices').get();
    const rows = snap.docs
      .map((doc): Record<string, any> => ({ id: doc.id, ...(doc.data() as Record<string, any>) }))
      .sort(
        (a, b) =>
          (tsToDate(a.issuedAt)?.getTime() ?? tsToDate(a.createdAt)?.getTime() ?? 0) -
          (tsToDate(b.issuedAt)?.getTime() ?? tsToDate(b.createdAt)?.getTime() ?? 0),
      );
    return NextResponse.json({
      notices: rows.map((r) => noticeToJson(r.id, r)),
      drafts: rows.filter((r) => r.issuedAt == null).length,
      awaitingCureReview: rows.filter((r) => r.cure && !r.cureReview && r.outcome === 'open').length,
    });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/notices] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
