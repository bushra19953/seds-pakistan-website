/**
 * GET /api/admin/compliance/templates (phase2_spec.md G.7).
 * Founder/NGS list of the whole catalog. Corrections happen through the
 * per-template PATCH (the ONLY correction path) - there is deliberately
 * no DELETE anywhere in this surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { datesToIso } from '@/lib/server/compliance/serialize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();
    if (!isFounderUid(uid) && !(await isNgs(uid))) return errorJson(403, 'FORBIDDEN');
    const snap = await db.collection('compliance_templates').get();
    const templates = snap.docs
      .map((doc) => ({ id: doc.id, ...(datesToIso(doc.data()) as Record<string, unknown>) }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return NextResponse.json({ templates });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/templates] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
