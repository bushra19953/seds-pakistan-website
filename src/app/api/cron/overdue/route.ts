import { NextResponse } from 'next/server';
import { getG3Db } from '@/lib/server/cron/g3-data';
import { taskHasProofUploaded } from '@/lib/server/bug4-proof-guards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Pakistan Standard Time offset (no DST): UTC+5
const PKT_OFFSET = '+05:00';

function hasOffsetDesignator(s: string): boolean {
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(s.trim());
}

/**
 * Normalize a stored deadline of any shape into epoch millis.
 * Handles: Firestore Timestamp, JS Date, epoch number, ISO string.
 * A datetime string with no offset designator is interpreted as PKT
 * (Asia/Karachi, UTC+5), since deadlines are authored in PKT.
 * Returns 0 when the value cannot be parsed.
 */
function deadlineToMillis(raw: unknown): number {
  if (raw == null) return 0;
  try {
    if (typeof (raw as any)?.toMillis === 'function') {
      return (raw as any).toMillis();
    }
    if (raw instanceof Date) {
      const ms = raw.getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return 0;
      // Tolerate epoch seconds vs millis.
      const ms = raw < 1e12 ? raw * 1000 : raw;
      return ms;
    }
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return 0;
      const withOffset = hasOffsetDesignator(s) ? s : `${s}${PKT_OFFSET}`;
      const ms = new Date(withOffset).getTime();
      if (!Number.isNaN(ms)) return ms;
      const fallback = new Date(s).getTime();
      return Number.isNaN(fallback) ? 0 : fallback;
    }
  } catch {
    // fall through to 0
  }
  return 0;
}

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!isCron) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getG3Db();
    if (!db) {
      throw new Error('Database initialization failed');
    }

    const now = new Date();
    const nowMillis = now.getTime();
    console.log('[OVERDUE] Starting overdue task check at:', now.toISOString());

    // ROOT CAUSE FIX: the old query used
    //   .where('individualDeadline', '<', now)
    // with `now` as a Timestamp. Firestore compares values by type order
    // (null < boolean < number < timestamp < string < ...), so any step/task
    // whose deadline was stored as an ISO STRING (written by the admin task
    // editor and workflow forms via .toISOString()) sorts ABOVE timestamps
    // and can NEVER match a '<' filter against a Timestamp. Those steps were
    // invisible to this scan and stayed 'pending' forever. The fix follows the
    // proven pattern from /api/cron/check-deadlines: query by status only and
    // compare deadlines in JS, normalizing every stored type (Timestamp, Date,
    // number, string) and falling back to the plain `deadline` field.
    const snap = await db
      .collection('tasks')
      .where('status', 'in', ['pending', 'in-progress'])
      .get();

    const counts = {
      scanned: snap.size,
      noDeadline: 0,
      unparseableDeadline: 0,
      notYetDue: 0,
      alreadyOverdue: 0,
      newlyMarked: 0,
      proofUploadedSkipped: 0,
    };

    const toMark: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    // Bug 4 fix: tasks with proof already uploaded must not be stamped
    // overdue. Proof on the task means the assignee did the work and it is
    // awaiting reviewer action; marking it overdue would punish the assignee
    // for the reviewer's delay. Track them here with a skip reason so the
    // cron report shows why each one was left untouched.
    const skippedDetails: { taskId: string; reason: string }[] = [];

    snap.docs.forEach((d: FirebaseFirestore.QueryDocumentSnapshot) => {
      const data = d.data() as any;
      const status = String(data?.status || '').toLowerCase();

      if (status === 'overdue' || status === 'completed') {
        // Defensive: the query already excludes these; never re-touch them.
        counts.alreadyOverdue += 1;
        return;
      }

      // The query is intentionally left unchanged (status-only, index
      // friendly); this filter runs in code after fetch. A non-empty
      // deliverableFiles array means the assignee already submitted proof,
      // so the task is awaiting review, not missing work.
      if (taskHasProofUploaded(data)) {
        counts.proofUploadedSkipped += 1;
        skippedDetails.push({ taskId: d.id, reason: 'proof uploaded; awaiting review' });
        return;
      }

      const rawDeadline = data?.individualDeadline ?? data?.deadline;
      if (rawDeadline == null || rawDeadline === '') {
        counts.noDeadline += 1;
        return;
      }

      const deadlineMs = deadlineToMillis(rawDeadline);
      if (deadlineMs <= 0) {
        counts.unparseableDeadline += 1;
        console.warn(`[OVERDUE] Skipping task ${d.id}: unparseable deadline`, rawDeadline);
        return;
      }

      if (deadlineMs >= nowMillis) {
        counts.notYetDue += 1;
        return;
      }

      toMark.push(d);
    });

    // Idempotent: only docs whose status is NOT already 'overdue' reach this
    // point, and the batch is chunked to Firestore's 500-write limit.
    const CHUNK = 500;
    for (let i = 0; i < toMark.length; i += CHUNK) {
      const chunk = toMark.slice(i, i + CHUNK);
      const batch = db.batch();
      chunk.forEach((d) => {
        batch.update(d.ref, { status: 'overdue', updatedAt: now });
      });
      await batch.commit();
      counts.newlyMarked += chunk.length;
    }

    console.log(`[OVERDUE] Scanned ${counts.scanned}, marked ${counts.newlyMarked} as overdue, skipped ${counts.proofUploadedSkipped} with proof uploaded`);

    let releaseResult = { enabled: false, stepsReleased: 0 };

    try {
      const settingsSnap = await db.collection('settings').doc('workflow').get();
      const releaseOnOverdue = !!(settingsSnap.exists && settingsSnap.data()?.releaseOnOverdue === true);

      if (releaseOnOverdue) {
        console.log('[OVERDUE] Workflow release on overdue is ENABLED');
        releaseResult.enabled = true;
        const overdueSnap = await db.collection('tasks').where('status', '==', 'overdue').get();

        const toUnflag = overdueSnap.docs.filter((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
          const t = doc.data() as any;
          return String(t.workflowId || '') !== '' && t.isCurrentStep === true;
        });
        for (let i = 0; i < toUnflag.length; i += CHUNK) {
          const chunk = toUnflag.slice(i, i + CHUNK);
          const relBatch = db.batch();
          chunk.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
            relBatch.update(doc.ref, { isCurrentStep: false, updatedAt: now });
          });
          await relBatch.commit();
        }

        const nextBatch = db.batch();
        let nextWrites = 0;
        for (const doc of overdueSnap.docs) {
          const t = doc.data() as any;
          const wfId = String(t.workflowId || '');
          const seq = Number(t.sequenceIndex);
          if (!wfId || !Number.isFinite(seq)) continue;

          const nextQuery = await db.collection('tasks')
            .where('workflowId', '==', wfId)
            .where('sequenceIndex', '==', seq + 1)
            .limit(1)
            .get();

          if (!nextQuery.empty) {
            const nextDoc = nextQuery.docs[0];
            const n = nextDoc.data() as any;
            // Idempotent: do not re-release a step that is already current.
            if (n.isCurrentStep === true) continue;
            nextBatch.update(nextDoc.ref, { releasedAt: now, isCurrentStep: true, updatedAt: now });
            nextWrites += 1;
          }
        }
        if (nextWrites > 0) {
          await nextBatch.commit();
          releaseResult.stepsReleased = nextWrites;
        }
      }
    } catch (e: any) {
      console.error('[OVERDUE] Failed to process workflow releases:', e);
    }

    console.log('[OVERDUE] Overdue task check completed');
    return NextResponse.json({
      success: true,
      checkedAt: now.toISOString(),
      ...counts,
      skippedDetails,
      releaseOnOverdue: releaseResult.enabled,
      stepsReleased: releaseResult.stepsReleased,
    });

  } catch (error: any) {
    console.error('CRON OVERDUE ERROR:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
