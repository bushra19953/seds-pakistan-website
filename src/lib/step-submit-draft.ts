/**
 * Draft persistence for the mission step submit page (typing-lag fix,
 * 2026-10-26; see ~/workspace/known_issues/typing_lag_ahmed_2026-10-26.md).
 *
 * The submit page kept the work report only in component state, so
 * navigating back to the mission page to re-read the brief destroyed
 * everything typed. The in-progress fields now persist to
 * sessionStorage per task (tab-scoped, gone when the tab closes; no
 * server writes are added).
 *
 * Seed rule (three-way): a stored draft wins ONLY when the server copy
 * still equals the draft's `baseReport` — the server report the draft
 * was started from. If the server copy has moved (saved or submitted
 * from another surface meanwhile), the server wins and the caller drops
 * the stale draft. A successful Save Progress / Submit clears the
 * draft, because the server then holds the text.
 */

export interface StepSubmitDraft {
  report: string;
  hours: string;
  links: string;
  /** The server-side report value this draft was started from. */
  baseReport: string;
}

/** The slice of the Web Storage API this module needs (testable). */
export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

const KEY_PREFIX = 'step-submit-draft:';

export function draftKey(taskId: string): string {
  return `${KEY_PREFIX}${taskId}`;
}

function isDraft(value: unknown): value is StepSubmitDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.report === 'string' &&
    typeof d.hours === 'string' &&
    typeof d.links === 'string' &&
    typeof d.baseReport === 'string'
  );
}

export function loadDraft(storage: DraftStorage, taskId: string): StepSubmitDraft | null {
  try {
    const raw = storage.getItem(draftKey(taskId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(storage: DraftStorage, taskId: string, draft: StepSubmitDraft): void {
  try {
    storage.setItem(draftKey(taskId), JSON.stringify(draft));
  } catch {
    /* storage full/blocked: the in-memory form still works */
  }
}

export function clearDraft(storage: DraftStorage, taskId: string): void {
  try {
    storage.removeItem(draftKey(taskId));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Decide the seed for the form fields. Returns the draft's fields when
 * the draft is still based on the current server report; otherwise
 * null, meaning "seed from the server values".
 */
export function resolveDraftSeed(
  serverReport: string,
  draft: StepSubmitDraft | null,
): { report: string; hours: string; links: string } | null {
  if (!draft) return null;
  if (draft.baseReport !== serverReport) return null;
  return { report: draft.report, hours: draft.hours, links: draft.links };
}
