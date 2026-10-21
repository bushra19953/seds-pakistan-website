/**
 * POST /api/cadetships/[id]/evaluations (phase2_spec.md Section F.5).
 *
 * Dual evaluation with deterministic doc ids ('chapter_president',
 * 'team_lead') so double-submission is structurally impossible; a
 * resubmission overwrites the evaluator's own doc and stamps revisedAt,
 * permitted until a decision is recorded for the current round.
 *
 * Eligibility is resolved server-side from the authoritative role store:
 * the CP doc requires the caller to CURRENTLY hold chapter_president of
 * the cadetship's chapter; the team_lead doc requires the caller to be the
 * resolved team lead - or the CP under the collapse rule, in which case
 * the doc records singleEvaluatorReason 'no_team_lead' so the record says
 * the dual evaluation collapsed instead of pretending two people judged.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/cadetship/http';
import {
  dbOrThrow,
  getCallerRole,
  isChapterPresidentOf,
  loadCadetshipDoc,
  resolveTeamLeadUid,
} from '@/lib/server/cadetship/access';
import { cadetshipFromFirestore, evaluationFromFirestore } from '@/lib/server/cadetship/serialize';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import type { EvaluationRecommendation } from '@/lib/cadetship/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RECOMMENDATIONS: EvaluationRecommendation[] = ['confirm', 'extend', 'exit'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const loaded = await loadCadetshipDoc(db, id);
    if (!loaded) return errorJson(404, 'CADETSHIP_NOT_FOUND');
    const cadetship = cadetshipFromFirestore(id, loaded.raw);

    // Submissions close once the current round's decision is recorded:
    // round-1 decisions live on under_review records (outcome set), and a
    // confirmed/exited record is terminal. An 'extended' record is in
    // round 2, where revision remains open until the round-2 decision.
    if (cadetship.status === 'confirmed' || cadetship.status === 'exited' || cadetship.status === 'superseded') {
      return errorJson(409, 'DECISION_RECORDED');
    }
    if (cadetship.status === 'under_review' && cadetship.decision.outcome != null) {
      return errorJson(409, 'DECISION_RECORDED');
    }

    const body = (await req.json().catch(() => ({}))) as {
      evaluatorRole?: string;
      recommendation?: string;
      note?: string;
    };
    const evaluatorRole = body.evaluatorRole;
    if (evaluatorRole !== 'chapter_president' && evaluatorRole !== 'team_lead') {
      return errorJson(400, 'UNKNOWN_EVALUATOR_ROLE');
    }
    if (!RECOMMENDATIONS.includes(body.recommendation as EvaluationRecommendation)) {
      return errorJson(400, 'UNKNOWN_RECOMMENDATION');
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const minNote = body.recommendation === 'confirm' ? 1 : 40;
    if (note.length < minNote) {
      return errorJson(400, 'NOTE_TOO_SHORT', { minLength: minNote });
    }

    const caller = await getCallerRole(db, uid);
    let singleEvaluatorReason: 'no_team_lead' | null = null;

    if (evaluatorRole === 'chapter_president') {
      if (!isChapterPresidentOf(caller, cadetship.chapterId)) return errorJson(403, 'FORBIDDEN');
    } else {
      const leadUid = await resolveTeamLeadUid(db, cadetship);
      if (leadUid != null) {
        if (uid !== leadUid) return errorJson(403, 'FORBIDDEN');
      } else {
        // Collapse rule: no team lead exists, so the CP submits both docs
        // and this one SAYS so.
        if (!isChapterPresidentOf(caller, cadetship.chapterId)) return errorJson(403, 'FORBIDDEN');
        singleEvaluatorReason = 'no_team_lead';
      }
    }

    const evalRef = loaded.ref.collection('evaluations').doc(evaluatorRole);
    const existing = await evalRef.get();
    const now = new Date();
    const evaluation = {
      evaluatorUid: uid,
      evaluatorRoleKey: caller.roleKey ?? evaluatorRole,
      evaluatorChapterId: evaluatorRole === 'chapter_president' ? cadetship.chapterId : caller.chapterId,
      recommendation: body.recommendation,
      note,
      submittedAt: existing.exists ? (existing.data()?.submittedAt ?? now) : now,
      revisedAt: existing.exists ? now : null,
      singleEvaluatorReason,
    };
    await evalRef.set(evaluation);
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: existing.exists ? 'cadetship.evaluation_revised' : 'cadetship.evaluation_submitted',
      subjectType: 'cadetship',
      subjectId: id,
      details: {
        personUid: cadetship.personUid,
        evaluatorRole,
        recommendation: body.recommendation,
        singleEvaluatorReason,
      },
    });

    return NextResponse.json({ ok: true, evaluation: evaluationFromFirestore(evaluation as any) });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[cadetships/evaluations] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
