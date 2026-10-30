import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { calculateWorkflowDeadlines } from '@/lib/workflow-utils';
import { isStepWorkDone, isStepApproved, computeWorkflowProgress } from '@/lib/workflow-progress';
import { fetchWorkflowDetailReadsViaSupa, listAllWorkflowTasksViaSupa } from '@/lib/server/workflow-detail-supa';
import { mirrorWorkflowTaskDocById, mirrorWorkflowMemberDocById } from '@/lib/server/workflow-write-mirror';
import { validateUserStatus } from '@/lib/server/user-status';
import { HOUSE_POINTS_DEFAULTS } from '@/lib/task-form-rules';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { format } from 'date-fns';
import { sendEmailNotification } from '@/lib/mailer';
import {
  createNotificationPrimaryFirst,
  mirrorNotificationCreate,
  userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';
import { resolveUserEmail, getUserContacts, stripContactFields } from '@/lib/server/user-contact';

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
  isLimitingStep: z.boolean().optional(),
  workflowTags: z.array(z.string()).optional(),
  workflowPriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  points: z.number().optional(), // NEW: Accept explicit points
  stepSpecificBadgeId: z.string().optional(),
  reviewerId: z.string().nullish().optional(), // per-step named reviewer override
  individualDeadline: z.union([z.string(), z.number(), z.date()]).optional(),
  // NEW: Location and availability metadata so field work is never assigned blind
  locationRequirement: z.enum(['on-site', 'remote', 'either']).optional(),
  locationNote: z.string().max(500).optional(),
  availabilityStatus: z.enum(['confirmed', 'unknown', 'unavailable']).optional(),
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
  reviewerId: z.string().nullish().optional(), // workflow-level named reviewer, stamped on every step
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
    if (!(await hasServerPermissionForUser(db, decoded.uid, 'canManageTasks'))) {
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
    // backward-compatible readers. The primary is UNIONED with
    // assigneeIds, never replaced by it (UX program F4 / audit P8:
    // the old either/or expression dropped — and via assigneeIds[0],
    // replaced — the primary whenever co-assignees were present).
    const stepAssigneeIdsOf = (step: any): string[] => {
      const coAssignees = Array.isArray(step.assigneeIds) ? step.assigneeIds : [];
      const raw = [step.assigneeId, ...coAssignees];
      return Array.from(new Set(raw.map((v: any) => String(v)).filter(Boolean)));
    };

    const deadlines = calculateWorkflowDeadlines(finalDeadline, data.steps);
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
          const userName = userDoc.data()?.displayName || aid;

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

    // Creator display name for the per-assignee assignment notifications
    // below (mirrors POST /api/tasks). Taken from the verified token's
    // name claim, NEVER from a fresh users/{creator} read: the auth +
    // permission check above already spent this route's identity read
    // budget (Read-Burn section 2.6 pins POST /api/workflows at 2 cold
    // identity doc reads for the caller, and the identity bundle the
    // permission check loads projects no displayName out of its
    // users/{uid} read), so a third read here broke the pinned T-A1
    // read-count test. Fallbacks: token email, then a neutral label.
    const creatorName =
      (typeof decoded.name === 'string' && decoded.name.trim() ? decoded.name : null)
      || decoded.email
      || 'Your Manager';

    const created: Array<{ id: string; assigneeId: string; sequenceIndex: number }> = [];
    const fanOutJobs: Array<{ aid: string; stepTitle: string; taskId: string; individualDeadline: Date | null }> = [];

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

      // NAMED REVIEWER for this step: the per-step override wins over
      // the workflow-level reviewer. reviewerIds is the array form of
      // the same designation; the two stamps are always written
      // together (empty array when nobody was named).
      const stepReviewerId =
        (typeof step.reviewerId === 'string' && step.reviewerId) ||
        (typeof data.reviewerId === 'string' && data.reviewerId) ||
        null;

      const taskDoc: any = {
        title: step.title,
        description: step.description,
        assignerId: decoded.uid,
        assigneeId: stepAssigneeIds[0],
        assigneeIds: stepAssigneeIds,
        workflowId: data.workflowId,
        workflowTitle: data.workflowTitle,
        workflowParticipantIds: wfParticipantIds,
        // NAMED REVIEWER: stamped on every step doc (per-step override
        // wins over the workflow-level reviewer) so the validation door
        // and review queue read the canonical uid fields, not
        // description text. reviewerId is null when nobody was named,
        // matching the other optional stamps on this doc.
        reviewerId: stepReviewerId,
        reviewerIds: stepReviewerId ? [stepReviewerId] : [],
        sequenceIndex: i,
        role: step.role || null,
        releasedAt: isCurrentStep ? admin.firestore.FieldValue.serverTimestamp() : null,
        deadline: finalDeadline,
        individualDeadline,
        isCurrentStep,
        status: 'pending',
        points: stepPoints, // FIXED: Meaningful points instead of 0
        penaltyPoints: typeof data.penaltyPoints === 'number' ? data.penaltyPoints : HOUSE_POINTS_DEFAULTS.penalty,
        workflowBonusPoints: typeof data.workflowBonusPoints === 'number' ? data.workflowBonusPoints : HOUSE_POINTS_DEFAULTS.bonus,
        guidance: data.guidance || null,
        projectId: data.projectId || null,
        chapterId: data.chapterId || null, // SAVING CHAPTER ID
        workflowPriority: step.workflowPriority || null,
        workflowTags: step.workflowTags || [],
        estimatedDuration: step.estimatedDuration || null,
        isLimitingStep: step.isLimitingStep || null,
        stepSpecificBadgeId: step.stepSpecificBadgeId || null,
        // Location/availability metadata: persist validated values, null when absent.
        locationRequirement: step.locationRequirement || null,
        locationNote: step.locationNote?.trim() || null,
        availabilityStatus: step.availabilityStatus || null,
        finalWorkflowCompletionBadgeId: data.finalWorkflowCompletionBadgeId || null,
        resources: [...(data.resources || []), ...(step.resources || [])], // Merge global + step resources
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // ACCEPTANCE HANDSHAKE: every assigned task starts unacknowledged.
        acceptanceStatus: 'pending-acceptance',
        acceptedAt: null,
        acceptedBy: null,
      };
      const docRef = db.collection('tasks').doc();
      await docRef.set(taskDoc);
      // MIRROR (workflows surface): the detail/public/PDF readers
      // read step tasks from the Supabase mirror under the
      // 'workflows' flag; a Firestore-only create is invisible
      // there. Never throws; flag OFF = no-op, no extra reads.
      await mirrorWorkflowTaskDocById(docRef.id, async () => (await docRef.get()).data());
      created.push({ id: docRef.id, assigneeId: stepAssigneeIds[0], sequenceIndex: i });
      // Every assignee (doer and oversight) gets their assignment counters.
      for (const aid of stepAssigneeIds) {
        await db.collection('users').doc(aid).set({
          tasksAssignedCount: admin.firestore.FieldValue.increment(1),
          lastTaskAssignedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      // Assignment fan-out is deferred: collect a job per assignee here
      // and dispatch it in the background after all steps and members
      // have persisted (see dispatchAssignmentFanOut below).
      for (const aid of stepAssigneeIds) {
        if (aid !== decoded.uid) {
          fanOutJobs.push({ aid, stepTitle: step.title, taskId: docRef.id, individualDeadline });
        }
      }
    }

    // Ensure workflow members exist
    const allParticipants = new Set([decoded.uid, ...wfParticipantIds]);
    const memberBatch = db.batch();
    const memberRefs: Array<{ memberId: string; memberRef: FirebaseFirestore.DocumentReference }> = [];
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
      memberRefs.push({ memberId, memberRef });
      hasMemberUpdates = true;
    }
    if (hasMemberUpdates) {
      await memberBatch.commit();
      // MIRROR (workflows surface): the detail seam reads the
      // viewer's workflow_members doc from the mirror for its
      // contact-masking gate. Never throws; flag OFF = no-op.
      for (const { memberId, memberRef } of memberRefs) {
        await mirrorWorkflowMemberDocById(memberId, async () => (await memberRef.get()).data());
      }
    }

    const finalDeadlineDate: Date = finalDeadline;

    // Persistence must complete before any fan-out starts; fan-out is background so a slow notification/email layer can never truncate a workflow again (incident 2026-10-28, wf_1793206249841_2uw71r).
    const dispatchAssignmentFanOut = async () => {
      // ASSIGNMENT FAN-OUT: in-app notification + task_assigned email for
      // every assignee, mirroring POST /api/tasks and /api/tasks/delegate.
      // Workflow creation was the one assignment path that notified nobody:
      // step assignees received a task doc and counters only, so no email
      // was ever attempted (and no email_logs row written) for the standard
      // workflow-plan delegation flow. Non-blocking by design: a
      // notification failure never fails workflow creation.
      for (const job of fanOutJobs) {
        const { aid, stepTitle, taskId, individualDeadline } = job;
        try {
          const assigneeDoc = await db.collection('users').doc(aid).get();
          const assigneeData = assigneeDoc.data();
          const taskLink = `/profile/unified?uid=${aid}&task=${taskId}`;
          const notifRef = db.collection('users').doc(aid).collection('notifications').doc();
          const notifData = {
            type: 'task_assigned',
            title: 'New Task Assigned',
            body: `You have been assigned: "${stepTitle}"`,
            link: taskLink,
            taskId,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          };
          // Notifications residual #2 (DEPLOY_READY_REPORT): this write
          // was the one notification writer still inline in this route,
          // invisible to the Supa read path when 'notifications' flips.
          // It now goes through the notifications seam like every other
          // notification writer (tasks route, gamification transaction,
          // notification-helper/service): the owning surface is
          // 'notifications', NOT this route's 'workflows' surface.
          // Dual-write (default, incl. flag OFF — byte-identical):
          // Firestore set first, then the non-throwing seam mirror.
          // Primacy (isSupaPrimary('notifications')): the seam writes
          // the adapter FIRST (a failure throws into the fan-out catch
          // below, exactly as a Firestore set failure does today, so
          // the email is skipped and workflow creation still succeeds),
          // and the Firestore set then runs as the post-commit mirror,
          // best-effort. Payload, ordering relative to the email below,
          // and the non-blocking failure semantics are unchanged in
          // every mode.
          const wrotePrimary = await createNotificationPrimaryFirst(
            userNotificationsPath(aid),
            notifRef.id,
            notifData,
          );
          if (wrotePrimary) {
            try {
              await notifRef.set(notifData);
            } catch (mirrorErr) {
              console.warn(`[workflows:POST] Firestore mirror set failed for notification ${notifRef.id} after primary commit (non-blocking):`, mirrorErr);
            }
          } else {
            await notifRef.set(notifData);
            await mirrorNotificationCreate(userNotificationsPath(aid), notifRef.id, notifData);
          }
          const assigneeEmail = (await resolveUserEmail(db, aid)) || '';
          if (assigneeEmail) {
            sendEmailNotification(assigneeEmail, 'task_assigned', {
              recipientName: assigneeData?.displayName || assigneeEmail,
              taskTitle: stepTitle,
              taskLink,
              actorName: creatorName,
              dueDate: individualDeadline ? format(individualDeadline, 'MMM dd, yyyy') : undefined,
            }).catch((e) => console.warn(`[workflows:POST] Email failed for ${assigneeEmail}:`, e));
          }
        } catch (notifyErr) {
          console.warn(`[workflows:POST] Assignment notification failed for ${aid}:`, notifyErr);
        }
      }

      // NAMED REVIEWER: exactly one designation email per workflow
      // creation, naming the workflow, the reviewer role, and the
      // mission link. Guarded on the field's presence so creations
      // without a reviewer spend no extra reads (the route's read
      // budget is pinned). A blank profile email skips silently and a
      // mail failure never fails creation, matching the assignee
      // fan-out above. Per-step overrides do not multiply this email.
      const workflowReviewerId =
        typeof data.reviewerId === 'string' && data.reviewerId ? data.reviewerId : '';
      if (workflowReviewerId && workflowReviewerId !== decoded.uid) {
        try {
          const reviewerDoc = await db.collection('users').doc(workflowReviewerId).get();
          const reviewerData = reviewerDoc.data();
          const reviewerEmail = reviewerData?.email || '';
          if (reviewerEmail) {
            sendEmailNotification(reviewerEmail, 'task_reviewer_assigned', {
              recipientName: reviewerData?.displayName || reviewerEmail,
              taskTitle: data.workflowTitle,
              taskLink: `/missions/${data.workflowId}`,
              actorName: creatorName,
              dueDate: format(finalDeadlineDate, 'MMM dd, yyyy'),
            }).catch((e) => console.warn(`[workflows:POST] Reviewer email failed for ${reviewerEmail}:`, e));
          }
        } catch (reviewerErr) {
          console.warn('[workflows:POST] Reviewer designation email failed (non-blocking):', reviewerErr);
        }
      }
    };

    void dispatchAssignmentFanOut().catch((e) => console.error('[workflows:POST] Background assignment fan-out failed:', e));

    return NextResponse.json({ ok: true, created, createdCount: created.length, stepsRequested: data.steps.length });
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
      // Aggregate all distinct workflows from tasks collection.
      // READ-BLEED FIX (census 06 #1): this branch used to read every
      // workflow step doc from Firestore on every Missions-tab mount
      // (~100 reads/call, no seam, no limit). It now goes through the
      // workflows list seam over fs_tasks first (gated on
      // useSupa('workflows'), ON live); the Firestore query below is
      // only the flag-off / adapter-failure fallback and is BOUNDED:
      // the tasks corpus is ~113 docs total (Oct 2026 parity count),
      // so limit(1000) never truncates the displayed list at any
      // plausible scale while capping a runaway scan at 1,000 reads.
      const supaListSnap = await listAllWorkflowTasksViaSupa();
      const tasksSnap: { docs: Array<{ id: string; data: () => any }> } = supaListSnap ?? await db.collection('tasks')
        .where('workflowId', '!=', null)
        .orderBy('workflowId')
        .limit(1000)
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
        approvedSteps: number;
        participants: Set<string>;
        createdAt: string | null;
        updatedAt: string | null;
        overdueCount: number;
        currentStepIndex: number;
        deadline: string | null;
        deadlineFromFirstStep: boolean;
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
            approvedSteps: 0,
            participants: new Set(),
            createdAt: serializeTs(data.createdAt),
            updatedAt: serializeTs(data.updatedAt),
            overdueCount: 0,
            currentStepIndex: 0,
            deadline: null,
            deadlineFromFirstStep: false,
          });
        }

        const wf = workflowMap.get(wfId)!;
        wf.totalSteps += 1;
        if (isStepWorkDone(data.status)) wf.completedSteps += 1;
        if (isStepApproved(data.status)) wf.approvedSteps += 1;
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
        // The workflow deadline is denormalized onto every step doc as
        // `deadline` (the public mission page header prints the first
        // step's). Prefer the sequence-0 step's value so the list agrees
        // with the public page; fall back to the first value seen.
        const wfDeadline = serializeTs(data.deadline) || serializeTs(data.individualDeadline);
        if (wfDeadline) {
          if ((data.sequenceIndex || 0) === 0) {
            wf.deadline = wfDeadline;
            wf.deadlineFromFirstStep = true;
          } else if (!wf.deadline && !wf.deadlineFromFirstStep) {
            wf.deadline = wfDeadline;
          }
        }
      });

      const workflows = Array.from(workflowMap.values()).map(wf => ({
        id: wf.id,
        title: wf.title,
        deadline: wf.deadline,
        totalSteps: wf.totalSteps,
        completedSteps: wf.completedSteps,
        currentStepIndex: wf.currentStepIndex,
        progressPercentage: wf.totalSteps ? Math.round((wf.completedSteps / wf.totalSteps) * 100) : 0,
        isCompleted: wf.totalSteps > 0 && wf.approvedSteps === wf.totalSteps,
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
      const viewerCanManage = await hasServerPermissionForUser(db, viewerUid, 'canManageWorkflows')
        || await hasServerPermissionForUser(db, viewerUid, 'canManageTasks');
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
    const supaReads = await fetchWorkflowDetailReadsViaSupa(workflowId, decoded.uid);
    const snap = supaReads ? supaReads.tasksSnap : await db.collection('tasks').where('workflowId', '==', workflowId).get();
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
    const assigneeInfo: Record<string, { name: string; photoURL?: string; position?: string; role?: string; whatsapp?: string | null; email?: string | null; chapterName?: string }> = {};

    // NEW: Get chapter name if available
    let chapterName: string | null = null;
    const firstTaskWithChapter = tasks.find(t => !!t.chapterId);
    if (firstTaskWithChapter?.chapterId) {
      try {
        const chapSnap = supaReads ? supaReads.workflowChapterSnap! : await db.collection('chapters').doc(firstTaskWithChapter.chapterId).get();
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
        const userSnapshots = supaReads ? supaReads.userSnaps : await Promise.all(
          uniqueAssigneeIds.map(uid => db.collection('users').doc(uid).get())
        );

        const assigneeContacts = await getUserContacts(db, uniqueAssigneeIds);
        // Process results - fetch chapter names for users with chapterId
        const chapterCache: Record<string, string> = {};
        for (const doc of userSnapshots) {
          if (doc.exists) {
            const userData = stripContactFields(doc.data() as any);
            let chapterName: string | null = userData?.chapterName || null;
            // Look up chapter name from chapterId if not directly stored
            const chapterId = userData?.chapterId;
            if (!chapterName && chapterId) {
              if (!chapterCache[chapterId]) {
                try {
                  const chapSnap = supaReads ? supaReads.userChapterSnaps[chapterId] : await db.collection('chapters').doc(chapterId).get();
                  if (chapSnap.exists) {
                    chapterCache[chapterId] = (chapSnap.data() as any)?.name || '';
                  }
                } catch { /* ignore */ }
              }
              chapterName = chapterCache[chapterId] || null;
            }
            assigneeInfo[doc.id] = {
              name: userData?.displayName || doc.id,
              photoURL: userData?.photoURL || userData?.profileImageUrl || null,
              position: userData?.position || userData?.title || null,
              role: userData?.role || null,
              whatsapp: assigneeContacts.get(doc.id)?.whatsapp || assigneeContacts.get(doc.id)?.whatsappNumber || null,
              email: assigneeContacts.get(doc.id)?.email || null,
              chapterName: chapterName ?? undefined,
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
    const roleSnap = supaReads ? supaReads.roleSnap : await db.collection('roles').doc(decoded.uid).get().catch(() => null);
    const liveRole = roleSnap && roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
    const userRole = String(liveRole || decoded.role || '').toLowerCase();
    const isAdmin = userRole === 'founder_patron' || userRole === 'superadmin' || userRole.includes('president') || userRole.includes('admin');
    const isParticipant = uniqueAssigneeIds.includes(decoded.uid);

    // Check if user is a member of the workflow
    const memberId = `${workflowId}_${decoded.uid}`;
    const memberDoc = supaReads ? supaReads.memberSnap : await db.collection('workflow_members').doc(memberId).get();
    const isWorkflowMember = memberDoc.exists;

    const canViewContact = isAdmin || isParticipant || isWorkflowMember;

    if (!canViewContact) {
      tasksWithNames.forEach(t => {
        t.assigneeWhatsapp = null;
        t.assigneeEmail = null;
      });
      for (const info of Object.values(assigneeInfo)) {
        info.whatsapp = null as any;
        info.email = null as any;
      }
    }

    const totalSteps = tasksWithNames.length;
    const { completedSteps, isCompleted: allApproved } = computeWorkflowProgress(tasksWithNames.map(t => String(t.status)));
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
    const progress = { workflowId, totalSteps, completedSteps, currentStepIndex: currentIndex, progressPercentage, isCompleted: allApproved };

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
    if (!(await hasServerPermissionForUser(db, decoded.uid, 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    // Discipline (spec E.4.8): workflow step actions are a privilege; a
    // member under a Strike 2 suspension may not perform them.
    {
      const { suspensionBlock } = await import('@/lib/server/discipline/suspension');
      const block = await suspensionBlock(db, decoded.uid, new Date());
      if (block) {
        return NextResponse.json(block, { status: 403 });
      }
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

    // The step's assignee set, in the same canonical shape POST uses at
    // creation: the primary unioned with assigneeIds, deduped.
    const stepAssigneesOf = (data: any): string[] => {
      const raw = [data?.assigneeId, ...(Array.isArray(data?.assigneeIds) ? data.assigneeIds : [])];
      return Array.from(new Set(raw.map((v: any) => String(v)).filter(Boolean)));
    };
    const afterData = { ...(d.data() as any), ...updatesToApply };
    const beforeAssignees = new Set(stepAssigneesOf(d.data() as any));
    const afterAssignees = stepAssigneesOf(afterData);
    const assigneeSetChanged =
      beforeAssignees.size !== afterAssignees.length ||
      afterAssignees.some((id) => !beforeAssignees.has(id));

    await d.ref.set({ ...updatesToApply, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    // ROSTER SYNC: workflowParticipantIds on every step doc is the
    // workflow's membership roster, and the /api/tasks reassignment
    // guard judges new assignees against it. A step reassignment used
    // to leave it stale forever (no route rewrote it), so the roster
    // disagreed with the actual step holders. When this update changes
    // the step's assignee set, recompute the roster as the union of
    // every step's assignees and stamp it on every step doc whose
    // roster differs. Best-effort like the mirror below: a hiccup
    // never fails the step update; the outcome is recorded on the
    // audit entry instead.
    let rosterSynced: boolean | null = null;
    if (assigneeSetChanged) {
      rosterSynced = false;
      try {
        const allSteps = await db.collection('tasks').where('workflowId', '==', workflowId).get();
        const ordered = [...allSteps.docs].sort(
          (a, b) => ((a.data() as any)?.sequenceIndex ?? 0) - ((b.data() as any)?.sequenceIndex ?? 0),
        );
        const rosterSet = new Set<string>();
        const stepRefs: Array<{ ref: any; currentKey: string }> = [];
        for (const doc of ordered) {
          const data = doc.id === d.id ? afterData : (doc.data() as any);
          for (const uid of stepAssigneesOf(data)) rosterSet.add(uid);
          const current = Array.isArray((doc.data() as any)?.workflowParticipantIds)
            ? (doc.data() as any).workflowParticipantIds.map((v: any) => String(v)).filter(Boolean)
            : [];
          stepRefs.push({ ref: doc.ref, currentKey: [...current].sort().join('\n') });
        }
        const roster = Array.from(rosterSet);
        const rosterKey = [...roster].sort().join('\n');
        const stale = stepRefs.filter((s) => s.currentKey !== rosterKey);
        for (let i = 0; i < stale.length; i += 400) {
          const batch = db.batch();
          for (const s of stale.slice(i, i + 400)) {
            batch.set(s.ref, { workflowParticipantIds: roster, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          }
          await batch.commit();
        }
        rosterSynced = true;
      } catch (err) {
        console.warn(`[workflows:PATCH] Roster sync failed for workflow ${workflowId} (non-blocking):`, err);
      }
    }

    // MIRROR (workflows surface): a step update is a workflow-owned
    // write; keep the mirror the readers consult in step with it.
    // Never throws; flag OFF = no-op, no extra reads.
    await mirrorWorkflowTaskDocById(d.id, async () => (await d.ref.get()).data());
    await db.collection('workflow_audits').add({
      workflowId,
      sequenceIndex,
      updates: updatesToApply,
      reason: reason || null,
      actorId: decoded.uid,
      ...(rosterSynced !== null ? { rosterSynced } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Return the updated step enriched with resolved assignees[] (same shape as GET).
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
          name: uData?.displayName || uid || 'Unknown',
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