import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    // Vercel Cron jobs use Bearer token if configured, or hit it openly if not documented differently.
    // For now, we will allow Vercel's User Agent or require a CRON_SECRET if environment supports it
    const VERCEL_CRON_HEADER = request.headers.get('x-vercel-cron');
    
    // Optional basic protection:
    if (process.env.VERCEL_ENV === 'production' && !VERCEL_CRON_HEADER) {
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const db = getDb();
    if (!db) {
      throw new Error('Database initialization failed');
    }

    const now = new Date();
    console.log('🕒 [OVERDUE] Starting overdue task check at:', now.toISOString());

    const snap = await db.collection('tasks').where('individualDeadline', '<', now).get();
    const batch = db.batch();
    let count = 0;
    snap.docs.forEach((d) => {
      const data = d.data() as any;
      const status = String(data?.status || '').toLowerCase();
      if (status !== 'completed' && status !== 'overdue') {
        batch.update(d.ref, { status: 'overdue', updatedAt: now });
        count += 1;
      }
    });

    if (count > 0) {
      await batch.commit();
      console.log(`🕒 [OVERDUE] Marked ${count} tasks as overdue`);
    } else {
      console.log('🕒 [OVERDUE] No new overdue tasks found');
    }

    try {
      const settingsSnap = await db.collection('settings').doc('workflow').get();
      const releaseOnOverdue = !!(settingsSnap.exists && settingsSnap.data()?.releaseOnOverdue === true);

      if (releaseOnOverdue) {
        console.log('🕒 [OVERDUE] Workflow release on overdue is ENABLED');
        const overdueSnap = await db.collection('tasks').where('status', '==', 'overdue').get();
        const relBatch = db.batch();
        overdueSnap.docs.forEach((doc) => {
          const t = doc.data() as any;
          const wfId = String(t.workflowId || '');
          const seq = Number(t.sequenceIndex);
          if (!wfId || !Number.isFinite(seq)) return;
          relBatch.update(doc.ref, { isCurrentStep: false, updatedAt: now });
        });
        await relBatch.commit();
        
        const nextBatch = db.batch();
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
            const nextRef = nextQuery.docs[0].ref;
            nextBatch.update(nextRef, { releasedAt: now, isCurrentStep: true, updatedAt: now });
          }
        }
        await nextBatch.commit();
      }
    } catch (e: any) {
      console.error('🕒 [OVERDUE] Failed to process workflow releases:', e);
    }

    console.log('🕒 [OVERDUE] Overdue task check completed');
    return NextResponse.json({ success: true, markedCount: count });

  } catch (error: any) {
    console.error('CRON OVERDUE ERROR:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
