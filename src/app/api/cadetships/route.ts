/**
 * GET /api/cadetships (phase2_spec.md Section F.8 list surface).
 *
 * Filters: chapterId, cohortId, status (matched against the DERIVED
 * effective status, so 'under_review' and reviewDue work without waiting
 * for the cron), reviewDue=true.
 *
 * Scoping: national oversight callers (NMD, Founder, NGS, Audit Chair) see
 * everything the filters select; a chapter officer sees ONLY their own
 * chapter (a chapterId filter for another chapter selects nothing); a
 * caller with no office sees only their own record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/cadetship/http';
import { dbOrThrow, getCallerRole, NMD_ROLE, NGS_ROLE, AUDIT_CHAIR_ROLE } from '@/lib/server/cadetship/access';
import { cadetshipFromFirestore, cadetshipToJson } from '@/lib/server/cadetship/serialize';
import { cadetshipEffectiveStatus, checklistDoneCount } from '@/lib/cadetship/checklist';
import { cadetshipWeek } from '@/lib/server/cadetship/clock';
import { isFounderUid } from '@/lib/server/founder-gate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();
    const caller = await getCallerRole(db, uid);

    const url = new URL(req.url);
    const chapterFilter = url.searchParams.get('chapterId');
    const cohortFilter = url.searchParams.get('cohortId');
    const statusFilter = url.searchParams.get('status');
    const reviewDueOnly = url.searchParams.get('reviewDue') === 'true';

    const national =
      isFounderUid(uid) || caller.roleKey === NMD_ROLE || caller.roleKey === NGS_ROLE || caller.roleKey === AUDIT_CHAIR_ROLE;
    const ownChapter =
      caller.roleKey != null && caller.roleKey.startsWith('chapter_') ? caller.chapterId : null;

    const snap = await db.collection('cadetships').get();
    const now = new Date();
    const out: Record<string, unknown>[] = [];

    snap.forEach((d) => {
      const doc = cadetshipFromFirestore(d.id, d.data() as Record<string, any>);
      if (!national) {
        if (ownChapter != null) {
          if (doc.chapterId !== ownChapter) return;
        } else if (doc.personUid !== uid) {
          return;
        }
      }
      if (chapterFilter && doc.chapterId !== chapterFilter) return;
      if (cohortFilter && doc.cohortId !== cohortFilter) return;
      const eff = cadetshipEffectiveStatus(doc, now);
      if (statusFilter && eff.status !== statusFilter) return;
      if (reviewDueOnly && !eff.reviewDue) return;
      out.push({
        ...cadetshipToJson(doc),
        effectiveStatus: eff.status,
        reviewDue: eff.reviewDue,
        week: cadetshipWeek(doc.startedAt, now),
        checklistDoneCount: checklistDoneCount(doc),
      });
    });

    out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    return NextResponse.json({ cadetships: out });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[cadetships/list] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
