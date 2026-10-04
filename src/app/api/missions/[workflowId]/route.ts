import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUBLIC mission status endpoint — no authentication required.
 * Returns sanitized workflow data for the public mission status page
 * (linked from PDF QR codes). Excludes contact info, emails, and
 * any sensitive personnel details.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    if (!ensureAdminInitialized()) {
      return NextResponse.json({ ok: false, error: 'Server misconfiguration' }, { status: 500 });
    }
    const db = getDb();
    if (!db) {
      return NextResponse.json({ ok: false, error: 'Database not initialized' }, { status: 500 });
    }

    const { workflowId } = await params;
    if (!workflowId) {
      return NextResponse.json({ ok: false, error: 'Missing workflowId' }, { status: 400 });
    }

    const serializeTs = (ts: any) => {
      if (!ts) return null;
      if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
      if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
      return ts;
    };

    const snap = await db.collection('tasks').where('workflowId', '==', workflowId).get();
    if (snap.empty) {
      return NextResponse.json({ ok: false, error: 'Mission not found' }, { status: 404 });
    }

    const tasks = snap.docs
      .map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          title: data.title || '',
          description: data.description || '',
          status: data.status || 'pending',
          sequenceIndex: data.sequenceIndex || 0,
          points: data.points || 0,
          individualDeadline: serializeTs(data.individualDeadline),
          deadline: serializeTs(data.deadline),
          completedAt: serializeTs(data.completedAt),
          createdAt: serializeTs(data.createdAt),
          assigneeId: data.assigneeId || null,
          assigneeIds: Array.isArray(data.assigneeIds) ? data.assigneeIds.map(String) : null,
          role: data.role || null,
          chapterId: data.chapterId || null,
          projectId: data.projectId || null,
        };
      })
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);

    // Fetch public assignee info (name + chapter only, no contact details).
    // Collect from both assignee forms so co-assignees resolve too.
    const stepAssigneeIds = (d: any): string[] =>
      Array.isArray(d.assigneeIds) && d.assigneeIds.length
        ? d.assigneeIds.map(String).filter(Boolean)
        : (d.assigneeId ? [String(d.assigneeId)] : []);
    const uniqueAssigneeIds = Array.from(new Set(tasks.flatMap(t => stepAssigneeIds(t))));
    const assigneeInfo: Record<string, { name: string; chapterName?: string }> = {};

    if (uniqueAssigneeIds.length > 0) {
      const userSnaps = await Promise.all(
        uniqueAssigneeIds.map(uid => db.collection('users').doc(uid).get())
      );
      const chapterCache: Record<string, string> = {};
      for (const doc of userSnaps) {
        if (!doc.exists) {
          assigneeInfo[doc.id] = { name: 'SEDS Member' };
          continue;
        }
        const userData = doc.data() as any;
        let chapterName: string | undefined;
        const userChapterId = userData?.chapterId;
        if (userChapterId) {
          if (!chapterCache[userChapterId]) {
            try {
              const chapSnap = await db.collection('chapters').doc(userChapterId).get();
              if (chapSnap.exists) {
                chapterCache[userChapterId] = chapSnap.data()?.name || '';
              }
            } catch { /* ignore */ }
          }
          chapterName = chapterCache[userChapterId] || undefined;
        }
        assigneeInfo[doc.id] = {
          name: userData?.displayName || 'SEDS Member',
          chapterName,
        };
      }
    }

    // Workflow-level chapter name
    let chapterName: string | null = null;
    const firstTaskWithChapter = tasks.find(t => !!t.chapterId);
    if (firstTaskWithChapter?.chapterId) {
      try {
        const chapSnap = await db.collection('chapters').doc(firstTaskWithChapter.chapterId).get();
        if (chapSnap.exists) chapterName = chapSnap.data()?.name || null;
      } catch { /* ignore */ }
    }

    const firstTask = tasks[0] as any;
    const totalSteps = tasks.length;
    const completedSteps = tasks.filter(t => t.status === 'completed').length;
    const progressPercentage = totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const steps = tasks.map(t => {
      const ids = stepAssigneeIds(t as any);
      const primaryId = ids[0] || (t as any).assigneeId || '';
      return {
        title: t.title,
        description: t.description,
        status: t.status,
        sequenceIndex: t.sequenceIndex,
        points: t.points,
        individualDeadline: t.individualDeadline,
        completedAt: t.completedAt,
        assigneeName: assigneeInfo[primaryId]?.name || 'SEDS Member',
        assigneeChapter: assigneeInfo[primaryId]?.chapterName || null,
        assignees: ids.map(id => ({
          name: assigneeInfo[id]?.name || 'SEDS Member',
          chapterName: assigneeInfo[id]?.chapterName || null,
        })),
        role: t.role,
      };
    });

    return NextResponse.json({
      ok: true,
      mission: {
        workflowId,
        title: (snap.docs[0].data() as any)?.workflowTitle || workflowId,
        description: (snap.docs[0].data() as any)?.guidance?.description || '',
        chapterName,
        totalSteps,
        completedSteps,
        progressPercentage,
        isCompleted: totalSteps > 0 && completedSteps === totalSteps,
        createdAt: tasks[0]?.createdAt || null,
        deadline: firstTask?.deadline || null,
        steps,
      },
    }, {
      headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' }
    });
  } catch (e: any) {
    console.error('[missions:GET] Error:', e);
    return NextResponse.json({ ok: false, error: 'Internal Server Error' }, { status: 500 });
  }
}
