/**
 * GET /api/admin/compliance/obligations (phase2_spec.md G.7).
 * Governance-officer list with filters (status, office, chapter, period,
 * overdueOnly) and cursor pagination (limit + startAfter doc id).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs, isAuditChair } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { userHoldsRole } from '@/lib/server/role-holders';
import { obligationToJson } from '@/lib/server/compliance/serialize';
import { tsToDate } from '@/lib/server/compliance/cron';
import { PRESIDENT_ROLE_KEY } from '@/lib/server/compliance/access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();
    const allowed =
      isFounderUid(uid) ||
      (await isNgs(uid)) ||
      (await isAuditChair(uid)) ||
      (await userHoldsRole(uid, PRESIDENT_ROLE_KEY)) ||
      (await userHoldsRole(uid, 'superadmin'));
    if (!allowed) return errorJson(403, 'FORBIDDEN');

    const params = req.nextUrl.searchParams;
    const status = params.get('status');
    const office = params.get('office');
    const chapter = params.get('chapter');
    const period = params.get('period');
    const overdueOnly = params.get('overdueOnly') === 'true';
    const limit = Math.min(Math.max(parseInt(params.get('limit') ?? '50', 10) || 50, 1), 200);
    const cursor = params.get('cursor');

    const snap = await db.collection('compliance_obligations').get();
    let rows = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, any>) }));
    if (status) rows = rows.filter((r) => r.status === status);
    if (office) rows = rows.filter((r) => r.officeRole === office);
    if (chapter) rows = rows.filter((r) => (r.chapterId ?? null) === chapter);
    if (period) rows = rows.filter((r) => r.periodKey === period);
    if (overdueOnly) rows = rows.filter((r) => r.status === 'overdue');
    rows.sort((a, b) => (tsToDate(a.dueDate)?.getTime() ?? 0) - (tsToDate(b.dueDate)?.getTime() ?? 0));

    let startIndex = 0;
    if (cursor) {
      const idx = rows.findIndex((r) => r.id === cursor);
      if (idx >= 0) startIndex = idx + 1;
    }
    const page = rows.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < rows.length ? page[page.length - 1].id : null;
    return NextResponse.json({
      obligations: page.map((r) => obligationToJson(r.id, r)),
      nextCursor,
      total: rows.length,
    });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/obligations] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
