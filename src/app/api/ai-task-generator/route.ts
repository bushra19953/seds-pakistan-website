import { NextRequest, NextResponse } from 'next/server';
import { executeWithFailover } from '@/lib/ai/key-manager';
import { admin, ensureAdminInitialized } from '@/lib/server/firebase-admin';

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
  subordinates: any[];
  roleDefinitions: any[];
  apiKey?: string;
  model?: string;
}

interface WorkflowStep {
  title: string;
  description: string;
  assigneeUid: string;
  points: number;
  reason: string;
}

interface AIOrchestrationResponse {
  missionTitle: string;
  steps: WorkflowStep[];
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
  Your goal is to break down a complex space project task into 2-5 actionable mission steps and assign them to the BEST fit team members based on their roles and current workload.

  INPUTS PROVIDED:
  1. Task Briefing: The goal of the mission.
  2. Point Budget: ${totalPoints} PTS (You MUST distribute EXACTLY this amount across all steps).
  3. Team Registry: List of AUTHORIZED team members with their current roles and active task counts.
  4. Role Definitions: Descriptions of what each system role is responsible for.

  ORCHESTRATION RULES:
  - MEMBERSHIP: You MUST ONLY assign tasks to people listed in the "Team Registry". Do NOT suggest people not in the list.
  - MATCHING: Analyze the "Role Definitions". Match the step requirements to the "current role" of users in the "Team Registry".
  - SELECTION: You MUST use the exact "uid" from the Registry for the "assigneeUid" field.
  - POINTS: The sum of "points" for all steps MUST equal EXACTLY ${totalPoints}.
  - REASONING: Explain WHY this specific team member was chosen based on their role and workload.
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
        "assigneeUid": "string",
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
          // Correct the last step if there's a minor rounding/math error by AI
          parsed.steps[parsed.steps.length - 1].points = (parsed.steps[parsed.steps.length - 1].points || 0) + (totalPoints - sum);
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
    const { prompt, totalPoints, subordinates, roleDefinitions, apiKey, model } = body;

    if (!prompt) return NextResponse.json({ error: 'Prompt required' }, { status: 400 });
    if (!totalPoints) return NextResponse.json({ error: 'Total points required' }, { status: 400 });

    const orchestration = await orchestrateMission(prompt, totalPoints, subordinates, roleDefinitions, apiKey, model);

    return NextResponse.json({
      success: true,
      orchestration,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ Mission Orchestration failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
