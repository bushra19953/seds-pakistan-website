import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { calculateWorkflowDeadlines } from '@/lib/workflow-utils';
import { validateUserStatus } from '@/lib/server/user-status';
import { hasServerPermission, resolveUserRole } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function extractBearerToken(request: NextRequest): string | undefined {
  const h = request.headers.get('authorization') || request.headers.get('Authorization');
  if (h && h.startsWith('Bearer ')) return h.substring('Bearer '.length).trim();
  const cookieToken = request.cookies.get('__session')?.value;
  if (cookieToken) return cookieToken;
  return undefined;
}

async function authenticate(request: NextRequest): Promise<{ decoded: admin.auth.DecodedIdToken } | { error: NextResponse }> {
  if (!ensureAdminInitialized()) {
    return { error: NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 }) };
  }
  const token = extractBearerToken(request);
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized: missing Bearer token' }, { status: 401 }) };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (projectId) {
      const expectedIss = `https://securetoken.google.com/${projectId}`;
      if (decoded.iss !== expectedIss || decoded.aud !== projectId) {
        return { error: NextResponse.json({ error: 'Unauthorized: token issued for different project' }, { status: 401 }) };
      }
    }
    return { decoded };
  } catch {
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token' }, { status: 401 }) };
  }
}

const StepSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  role: z.string().optional(),
  assigneeId: z.string().min(1),
  assigneeIds: z.array(z.string().min(1)).optional(),
  estimatedDuration: z.number().int().optional(),
  workflowTags: z.array(z.string()).optional(),
  workflowPriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  points: z.number().optional(), // NEW: Accept explicit points
  stepSpecificBadgeId: z.string().optional(),
  individualDeadline: z.union([z.string(), z.number(), z.date()]).optional(),
  resources: z.array(z.object({
    type: z.enum(['link', 'drive', 'github', 'doc', 'video', 'other']),
    url: z.string().url(),
    title: z.string()
  })).optional(),
});

const CreateWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  workflowTitle: z.string().min(1),
  finalDeadline: z.union([z.string(), z.number(), z.date()]),
  steps: z.array(StepSchema).min(1),
  projectId: z.string().nullable().optional(),
  chapterId: z.string().nullable().optional(), // NEW
  finalWorkflowCompletionBadgeId: z.string().optional(),
  basePoints: z.number().optional(), // NEW: total pool distributed across steps
  penaltyPoints: z.number().optional(), // NEW: deadline penalty applied per task
  workflowBonusPoints: z.number().optional(), // NEW: bonus applied per task
  guidance: z.object({
    description: z.string().optional(),
    steps: z.array(z.string()).optional(),
    estimatedTime: z.number().optional(),
  }).optional(), // NEW: task guidance for assignees
  resources: z.array(z.object({
    type: z.enum(['link', 'drive', 'github', 'doc', 'video', 'other']),
    url: z.string().url(),
    title: z.string()
  })).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    const auth = await authenticate(request);
    if ('error' in auth) return auth.error;
    const decoded = auth.decoded;

    // SECURITY: only users with task-management permission may create workflows.
    const creatorRole = await resolveUserRole(db, decoded.uid);
    if (!(await hasServerPermission(creatorRole, 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = CreateWorkflowSchema.safeParse(body);
    if (!parsed.success) {
      console.error('CRITICAL: API VALIDATION FAILED', parsed.error.flatten());
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;
    let finalDeadline: Date | null = null;
    if (typeof data.finalDeadline === 'string') finalDeadline = new Date(data.finalDeadline);
    else if (typeof data.finalDeadline === 'number') finalDeadline = new Date(data.finalDeadline);
    else finalDeadline = data.finalDeadline as Date;
    if (!finalDeadline || isNaN(finalDeadline.getTime())) {
      return NextResponse.json({ error: 'Invalid final deadline' }, { status: 400 });
    }
    if (finalDeadline.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Final deadline must be in the future' }, { status: 400 });
    }

    // Normalize a step's assignees to a deduped array of non-empty ids.
    // The singular assigneeId stays as the first element for
    // backward-compatible readers.
    const stepAssigneeIdsOf = (step: any): string[] => {
      const raw = Array.isArray(step.assigneeIds) && step.assigneeIds.length
        ? step.assigneeIds
        : [step.assigneeId];
      return Array.from(new Set(raw.map((v: any) => String(v)).filter(Boolean)));
    };

    const deadlines = calculateWorkflowDeadlines(finalDeadline, data.steps.length);
    const wfParticipantIds = Array.from(new Set(data.steps.flatMap(stepAssigneeIdsOf)));

    // CRITICAL: Log incoming payload for debugging
    console.log('[workflows:POST] Creating workflow:', {
      workflowId: data.workflowId,
      workflowTitle: data.workflowTitle,
      stepsCount: data.steps.length,
      participants: wfParticipantIds,
    });

    // Validate step titles are unique to prevent deduplication issues
    const stepTitles = data.steps.map(s => s.title);
    const uniqueTitles = new Set(stepTitles);
    if (uniqueTitles.size !== stepTitles.length) {
      console.warn('[workflows:POST] Duplicate step titles detected:', stepTitles);
      // Don't fail, but log for debugging - the fix should prevent this
    }

    // Validate assignee status: block assignments to banned or invalid users
    for (const step of data.steps) {
      for (const aid of stepAssigneeIdsOf(step)) {
        const statusCheck = await validateUserStatus(aid);

        if (!statusCheck.isValid) {
          const userDoc = await db.collection('users').doc(aid).get();
          const userName = userDoc.data()?.displayName || userDoc.data()?.email || aid;

          if (statusCheck.isBanned) {
            return NextResponse.json({
              error: 'Cannot assign workflows to banned users',
              message: `The following user is banned: ${userName}. Please select different assignees.`
            }, { status: 403 });
          }

          return NextResponse.json({
            error: 'Cannot assign workflows to invalid users',
            message: statusCheck.error || `User ${userName} is not valid for assignment.`
          }, { status: 403 });
        }
      }
    }

    // Log each step before creation
    data.steps.forEach((step, i) => {
      console.log(`[workflows:POST] Step ${i}:`, {
        title: step.title,
        assigneeId: step.assigneeId,
        resourcesCount: step.resources?.length || 0,
      });
    });

    const created: Array<{ id: string; assigneeId: string; sequenceIndex: number }> = [];

    // Calculate base points per step (escalates for later steps to incentivize completion)
    const BASE_POINTS_PER_STEP = 10;

    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      const stepAssigneeIds = stepAssigneeIdsOf(step);
      const isCurrentStep = i === 0;
      let individualDeadline: Date | null = deadlines[i];
      if (typeof step.individualDeadline === 'string') {
        const d = new Date(step.individualDeadline);
        if (!isNaN(d.getTime())) individualDeadline = d;
      } else if (typeof step.individualDeadline === 'number') {
        const d = new Date(step.individualDeadline);
        if (!isNaN(d.getTime())) individualDeadline = d;
      } else if (step.individualDeadline instanceof Date) {
        individualDeadline = step.individualDeadline as Date;
      }

      // Calculate step points: explicit per-step points win, then even split of
      // the base pool, then the legacy escalating default.
      const stepPoints = typeof step.points === 'number'
        ? step.points
        : (typeof data.basePoints === 'number' && data.steps.length > 0
            ? Math.round(data.basePoints / data.steps.length)
            : (BASE_POINTS_PER_STEP + (i * 5)));

      const taskDoc: any = {
        title: step.title,
        description: step.description,
        assignerId: decoded.uid,
        assigneeId: stepAssigneeIds[0],
        assigneeIds: stepAssigneeIds,
        workflowId: data.workflowId,
        workflowTitle: data.workflowTitle,
        workflowParticipantIds: wfParticipantIds,
        sequenceIndex: i,
        role: step.role || null,
        releasedAt: isCurrentStep ? admin.firestore.FieldValue.serverTimestamp() : null,
        deadline: finalDeadline,
        individualDeadline,
        isCurrentStep,
        status: 'pending',
        points: stepPoints, // FIXED: Meaningful points instead of 0
        penaltyPoints: typeof data.penaltyPoints === 'number' ? data.penaltyPoints : 5,
        workflowBonusPoints: typeof data.workflowBonusPoints === 'number' ? data.workflowBonusPoints : 10,
        guidance: data.guidance || null,
        projectId: data.projectId || null,
        chapterId: data.chapterId || null, // SAVING CHAPTER ID
        workflowPriority: step.workflowPriority || null,
        workflowTags: step.workflowTags || [],
        estimatedDuration: step.estimatedDuration || null,
        stepSpecificBadgeId: step.stepSpecificBadgeId || null,
        finalWorkflowCompletionBadgeId: data.finalWorkflowCompletionBadgeId || null,
        resources: [...(data.resources || []), ...(step.resources || [])], // Merge global + step resources
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      const docRef = db.collection('tasks').doc();
      await docRef.set(taskDoc);
      created.push({ id: docRef.id, assigneeId: stepAssigneeIds[0], sequenceIndex: i });
      // Every assignee (doer and oversight) gets their assignment counters.
      for (const aid of stepAssigneeIds) {
        await db.collection('users').doc(aid).set({
          tasksAssignedCount: admin.firestore.FieldValue.increment(1),
          lastTaskAssignedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    // Ensure workflow members exist
    const allParticipants = new Set([decoded.uid, ...wfParticipantIds]);
    const memberBatch = db.batch();
    let hasMemberUpdates = false;
    for (const uid of allParticipants) {
      if (!uid) continue;
      const memberId = `${data.workflowId}_${uid}`;
      const memberRef = db.collection('workflow_members').doc(memberId);
      memberBatch.set(memberRef, {
        workflowId: data.workflowId,
        userId: uid,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        role: uid === decoded.uid ? 'owner' : 'member'
      }, { merge: true });
      hasMemberUpdates = true;
    }
    if (hasMemberUpdates) {
      await memberBatch.commit();
    }

    return NextResponse.json({ ok: true, created });
  } catch (e: any) {
    return NextResponse.json({ error: 'Internal Server Error', details: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    const auth = await authenticate(request);
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const workflowId = searchParams.get('workflowId');

    // ─── LIST ALL WORKFLOWS (admin list view) ─────────────────────────────────
    if (!workflowId) {
      // Aggregate all distinct workflows from tasks collection
      const tasksSnap = await db.collection('tasks')
        .where('workflowId', '!=', null)
        .orderBy('workflowId')
        .get();

      const serializeTs = (ts: any) => {
        if (!ts) return null;
        if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
        if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
        return ts;
      };

      // Group by workflowId
      const workflowMap = new Map<string, {
        id: string;
        title: string;
        totalSteps: number;
        completedSteps: number;
        participants: Set<string>;
        createdAt: string | null;
        updatedAt: string | null;
        overdueCount: number;
        currentStepIndex: number;
      }>();

      tasksSnap.docs.forEach(d => {
        const data = d.data() as any;
        const wfId = data.workflowId;
        if (!wfId) return;

        if (!workflowMap.has(wfId)) {
          workflowMap.set(wfId, {
            id: wfId,
            title: data.workflowTitle || wfId,
            totalSteps: 0,
            completedSteps: 0,
            participants: new Set(),
            createdAt: serializeTs(data.createdAt),
            updatedAt: serializeTs(data.updatedAt),
            overdueCount: 0,
            currentStepIndex: 0,
          });
        }

        const wf = workflowMap.get(wfId)!;
        wf.totalSteps += 1;
        if (data.status === 'completed') wf.completedSteps += 1;
        // Union both assignee forms so co-assignees count as participants
        // (and pass the non-manager visibility filter below).
        const pIds: string[] = Array.isArray(data.assigneeIds) && data.assigneeIds.length
          ? data.assigneeIds.map(String)
          : (data.assigneeId ? [String(data.assigneeId)] : []);
        pIds.forEach(id => { if (id) wf.participants.add(id); });
        if (data.status === 'overdue') wf.overdueCount += 1;
        // Track most recent updatedAt
        const updTs = serializeTs(data.updatedAt);
        if (updTs && (!wf.updatedAt || updTs > wf.updatedAt)) wf.updatedAt = updTs;
        if (data.isCurrentStep) wf.currentStepIndex = data.sequenceIndex || 0;
      });

      const workflows = Array.from(workflowMap.values()).map(wf => ({
        id: wf.id,
        title: wf.title,
        totalSteps: wf.totalSteps,
        completedSteps: wf.completedSteps,
        currentStepIndex: wf.currentStepIndex,
        progressPercentage: wf.totalSteps ? Math.round((wf.completedSteps / wf.totalSteps) * 100) : 0,
        isCompleted: wf.totalSteps > 0 && wf.completedSteps === wf.totalSteps,
        participants: Array.from(wf.participants),
        createdAt: wf.createdAt || new Date().toISOString(),
        updatedAt: wf.updatedAt || wf.createdAt || new Date().toISOString(),
        overdueSteps: wf.overdueCount,
        efficiencyScore: wf.totalSteps
          ? Math.round(((wf.completedSteps) / wf.totalSteps) * 100)
          : 0,
      }));

      // PRIVACY: non-managers only see workflows they participate in.
      const viewerUid = auth.decoded.uid;
      const viewerRole = await resolveUserRole(db, viewerUid);
      const viewerCanManage = await hasServerPermission(viewerRole, 'canManageWorkflows')
        || await hasServerPermission(viewerRole, 'canManageTasks');
      const visibleWorkflows = viewerCanManage
        ? workflows
        : workflows.filter(wf => wf.participants.includes(viewerUid));

      // Sort by most recently updated
      workflows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      return NextResponse.json({ ok: true, workflows: visibleWorkflows }, {
        headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' }
      });
    }

    // ─── SINGLE WORKFLOW DETAIL ───────────────────────────────────────────────
    const decoded = auth.decoded;
    const snap = await db.collection('tasks').where('workflowId', '==', workflowId).get();
    const serializeTs = (ts: any) => {
      if (!ts) return null;
      if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
      if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
      return ts;
    };
    const tasks = snap.docs
      .map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          ...data,
          deadline: serializeTs(data.deadline),
          individualDeadline: serializeTs(data.individualDeadline),
          createdAt: serializeTs(data.createdAt),
          updatedAt: serializeTs(data.updatedAt),
          completedAt: serializeTs(data.completedAt),
          releasedAt: serializeTs(data.releasedAt),
        };
      })
      .sort((a, b) => (a.sequenceIndex || 0) - (b.sequenceIndex || 0));

    // Fetch full assignee info for all tasks (name, photo, position)
    // OPTIMIZED: Batch fetch users using direct lookups for reliability.
    // Collect from BOTH assignee forms so co-assignees resolve too.
    const taskAssigneeIds = (t: any): string[] =>
      Array.isArray(t.assigneeIds) && t.assigneeIds.length
        ? t.assigneeIds.map(String).filter(Boolean)
        : (t.assigneeId ? [String(t.assigneeId)] : []);
    const uniqueAssigneeIds = Array.from(new Set(tasks.flatMap(taskAssigneeIds)));
    const assigneeInfo: Record<string, { name: string; photoURL?: string; position?: string; role?: string; whatsapp?: string; email?: string; chapterName?: string }> = {};

    // NEW: Get chapter name if available
    let chapterName: string | null = null;
    const firstTaskWithChapter = tasks.find(t => !!t.chapterId);
    if (firstTaskWithChapter?.chapterId) {
      try {
        const chapSnap = await db.collection('chapters').doc(firstTaskWithChapter.chapterId).get();
        if (chapSnap.exists) {
          chapterName = chapSnap.data()?.name || null;
        }
      } catch (e) {
        console.error('[workflows:GET] Chapter fetch error:', e);
      }
    }

    if (uniqueAssigneeIds.length > 0) {
      try {
        // Fetch users in parallel
        const userSnapshots = await Promise.all(
          uniqueAssigneeIds.map(uid => db.collection('users').doc(uid).get())
        );

        // Process results - fetch chapter names for users with chapterId
        const chapterCache: Record<string, string> = {};
        for (const doc of userSnapshots) {
          if (doc.exists) {
            const userData = doc.data() as any;
            let chapterName: string | null = userData?.chapterName || null;
            // Look up chapter name from chapterId if not directly stored
            const chapterId = userData?.chapterId;
            if (!chapterName && chapterId) {
              if (!chapterCache[chapterId]) {
                try {
                  const chapSnap = await db.collection('chapters').doc(chapterId).get();
                  if (chapSnap.exists) {
                    chapterCache[chapterId] = (chapSnap.data() as any)?.name || '';
                  }
                } catch { /* ignore */ }
              }
              chapterName = chapterCache[chapterId] || null;
            }
            assigneeInfo[doc.id] = {
              name: userData?.displayName || userData?.email || doc.id,
              photoURL: userData?.photoURL || userData?.profileImageUrl || null,
              position: userData?.position || userData?.title || null,
              role: userData?.role || null,
              whatsapp: userData?.whatsapp || userData?.whatsappNumber || null,
              email: userData?.email || null,
              chapterName,
            };
          } else {
            assigneeInfo[doc.id] = { name: doc.id };
          }
        }
      } catch (e) {
        console.error('[workflows:GET] User fetch error:', e);
      }
    }

    // Add full assignee info to tasks. assignees[] carries every assignee
    // (primary first); the singular fields stay as the primary for compat.
    const tasksWithNames = tasks.map(t => {
      const ids = taskAssigneeIds(t);
      const primaryId = ids[0] || t.assigneeId || null;
      return {
        ...t,
        assignees: ids.map(id => ({
          id,
          name: assigneeInfo[id]?.name || id || 'Unknown',
          photoURL: assigneeInfo[id]?.photoURL || null,
          role: assigneeInfo[id]?.role || null,
          chapterName: assigneeInfo[id]?.chapterName || null,
        })),
        assigneeName: assigneeInfo[primaryId as string]?.name || primaryId || 'Unknown',
        assigneePhoto: assigneeInfo[primaryId as string]?.photoURL || null,
        assigneePosition: assigneeInfo[primaryId as string]?.position || null,
        assigneeRole: assigneeInfo[primaryId as string]?.role || null,
        assigneeWhatsapp: assigneeInfo[primaryId as string]?.whatsapp || null,
        assigneeEmail: assigneeInfo[primaryId as string]?.email || null,
        assigneeChapter: assigneeInfo[primaryId as string]?.chapterName || null,
      };
    });

    // SECURITY FILTER: Mask WhatsApp numbers based on participant/admin status.
    // Prefer the live roles collection: the custom claim can lag up to an
    // hour after a demotion, which would keep leaking contact details.
    const roleSnap = await db.collection('roles').doc(decoded.uid).get().catch(() => null);
    const liveRole = roleSnap && roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
    const userRole = String(liveRole || decoded.role || '').toLowerCase();
    const isAdmin = userRole === 'superadmin' || userRole.includes('president') || userRole.includes('admin');
    const isParticipant = uniqueAssigneeIds.includes(decoded.uid);

    // Check if user is a member of the workflow
    const memberId = `${workflowId}_${decoded.uid}`;
    const memberDoc = await db.collection('workflow_members').doc(memberId).get();
    const isWorkflowMember = memberDoc.exists;

    const canViewContact = isAdmin || isParticipant || isWorkflowMember;

    if (!canViewContact) {
      tasksWithNames.forEach(t => {
        t.assigneeWhatsapp = null;
        t.assigneeEmail = null;
      });
    }

    const totalSteps = tasksWithNames.length;
    const completedSteps = tasksWithNames.filter(t => String(t.status) === 'completed').length;
    const currentIndex = Math.max(0, tasksWithNames.findIndex(t => !!t.isCurrentStep));
    const progressPercentage = totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const analytics = {
      workflowId,
      totalDuration: tasksWithNames.reduce((acc, t) => acc + (Number(t.estimatedDuration || 0)), 0),
      onTimeCompletionRate: 0,
      averageStepDuration: 0,
      participantCount: uniqueAssigneeIds.length,
      efficiencyScore: 0,
    };
    const progress = { workflowId, totalSteps, completedSteps, currentStepIndex: currentIndex, progressPercentage, isCompleted: completedSteps === totalSteps };

    return NextResponse.json({ ok: true, tasks: tasksWithNames, progress, analytics, assigneeInfo, chapterName }, {
      headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=300' }
    });
  } catch (e: any) {
    console.error('[workflows:GET] CRITICAL ERROR:', e);
    return NextResponse.json({ error: 'Internal Server Error', details: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    const auth = await authenticate(request);
    if ('error' in auth) return auth.error;
    const decoded = auth.decoded;

    // SECURITY: only users with task-management permission may modify workflows.
    const patcherRole = await resolveUserRole(db, decoded.uid);
    if (!(await hasServerPermission(patcherRole, 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    const body = await request.json();
    const schema = z.object({
      workflowId: z.string().min(1),
      sequenceIndex: z.number().int(),
      updates: z.object({
        assigneeId: z.string().optional(),
        assigneeIds: z.array(z.string()).optional(),
        status: z.string().optional(),
      }),
      reason: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }
    const { workflowId, sequenceIndex, updates, reason } = parsed.data as any;

    const q = await db.collection('tasks').where('workflowId', '==', workflowId).where('sequenceIndex', '==', sequenceIndex).limit(1).get();
    if (q.empty) return NextResponse.json({ error: 'Step not found' }, { status: 404 });
    const d = q.docs[0];

    // Normalize multi-assignee edits: persist the full deduped array and keep the
    // singular assigneeId as the primary (first) for backward-compatible readers.
    const updatesToApply: Record<string, any> = { ...updates };
    if (Array.isArray(updatesToApply.assigneeIds)) {
      const ids = Array.from(new Set(updatesToApply.assigneeIds.map((v: any) => String(v)).filter(Boolean)));
      if (ids.length > 0) {
        updatesToApply.assigneeIds = ids;
        updatesToApply.assigneeId = ids[0];
      } else {
        delete updatesToApply.assigneeIds;
      }
    }

    await d.ref.set({ ...updatesToApply, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await db.collection('workflow_audits').add({
      workflowId,
      sequenceIndex,
      updates: updatesToApply,
      reason: reason || null,
      actorId: decoded.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Return the updated step enriched with resolved assignees[] (same shape as GET).
    const afterData = { ...(d.data() as any), ...updatesToApply };
    const stepAssigneeIds: string[] = Array.isArray(afterData.assigneeIds) && afterData.assigneeIds.length
      ? afterData.assigneeIds.map(String).filter(Boolean)
      : (afterData.assigneeId ? [String(afterData.assigneeId)] : []);
    const chapterCache: Record<string, string> = {};
    const assignees = await Promise.all(stepAssigneeIds.map(async (uid) => {
      try {
        const uSnap = await db.collection('users').doc(uid).get();
        const uData = uSnap.exists ? (uSnap.data() as any) : null;
        let assigneeChapter: string | null = uData?.chapterName || null;
        const chapterId = uData?.chapterId;
        if (!assigneeChapter && chapterId) {
          if (!chapterCache[chapterId]) {
            try {
              const chapSnap = await db.collection('chapters').doc(chapterId).get();
              if (chapSnap.exists) chapterCache[chapterId] = (chapSnap.data() as any)?.name || '';
            } catch { /* ignore */ }
          }
          assigneeChapter = chapterCache[chapterId] || null;
        }
        return {
          id: uid,
          name: uData?.displayName || uData?.email || uid || 'Unknown',
          photoURL: uData?.photoURL || uData?.profileImageUrl || null,
          role: uData?.role || null,
          chapterName: assigneeChapter,
        };
      } catch {
        return { id: uid, name: uid || 'Unknown', photoURL: null, role: null, chapterName: null };
      }
    }));
    return NextResponse.json({ ok: true, step: { ...afterData, assignees } });
  } catch (e: any) {
    return NextResponse.json({ error: 'Internal Server Error', details: e?.message ?? String(e) }, { status: 500 });
  }
}