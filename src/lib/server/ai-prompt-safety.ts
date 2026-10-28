/**
 * Prompt-injection hardening for the MISSION COMMAND orchestrator
 * (audit item 9, LLM01).
 *
 * Two controls, both server-side:
 *
 * 1. Registry free-text sanitisation. Team registry names, role slugs
 *    and role-definition descriptions are stored free text (an admin
 *    or a custom-role author can put anything in them) and they flow
 *    into the Gemini prompt. Before they do, every field is flattened
 *    and neutralised: control characters and line breaks are removed
 *    (no forged "SYSTEM:" lines or fake prompt sections), zero-width
 *    and bidi-override characters are stripped (no hidden text),
 *    backtick fences are collapsed (no breaking out of a fenced
 *    block), and lengths are capped. The route additionally labels
 *    the registry as DATA in the system instruction and JSON-encodes
 *    it, so what survives sanitisation is inert description text.
 *    This builds on, and does not replace, the route's existing
 *    structural defences: the registry is rebuilt server-side,
 *    model-proposed assignees are dropped unless they are in the
 *    registry, points are force-corrected, and no model output is
 *    ever written without human review.
 *
 * 2. Model allowlist. The model name used with the server Gemini key
 *    must be one of a fixed set. A caller-supplied model and the
 *    GEMINI_MODEL env var may only choose WITHIN the set; anything
 *    else falls back to the default. (Previously any string reached
 *    getGenerativeModel on the server key.)
 */

export const ALLOWED_ORCHESTRATOR_MODELS: readonly string[] = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
];

export const DEFAULT_ORCHESTRATOR_MODEL = 'gemini-2.5-flash';

/**
 * Resolve the orchestrator model: the caller's choice if allowlisted,
 * else the GEMINI_MODEL env choice if allowlisted, else the default.
 * An off-list value is never returned.
 */
export function resolveOrchestratorModel(
  requested?: string | null,
  envModel: string | undefined = process.env.GEMINI_MODEL,
): string {
  const req = typeof requested === 'string' ? requested.trim() : '';
  if (req && ALLOWED_ORCHESTRATOR_MODELS.includes(req)) return req;
  const env = typeof envModel === 'string' ? envModel.trim() : '';
  if (env && ALLOWED_ORCHESTRATOR_MODELS.includes(env)) return env;
  return DEFAULT_ORCHESTRATOR_MODEL;
}

// Control chars (incl. \n, \r, \t), DEL and C1 controls; zero-width
// and bidi-override formatting chars used to hide injected text.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const HIDDEN_FORMAT_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

/**
 * Neutralise one free-text field for prompt inclusion. Non-strings
 * become ''. The result is a single line with no fences and no
 * control characters, truncated to maxLength.
 */
export function sanitizePromptText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  let s = value.replace(HIDDEN_FORMAT_CHARS, '');
  s = s.replace(CONTROL_CHARS, ' ');
  // Collapse backtick runs so stored text cannot open/close a fence.
  s = s.replace(/`{2,}/g, '`');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

export interface PromptSafeSubordinate {
  uid: string;
  name: string;
  role: string;
  additionalRoles: string[];
}

export interface PromptSafeRoleDef {
  role: string;
  description: string;
  title?: string;
  parentRole?: string;
  chapterId?: string;
}

/**
 * Sanitised copy of the registry structures that enter the prompt.
 * UIDs pass through the same flattening (real document IDs contain
 * no whitespace or controls, so they are unchanged) and the caller
 * keeps validating model output against the ORIGINAL registry set.
 */
export function sanitizeRegistryForPrompt(
  subordinates: readonly any[],
  roleDefinitions: readonly any[],
): { subordinates: PromptSafeSubordinate[]; roleDefinitions: PromptSafeRoleDef[] } {
  const safeSubordinates: PromptSafeSubordinate[] = subordinates.map((u) => ({
    uid: sanitizePromptText(u.uid, 128),
    name: sanitizePromptText(u.name, 120),
    role: sanitizePromptText(u.role, 120),
    additionalRoles: Array.isArray(u.additionalRoles)
      ? u.additionalRoles.map((r) => sanitizePromptText(r, 120)).filter(Boolean)
      : [],
  }));

  const safeRoleDefinitions: PromptSafeRoleDef[] = roleDefinitions.map((d) => {
    const out: PromptSafeRoleDef = {
      role: sanitizePromptText(d.role, 120),
      description: sanitizePromptText(d.description, 1000),
    };
    if (typeof d.title === 'string') out.title = sanitizePromptText(d.title, 120);
    if (typeof d.parentRole === 'string') out.parentRole = sanitizePromptText(d.parentRole, 120);
    if (typeof d.chapterId === 'string') out.chapterId = sanitizePromptText(d.chapterId, 128);
    return out;
  });

  return { subordinates: safeSubordinates, roleDefinitions: safeRoleDefinitions };
}
