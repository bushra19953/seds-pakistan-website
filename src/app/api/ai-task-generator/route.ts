import { NextRequest, NextResponse } from 'next/server';
import { executeWithFailover } from '@/lib/ai/key-manager';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

/**
 * Verify the caller's Firebase ID token. The AI orchestrator consumes the
 * server fallback Gemini key, so unauthenticated callers must not reach it.
 */
async function authenticate(request: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  if (!ensureAdminInitialized()) {
    return { error: NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 }) };
  }
  const h = request.headers.get('authorization') || request.headers.get('Authorization');
  let token: string | undefined;
  if (h && h.startsWith('Bearer ')) token = h.substring('Bearer '.length).trim();
  if (!token) token = request.cookies.get('__session')?.value;
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid };
  } catch {
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token' }, { status: 401 }) };
  }
}

/**
 * 🛡️ MISSION COMMAND AI ORCHESTRATOR
 * Upgraded to support intelligent role-based matching and workload balancing.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface AIRequestBody {
  prompt: string;
  totalPoints: number;
  // Legacy: previously client-built. Now ignored; the server builds the
  // registry itself. Kept in the type so old callers do not break.
  subordinates?: any[];
  roleDefinitions?: any[];
  chapterId?: string;
  apiKey?: string;
  model?: string;
}

interface WorkflowStep {
  title: string;
  description: string;
  // Functional role title for this step (e.g. 'Lead Message Auditor & Copy Specialist').
  role?: string;
  assigneeUid: string;
  // Everyone assigned to the step, doer first. The server validates every
  // uid against the team registry; invalid entries are dropped and reported.
  // Legacy consumers read assigneeUid (always the first entry) as before.
  assigneeUids?: string[];
  points: number;
  reason: string;
}

interface AIOrchestrationResponse {
  missionTitle: string;
  steps: WorkflowStep[];
}

interface RegistryUser {
  uid: string;
  name: string;
  role: string;
}

interface RegistryRoleDef {
  role: string;
  description: string;
}

interface TeamRegistry {
  subordinates: RegistryUser[];
  roleDefinitions: RegistryRoleDef[];
  rolesByUid: Map<string, string>;
}

/**
 * Build the team registry server-side with the Admin SDK so the AI always
 * assigns from fresh, authoritative role data. The client-sent arrays are
 * never trusted (stale snapshots, or a tampered client, would otherwise
 * steer assignments). Roles come from the `roles` collection first with
 * `users/{uid}.role` as fallback, mirroring the client filter: empty,
 * 'member' and 'none' roles are excluded.
 */
async function buildTeamRegistry(chapterId?: string): Promise<TeamRegistry> {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');

  const [rolesSnap, usersSnap, defsSnap] = await Promise.all([
    db.collection('roles').get(),
    db.collection('users').get(),
    db.collection('roleDefinitions').get(),
  ]);

  const rolesByUid = new Map<string, string>();
  rolesSnap.forEach((d) => {
    const r = d.data()?.role;
    if (typeof r === 'string' && r.trim()) rolesByUid.set(d.id, r.trim().toLowerCase());
  });

  const subordinates: RegistryUser[] = [];
  usersSnap.forEach((d) => {
    const data = d.data() || {};
    const fallback = typeof data.role === 'string' ? data.role.trim().toLowerCase() : '';
    const role = rolesByUid.get(d.id) || fallback;
    if (!role || role === 'member' || role === 'none') return;
    if (chapterId && typeof data.chapterId === 'string' && data.chapterId && data.chapterId !== chapterId) return;
    const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const email = typeof data.email === 'string' ? data.email : '';
    subordinates.push({ uid: d.id, name: displayName || email || d.id, role });
  });

  const roleDefinitions: RegistryRoleDef[] = [];
  defsSnap.forEach((d) => {
    const data = d.data() || {};
    const raw = data.description ?? data.responsibilities ?? '';
    roleDefinitions.push({ role: d.id, description: typeof raw === 'string' ? raw : '' });
  });

  return { subordinates, roleDefinitions, rolesByUid };
}

interface DroppedAssignee {
  stepIndex: number;
  stepTitle: string;
  assigneeUid: string;
  reason: string;
}

/**
 * Resolve the caller's role the same way the registry resolves subordinate
 * roles: roles/{uid}.role first, users/{uid}.role as fallback. A missing role
 * everywhere resolves to '' so the permission gate denies safely.
 */
