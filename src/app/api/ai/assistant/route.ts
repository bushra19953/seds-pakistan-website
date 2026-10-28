import { NextRequest, NextResponse } from "next/server";
import { executeWithFailover } from "@/lib/ai/key-manager";
import { aiRateLimiter } from "@/lib/rate-limiter";

/**
 * POST /api/ai/assistant
 *
 * Server-side proxy for the floating AI study assistant. Requests reach
 * Gemini through the server pool (GEMINI_API_KEY, GEMINI_API_KEY_1..10),
 * so the browser never holds a raw Gemini key. A per-user key may be
 * supplied in the request body (the product's existing localStorage
 * fallback from Settings / the tasks page); it is used only when it looks
 * like a real key, never echoed back, and never persisted here.
 *
 * Public route (the assistant sits on the public homepage), so input is
 * bounded to keep server-key spend safe: message length capped, history
 * truncated, model choice restricted to the small-flash allowlist.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const DEFAULT_MODEL = "gemini-2.5-flash";
const MODEL_ALLOWLIST = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]);

export const ASSISTANT_SYSTEM_INSTRUCTION =
  "You are the SEDS Pakistan AI Study Assistant, a friendly tutor for space " +
  "science, rocketry, satellite engineering, astronomy, physics, and computer " +
  "science. Explain clearly at an undergraduate level, use concrete examples, " +
  "and correct misconceptions directly. Answer in the language the learner " +
  "uses: if they write in Urdu, answer in Urdu; otherwise answer in English. " +
  "For study guides, structure the answer as: 1) a short summary, " +
  "2) key points, 3) five flashcards (question and answer pairs), " +
  "4) a three-question quiz with an answer key. Keep answers focused and " +
  "self-contained; do not invent SEDS internal facts.";

interface ChatTurn {
  role: string;
  content?: string;
  text?: string;
}

interface AssistantRequestBody {
  message?: string;
  topic?: string;
  prompt?: string;
  history?: ChatTurn[];
  apiKey?: string;
  model?: string;
}

/** True when at least one server Gemini key env var is set (names only, never values). */
export function hasServerKey(): boolean {
  if (process.env.GEMINI_API_KEY?.trim()) return true;
  for (let i = 1; i <= 10; i++) {
    if (process.env[`GEMINI_API_KEY_${i}`]?.trim()) return true;
  }
  return false;
}

/** Map a client turn to a transcript line for the prompt. */
function turnToLine(turn: ChatTurn): string | null {
  const raw = typeof turn.content === "string" ? turn.content : turn.text;
  if (!raw || !raw.trim()) return null;
  const role = turn.role === "assistant" || turn.role === "model" ? "Assistant" : "User";
  return `${role}: ${raw.trim().slice(0, MAX_MESSAGE_CHARS)}`;
}

export function buildAssistantPrompt(body: AssistantRequestBody): {
  prompt: string;
  model: string;
} {
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim()
    : typeof body.prompt === "string" ? body.prompt.trim() : "";

  const history = Array.isArray(body.history)
    ? body.history.slice(-MAX_HISTORY_TURNS)
    : [];
  const transcript = history
    .map(turnToLine)
    .filter((line): line is string => line !== null)
    .join("\n");

  let userAsk: string;
  if (topic) {
    userAsk =
      `Create a study guide about "${topic.slice(0, 200)}". Structure it as: ` +
      `1) a short summary, 2) key points, 3) five flashcards (question and answer pairs), ` +
      `4) a three-question quiz with an answer key.`;
  } else {
    userAsk = message;
  }

  const prompt = transcript
    ? `${transcript}\nUser: ${userAsk}`
    : `User: ${userAsk}`;

  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const envModel = process.env.GEMINI_MODEL?.trim() || "";
  // The env fallback is allowlist-checked too (audit item 9): an
  // off-list GEMINI_MODEL must not reach the server key from here.
  const model = MODEL_ALLOWLIST.has(requestedModel)
    ? requestedModel
    : MODEL_ALLOWLIST.has(envModel)
      ? envModel
      : DEFAULT_MODEL;

  // Bound the user text so one public request cannot burn the server key.
  const boundedPrompt =
    prompt.length > MAX_MESSAGE_CHARS * 2
      ? prompt.slice(0, MAX_MESSAGE_CHARS * 2)
      : prompt;

  return { prompt: boundedPrompt, model };
}

/** Remove any occurrence of the supplied key from text so errors never leak it. */
export function scrubKey(text: string, key?: string): string {
  if (!key || key.length <= 10) return text;
  return text.split(key).join("[redacted]");
}

export async function GET() {
  return NextResponse.json({ ok: true, serverKeyConfigured: hasServerKey() });
}

export async function POST(request: NextRequest) {
  let body: AssistantRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim()
    : typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!topic && !message) {
    return NextResponse.json(
      { error: "A message or topic is required" },
      { status: 400 }
    );
  }

  // Rate limit (audit item 9): this public endpoint spends the server
  // Gemini key and previously had no limit at all. aiRateLimiter
  // allows 10 requests per minute per client IP; the in-memory scope
  // is per server instance, the same caveat as the other limiters.
  const clientIp =
    request.headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers?.get?.("x-real-ip")?.trim() ||
    "unknown";
  const rateCheck = await aiRateLimiter.check(`assistant:${clientIp}`);
  if (!rateCheck.success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment and try again." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.max(1, Math.ceil((rateCheck.resetTime - Date.now()) / 1000))
          ),
        },
      }
    );
  }

  const { prompt, model } = buildAssistantPrompt(body);

  const userKey =
    typeof body.apiKey === "string" && body.apiKey.trim().length > 10
      ? body.apiKey.trim()
      : undefined;

  if (!userKey && !hasServerKey()) {
    return NextResponse.json(
      { error: "AI service is not configured. Please try again later." },
      { status: 503 }
    );
  }

  try {
    const reply = await executeWithFailover(async (genAI) => {
      const modelHandle = genAI.getGenerativeModel({
        model,
        systemInstruction: ASSISTANT_SYSTEM_INSTRUCTION,
      });
      const result = await modelHandle.generateContent(prompt);
      const text = result.response.text();
      if (!text || !text.trim()) {
        throw new Error("The assistant returned an empty response.");
      }
      return text.trim();
    }, userKey);

    return NextResponse.json({
      success: true,
      reply,
      model,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const safeMessage = scrubKey(
      error?.message || "The assistant failed to respond. Please try again.",
      userKey
    );
    console.error("[AI Assistant] Request failed:", safeMessage);
    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}
