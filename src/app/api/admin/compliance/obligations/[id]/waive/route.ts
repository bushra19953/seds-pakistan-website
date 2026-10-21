/**
 * POST /api/admin/compliance/obligations/[id]/waive (phase2_spec.md G.6).
 *
 * Founder ONLY, and the ONLY waiver path in the system: the Audit Chair,
 * the NGS, and the engine have no waiver power, and no waive affordance
 * exists on their surfaces. A waiver requires a recorded instrument - a
 * Founder Act or a Board resolution - with a non-empty instrumentRef.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, loadObligation } from '@/lib/server/compliance/access';
import { assertLegalTransition, isNonTerminal } from '@/lib/server/compliance/transitions';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { isFounderUid } from '@/lib/server/founder-gate';
import type { ObligationStatus } from '@/lib/compliance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    if (!isFounderUid(uid)) return errorJson(403, 'FORBIDDEN');

    const body = (await req.json().catch(() => ({}))) as {
      instrumentType?: string;
      instrumentRef?: string;
      note?: string;
    };
    if (body.instrumentType !== 'founder_act' && body.instrumentType !== 'board_resolution') {
      return errorJson(400, 'INSTRUMENT_TYPE_REQUIRED');
    }
    const instrumentRef = typeof body.instrumentRef === 'string' ? body.instrumentRef.trim() : '';
    if (!instrumentRef) return errorJson(400, 'INSTRUMENT_REF_REQUIRED');

    const obligation = await loadObligation(db, id);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    const status = obligation.data.status as ObligationStatus;
    if (!isNonTerminal(status)) return errorJson(409, 'ALREADY_TERMINAL');
    assertLegalTransition(status, 'waived');

    const now = new Date();
    await obligation.ref.update({
      status: 'waived',
      waiver: {
        instrumentType: body.instrumentType,
        instrumentRef,
        waivedBy: uid,
        waivedAt: now,
        note: typeof body.note === 'string' ? body.note : null,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.waived',
      subjectType: 'compliance_obligation',
      subjectId: id,
      details: { instrumentType: body.instrumentType, instrumentRef, from: status },
    });
    return NextResponse.json({ ok: true, status: 'waived' });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/obligations/waive] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
