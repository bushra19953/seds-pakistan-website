/**
 * GET /api/cadetships/[id] (phase2_spec.md Sections F.7, F.8).
 *
 * Readers: the cadet themself, chapter officers of the cadetship's
 * chapter, the NMD, the Founder, the NGS and the Audit Chair (read-only
 * oversight). The cadet sees their own evaluations ONLY after the record
 * reaches a decided state (confirmed / extended / exited); during review
 * the evaluations stay officer-side, while the decision block (with its
 * member-facing memberNote, never the internal note) is always theirs.
 * Status is the read-time derived effective status (F.3).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/cadetship/http';
import { dbOrThrow, getCallerRole, canReadCadetship, loadCadetshipDoc } from '@/lib/server/cadetship/access';
import { cadetshipFromFirestore, cadetshipToJson, evaluationFromFirestore } from '@/lib/server/cadetship/serialize';
import { cadetshipEffectiveStatus, checklistComplete, checklistDoneCount } from '@/lib/cadetship/checklist';
import { cadetshipWeek } from '@/lib/server/cadetship/clock';
import { isFounderUid } from '@/lib/server/founder-gate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUBJECT_EVALUATION_VISIBLE = ['confirmed', 'extended', 'exited'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const loaded = await loadCadetshipDoc(db, id);
    if (!loaded) return errorJson(404, 'CADETSHIP_NOT_FOUND');
    const doc = cadetshipFromFirestore(id, loaded.raw);

    const caller = await getCallerRole(db, uid);
    if (!canReadCadetship(uid, caller, doc)) return errorJson(403, 'FORBIDDEN');

    const now = new Date();
    const eff = cadetshipEffectiveStatus(doc, now);

    const isSubjectOnly =
      uid === doc.personUid &&
      !isFounderUid(uid) &&
      caller.roleKey == null;
    const evalSnap = await loaded.ref.collection('evaluations').get();
    const evaluations = isSubjectOnly && !SUBJECT_EVALUATION_VISIBLE.includes(doc.status)
      ? []
      : evalSnap.docs.map((d) => {
          const e = evaluationFromFirestore(d.data() as Record<string, any>);
          return {
            evaluatorRole: d.id,
            ...e,
            submittedAt: e.submittedAt.toISOString(),
            revisedAt: e.revisedAt ? e.revisedAt.toISOString() : null,
          };
        });

    return NextResponse.json({
      cadetship: {
        ...cadetshipToJson(doc),
        effectiveStatus: eff.status,
        reviewDue: eff.reviewDue,
        week: cadetshipWeek(doc.startedAt, now),
      },
      checklist: { complete: checklistComplete(doc), doneCount: checklistDoneCount(doc) },
      evaluations,
    });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[cadetships/get] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
