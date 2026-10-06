import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { isManagerAbove } from '@/lib/server/hierarchy-utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Authenticated step-submit lookup.
 * Given a workflowId + stepIndex and a valid Bearer token, returns the
 * underlying task ID and current submission state — but ONLY if the caller
 * is the task's assignee (or a manager above them in the hierarchy).
 * This powers the personal "SCAN TO SUBMIT" QR flow from mission PDFs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string; stepIndex: string }> }
) {
  try {
    if (!ensureAdminInitialized()) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
    }

    const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await verifyIdTokenString(token);
    } catch {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const { workflowId, stepIndex } = await params;
    const seqIndex = parseInt(stepIndex, 10);
    if (!workflowId || isNaN(seqIndex)) {
      return NextResponse.json({ error: 'Invalid mission step' }, { status: 400 });
    }

    const snap = await db
      .collection('tasks')
      .where('workflowId', '==', workflowId)
      .where('sequenceIndex', '==', seqIndex)
      .limit(1)
      .get();

    if (snap.empty) {
      return NextResponse.json({ error: 'Mission step not found' }, { status: 404 });
    }

    const doc = snap.docs[0];
    const task = doc.data() as any;
    const assigneeIds: string[] = Array.isArray(task.assigneeIds)
      ? task.assigneeIds.map(String)
      : task.assigneeId
        ? [String(task.assigneeId)]
        : [];

    const isAssignee = assigneeIds.includes(decoded.uid);
    let isManager = false;
    if (!isAssignee && assigneeIds.length > 0) {
      try {
        // A manager above ANY assignee (doer or oversight) may act.
        for (const aid of assigneeIds) {
          if (await isManagerAbove(decoded.uid, aid)) { isManager = true; break; }
        }
      } catch {
        isManager = false;
      }
    }

    if (!isAssignee && !isManager) {
      return NextResponse.json(
        { error: 'This mission step is not assigned to you.' },
        { status: 403 }
      );
    }

    const serializeTs = (ts: any) => {
      if (!ts) return null;
      if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
      if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
      return ts;
    };

    return NextResponse.json({
      ok: true,
      task: {
        id: doc.id,
        title: task.title || '',
        description: task.description || '',
        status: task.status || 'pending',
        points: task.points || 0,
        individualDeadline: serializeTs(task.individualDeadline),
        deadline: serializeTs(task.deadline),
        report: task.report || '',
        hoursWorked: task.hoursWorked ?? null,
        resourceLinks: task.resourceLinks || '',
        penaltyPoints: typeof task.penaltyPoints === 'number' ? task.penaltyPoints : 0,
        isAssignee,
        isManager,
      },
    });
  } catch (e: any) {
    console.error('[mission-submit] lookup failed:', e?.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}
