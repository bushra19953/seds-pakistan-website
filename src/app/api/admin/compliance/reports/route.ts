/**
 * GET /api/admin/compliance/reports (phase2_spec.md G.7/G.10).
 * The compliance_reports register: quarter, revision, generated-by,
 * Drive link, delivery count. Founder / NGS / Audit Chair / President.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs, isAuditChair, PRESIDENT_ROLE_KEY } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { userHoldsRole } from '@/lib/server/role-holders';
import { datesToIso } from '@/lib/server/compliance/serialize';

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
      (await userHoldsRole(uid, PRESIDENT_ROLE_KEY));
    if (!allowed) return errorJson(403, 'FORBIDDEN');

    const snap = await db.collection('compliance_reports').get();
    const reports = snap.docs
      .map((doc) => ({ id: doc.id, ...(datesToIso(doc.data()) as Record<string, unknown>) }))
      .sort((a, b) => String(b.id).localeCompare(String(a.id)));
    return NextResponse.json({ reports });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/reports] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
