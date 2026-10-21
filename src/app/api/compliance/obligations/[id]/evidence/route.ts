/**
 * POST /api/compliance/obligations/[id]/evidence (phase2_spec.md G.7).
 *
 * Holder-only (resolved live). The evidence type is validated against
 * the template's proofTypes. Evidence is a legal move ONLY from
 * scheduled / reminded_* / due: an overdue instance NEVER re-enters
 * review through evidence - its only rescue is the cure path, after a
 * default notice (G.4). Submission advances evidence_submitted ->
 * under_review automatically; the review itself is a separate act by
 * the template's reviewer office.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, loadObligation } from '@/lib/server/compliance/access';
import { resolveObligationRecipients } from '@/lib/server/compliance/owner-resolution';
import { assertLegalTransition, IllegalTransitionError } from '@/lib/server/compliance/transitions';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import type { ObligationStatus } from '@/lib/compliance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const obligation = await loadObligation(db, id);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    const data = obligation.data;

    const resolved = await resolveObligationRecipients(
      data.officeRole as string,
      (data.chapterId as string | null) ?? null,
    );
    if (resolved.holderUid !== uid) return errorJson(403, 'FORBIDDEN');

    const body = (await req.json().catch(() => ({}))) as { type?: string; ref?: string; note?: string };
    const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
    if (!ref) return errorJson(400, 'EVIDENCE_REF_REQUIRED');

    const templateSnap = await db.collection('compliance_templates').doc(data.templateKey as string).get();
    const proofTypes: string[] = templateSnap.exists
      ? ((templateSnap.data()?.proofTypes as string[]) ?? [])
      : [];
    const type = typeof body.type === 'string' ? body.type : proofTypes[0];
    if (!type || (proofTypes.length > 0 && !proofTypes.includes(type))) {
      return errorJson(400, 'INVALID_EVIDENCE_TYPE', { proofTypes });
    }

    try {
      assertLegalTransition(data.status as ObligationStatus, 'evidence_submitted');
      assertLegalTransition('evidence_submitted', 'under_review');
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return errorJson(409, 'EVIDENCE_NOT_ACCEPTED_IN_STATE', {
          status: data.status,
          hint:
            data.status === 'overdue' || String(data.status).startsWith('default') || data.status === 'cure_period'
              ? 'This obligation is past its deadline. The route back is the cure on the default notice, not fresh evidence.'
              : undefined,
        });
      }
      throw err;
    }

    const now = new Date();
    await obligation.ref.update({
      status: 'under_review',
      evidence: {
        type,
        ref,
        submittedBy: uid,
        submittedAt: now,
        note: typeof body.note === 'string' ? body.note : null,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.evidence_submitted',
      subjectType: 'compliance_obligation',
      subjectId: id,
      details: { from: data.status, to: 'under_review', evidenceType: type },
    });
    return NextResponse.json({ ok: true, status: 'under_review' });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/obligations/evidence] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