async function resolveCallerRole(uid: string, rolesByUid: Map<string, string>): Promise<string> {
  const fromRoles = rolesByUid.get(uid);
  if (fromRoles) return fromRoles;
  try {
    const db = getDb();
    if (!db) return '';
    const snap = await db.collection('users').doc(uid).get();
    const r = snap.data()?.role;
    return typeof r === 'string' ? r.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Enforce the MEMBERSHIP rule for real: drop any step assignee that is not
 * in the authoritative registry (hallucinated, empty, or since-removed uid).
 * Never throws; callers report the drops instead of failing the request.
 */
function sanitizeAssignees(steps: any[], registryUidSet: Set<string>): DroppedAssignee[] {
  const dropped: DroppedAssignee[] = [];
  steps.forEach((step, idx) => {
    // Collect every candidate uid: the array form first, then the singular
    // form, so the doer stays at index 0 when both are present.
    const rawList: unknown[] = Array.isArray(step.assigneeUids)
      ? [...step.assigneeUids]
      : [];
    if (typeof step.assigneeUid === 'string' && step.assigneeUid.trim()) {
      rawList.unshift(step.assigneeUid.trim());
    }
    const seen = new Set<string>();
    const valid: string[] = [];
    rawList.forEach((entry) => {
      const uid = typeof entry === 'string' ? entry.trim() : '';
      if (!uid || seen.has(uid)) return;
      seen.add(uid);
      if (!registryUidSet.has(uid)) {
        dropped.push({
          stepIndex: idx,
          stepTitle: typeof step.title === 'string' ? step.title : '',
          assigneeUid: uid,
          reason: 'assigneeUid not in team registry',
        });
        return;
      }
      valid.push(uid);
    });
    // The singular field always carries the primary (doer) uid so legacy
    // consumers keep working; the array carries everyone for multi-assignee
    // persistence (mapped to assigneeIds by the task creation path).
    step.assigneeUid = valid[0] || '';
    step.assigneeUids = valid;
    if (!valid.length) {
      dropped.push({
        stepIndex: idx,
        stepTitle: typeof step.title === 'string' ? step.title : '',
        assigneeUid: '',
        reason: 'empty assigneeUid',
      });
    }
  });
  return dropped;
}

async function orchestrateMission(
  prompt: string, 
  totalPoints: number, 
  subordinates: any[], 
  roleDefinitions: any[], 
  apiKey?: string, 
  modelName?: string
): Promise<AIOrchestrationResponse> {
  const finalModel = (modelName && modelName.trim()) || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  
  console.log(`[AI Orchestrator] Using model: ${finalModel}, Key provided: ${!!apiKey}`);

  const systemInstruction = `You are the Mission Command Orchestrator for SEDS Pakistan.
  Your goal is to break down a complex space project task into 2-5 actionable mission steps and assign them to the BEST fit team members based on their roles.

  INPUTS PROVIDED:
  1. Task Briefing: The goal of the mission.
  2. Point Budget: ${totalPoints} PTS (You MUST distribute EXACTLY this amount across all steps).
  3. Team Registry: List of AUTHORIZED team members with their current roles.
  4. Role Definitions: Descriptions of what each system role is responsible for.

  ORCHESTRATION RULES:
  - MEMBERSHIP: You MUST ONLY assign tasks to people listed in the "Team Registry". Do NOT suggest people not in the list.
  - MATCHING (doer-first): For each step, identify the HANDS-ON deliverable (design, print, write, build, deliver), then pick the registry member whose role DOES that work day-to-day. Prefer doer roles (designers, engineers, team leads) over coordinator roles (general_secretary, projects_director, vice_president). A coordinator is the right assignee ONLY when the step itself is coordination (scheduling, approvals, cross-team liaison) or when no doer in the registry can perform it. Never default to a coordinator just because their role description sounds broad.
  - LEADERSHIP (named leaders are participants, not background): When the briefing names a specific leader (President, Vice President, Patron, Dean, Director, ORIC head) with verbs like "collaborate with", "verify with", "sign-off by", or "deliver to", do NOT substitute a coordinator as their proxy. If that leader is in the Team Registry, assign them the step (or a dedicated step) that needs their authority. If they are NOT in the registry, name them explicitly in that step's VERIFICATION section as a required human checkpoint, and assign the step to the doer who must obtain the sign-off.
  - SELECTION: You MUST use the exact "uid" from the Registry for the "assigneeUid" field.
  - ROLE: Give each step a short functional "role" title naming the assignee's designation for that step (for example "Lead Message Auditor & Copy Specialist"). This is the step designation shown on the mission directive, distinct from the member's org role.
  - OVERSIGHT: When the briefing names a leader who must stay in the loop on a step without doing the hands-on work (for example a VP tracking execution), put the doer's uid in "assigneeUid" AND list every assigned uid in "assigneeUids" with the doer first. The first entry of "assigneeUids" MUST equal "assigneeUid". Omit "assigneeUids" when a step has a single assignee.
  - POINTS: The sum of "points" for all steps MUST equal EXACTLY ${totalPoints}.
  - REASONING: Explain WHY this specific team member was chosen by naming the concrete deliverable-to-role match (for example "typesetting 4 print pages maps to chair_design"). Generic praise such as "strategic acumen" or "logistical expertise" without a deliverable match is NOT an acceptable reason.
  - ROLE: Every step MUST include a "role" field: a short functional designation describing the assignee's job on that step (for example "Lead Message Auditor & Copy Specialist"). Derive it from the step's hands-on deliverable, not from the member's registry role title.
  - DETAIL: Each step "description" MUST be a comprehensive execution guide (150-300 words) including:
    * WHAT: Clear deliverable definition — exactly what must be produced
    * HOW: Step-by-step execution instructions the assignee can follow
    * STANDARDS: Quality criteria, technical specs, or acceptance criteria
    * RESOURCES: What materials, tools, or references to use
    * VERIFICATION: How completion will be verified
    Write for someone who has never done this task before. Be specific, not generic.

  JSON SCHEMA (Return ONLY this):
  {
    "missionTitle": "string",
    "steps": [
      {
        "title": "string",
        "description": "string (150-300 words: WHAT, HOW, STANDARDS, RESOURCES, VERIFICATION)",
        "role": "string (functional role title for this step, e.g. 'Lead Message Auditor & Copy Specialist')",
        "assigneeUid": "string",
        "assigneeUids": ["string (optional, doer first; first entry equals assigneeUid)"],
        "role": "string (short functional designation for the assignee's job on this step, e.g. Lead Message Auditor & Copy Specialist)",
        "points": number,
        "reason": "string"
      }
    ]
  }`;

  return await executeWithFailover(async (genAI) => {
    const model = genAI.getGenerativeModel({ 
      model: finalModel,
      systemInstruction
    });

    const userPrompt = `
MISSION BRIEFING: ${prompt}
POINT BUDGET: ${totalPoints} PTS

TEAM REGISTRY:
${JSON.stringify(subordinates, null, 2)}

ROLE DEFINITIONS:
${JSON.stringify(roleDefinitions, null, 2)}

Return the orchestrated mission plan in the JSON schema requested.`;

    const result = await model.generateContent(userPrompt);
    const response = result.response;
    const text = response.text();
    
    console.log('[AI Orchestrator] Raw response:', text);

    let jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();

    // Robust JSON extraction
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1) {
        jsonString = jsonString.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonString);
    
    // Final validation of points
    if (parsed.steps && Array.isArray(parsed.steps)) {
      const sum = parsed.steps.reduce((s: number, step: any) => s + (Number(step.points) || 0), 0);
      if (sum !== totalPoints && parsed.steps.length > 0) {
          // Correct the last step if there's a minor rounding/math error by AI.
          // Coerce to Number first: a string value would concatenate ("20" + 20 = "2020").
          const lastStep = parsed.steps[parsed.steps.length - 1];
          lastStep.points = (Number(lastStep.points) || 0) + (totalPoints - sum);
      }
    } else {
      throw new Error('AI returned invalid mission steps structure');
    }
    
    return parsed;
  }, apiKey);
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    if ('error' in auth) return auth.error;

    const body: AIRequestBody = await request.json();
    const { prompt, totalPoints, apiKey, model, chapterId } = body;

    if (!prompt) return NextResponse.json({ error: 'Prompt required' }, { status: 400 });
    if (!totalPoints) return NextResponse.json({ error: 'Total points required' }, { status: 400 });

    // Build the team registry server-side from fresh Firestore data. The
    // client-sent subordinates/roleDefinitions arrays are ignored entirely:
    // they may be stale snapshots or tampered with. Fail closed if the
    // registry cannot be built, assigning from a stale pool is worse.
    let registry: TeamRegistry;
    try {
      // chapterId 'none' means no chapter filter (matches the old client behavior)
      const chapterFilter = typeof chapterId === 'string' && chapterId !== 'none' ? chapterId : undefined;
      registry = await buildTeamRegistry(chapterFilter);
    } catch (e: any) {
      console.error('[AI Orchestrator] Team registry build failed:', e);
      return NextResponse.json({ error: 'Could not build team registry' }, { status: 500 });
    }

    // Permission gate: generating assignments consumes the server Gemini key,
    // so callers need task-management permission, not just any login. Resolve
    // the caller's role the same way the registry does: roles collection
    // first, users/{uid}.role as fallback.
    const callerRole = await resolveCallerRole(auth.uid, registry.rolesByUid);
    if (!(await hasServerPermission(callerRole, 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    const orchestration = await orchestrateMission(
      prompt,
      totalPoints,
      registry.subordinates,
      registry.roleDefinitions,
      apiKey,
      model
    );

    // Enforce MEMBERSHIP for real: drop hallucinated/empty uids instead of
    // trusting the model. Reported, never fatal.
    const droppedAssignees = sanitizeAssignees(
      orchestration.steps,
      new Set(registry.subordinates.map((u) => u.uid))
    );

    return NextResponse.json({
      success: true,
      orchestration,
      droppedAssignees,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ Mission Orchestration failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
