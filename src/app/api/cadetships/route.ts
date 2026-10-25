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
import {
  isCadetshipsSupaEnabled,
  tryListCadetships,
  tryListEvaluations,
} from '@/lib/supa-seams/hr-cadetships';

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

    // Supa-first list when the cadetships surface is ON; the seam
    // converts ISO date strings to Dates before serialize.ts sees
    // them. Any adapter error (list or evaluations) falls back to the
    // exact Firestore reads below. Users (display names) stay on
    // Firestore in both paths (cross-collection, design verdict 1.7).
    let cadetDocs: Array<{ id: string; raw: Record<string, any> }> | null = null;
    const evalCountById = new Map<string, number>();
    if (isCadetshipsSupaEnabled()) {
      const supaResult = await tryListCadetships();
      if (supaResult.status === 'ok') {
        cadetDocs = supaResult.value.map((doc) => {
          const { id, ...rest } = doc;
          return { id, raw: rest as Record<string, any> };
        });
        let evalsOk = true;
        await Promise.all(
          cadetDocs.map(async (d) => {
            const evalResult = await tryListEvaluations(d.id);
            if (evalResult.status !== 'ok') {
              evalsOk = false;
              return;
            }
            evalCountById.set(d.id, evalResult.value.length);
          }),
        );
        if (!evalsOk) {
          cadetDocs = null;
          evalCountById.clear();
        }
      }
    }

    const now = new Date();
    const out: Record<string, unknown>[] = [];

    // F.8 roster columns need the cadet's display name and the evaluation
    // count (0/2, 1/2, 2/2); resolve both with one pass over the result
    // set (org scale makes the extra reads immaterial).
    const nameByUid = new Map<string, string | null>();
    if (cadetDocs === null) {
      const snap = await db.collection('cadetships').get();
      cadetDocs = snap.docs.map((d) => ({
        id: d.id,
        raw: d.data() as Record<string, any>,
      }));
      await Promise.all(
        snap.docs.map(async (d) => {
          const evalSnap = await d.ref.collection('evaluations').get();
          evalCountById.set(d.id, evalSnap.size);
        }),
      );
    }
    await Promise.all(
      cadetDocs.map(async (d) => {
        const personUid = d.raw.personUid as string;
        if (!nameByUid.has(personUid)) {
          const userSnap = await db.collection('users').doc(personUid).get();
          const displayName = userSnap.data()?.displayName;
          nameByUid.set(personUid, typeof displayName === 'string' ? displayName : null);
        }
      }),
    );

    cadetDocs.forEach((d) => {
      const doc = cadetshipFromFirestore(d.id, d.raw);
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
        displayName: nameByUid.get(doc.personUid) ?? null,
        evaluationsCount: evalCountById.get(d.id) ?? 0,
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
