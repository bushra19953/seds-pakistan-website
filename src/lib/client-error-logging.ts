/**
 * Exact client error logging for the induction submit handler (and any other
 * client flow that needs a diagnosable failure record).
 *
 * Privacy rule: a log carries FIELD NAMES only, never field values. No PII,
 * no emails, no answers, no applicant identifiers. The client never sends a
 * uid; POST /api/client-errors attaches the uid from the verified ID token
 * server-side (or null when the token is missing/invalid, so logging still
 * works when the failure itself is auth-related).
 *
 * Sink: POST /api/client-errors. The client does NOT write Firestore
 * directly: firestore.rules has no grant for a client_errors collection
 * (default-deny), and the rules are deliberately not weakened for logging.
 * The server route logs to server logs and, best-effort, to the
 * `client_errors` collection via the Admin SDK (which bypasses rules).
 *
 * Version signal: reuses Team 2's stale-tab guard signal
 * (src/lib/version-guard.ts): CURRENT_BUILD_ID is the build id baked into
 * this bundle at build time, and the submit handler passes the guard's own
 * freshness verdict (fresh / stale / unchecked) plus the live build id it
 * saw, so a failure log shows exactly what the guard concluded. The tab-age
 * heuristic (isStaleTabSuspected) is kept as a secondary signal for cases
 * where the guard could not run (unchecked).
 */

import { CURRENT_BUILD_ID } from './version-guard';

export type ClientErrorLog = {
  kind: string;
  operation: string;
  errorCode: string;
  errorMessage: string;
  payloadFieldNames: string[];
  context: string;
  clientBuildId: string;
  freshnessStatus: string;
  liveBuildId: string | null;
  tabLoadedAt: string;
  tabAgeMs: number;
  isStaleTabSuspected: boolean;
  clientTimestamp: string;
  userAgent: string;
  pathname: string;
};

export type ClientVersionMarker = Pick<
  ClientErrorLog,
  'clientBuildId' | 'tabLoadedAt' | 'tabAgeMs' | 'isStaleTabSuspected'
>;

/** A tab open longer than this is flagged as a stale-tab suspect (heuristic). */
export const STALE_TAB_SUSPECT_AFTER_MS = 6 * 60 * 60 * 1000;

const MAX_ERROR_MESSAGE_CHARS = 2000;
const MAX_FIELD_NAMES = 100;
const MAX_FIELD_NAME_CHARS = 128;

/**
 * Best-effort client version marker. Build id comes from Team 2's guard
 * signal (CURRENT_BUILD_ID, baked in at build time); tab age is measured
 * from performance.timeOrigin. Never throws; every field degrades to a
 * safe default (build id "unknown", tab age -1).
 */
export function getClientVersionMarker(nowMs: number = Date.now()): ClientVersionMarker {
  const buildId =
    typeof CURRENT_BUILD_ID === 'string' && CURRENT_BUILD_ID.trim().length > 0
      ? CURRENT_BUILD_ID.slice(0, 128)
      : 'unknown';

  let tabLoadedAt = 'unknown';
  let tabAgeMs = -1;
  try {
    if (typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number') {
      tabLoadedAt = new Date(performance.timeOrigin).toISOString();
      tabAgeMs = Math.max(0, Math.floor(nowMs - performance.timeOrigin));
    }
  } catch {
    tabLoadedAt = 'unknown';
    tabAgeMs = -1;
  }

  return {
    clientBuildId: buildId,
    tabLoadedAt,
    tabAgeMs,
    isStaleTabSuspected: tabAgeMs >= 0 && tabAgeMs > STALE_TAB_SUSPECT_AFTER_MS,
  };
}

/** Keep only safe field-name strings: deduped, sorted, capped, truncated. */
export function sanitizeFieldNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  for (const entry of names) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().slice(0, MAX_FIELD_NAME_CHARS);
    if (name.length > 0) seen.add(name);
    if (seen.size >= MAX_FIELD_NAMES) break;
  }
  return [...seen].sort();
}

/**
 * Scrub anything value-like out of a Firestore error message. Firestore
 * error messages do not carry form values, but defence in depth: redact
 * email-like tokens and long opaque tokens so a log can never smuggle PII.
 */
export function scrubErrorMessage(message: unknown): string {
  if (typeof message !== 'string') return 'unknown error';
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted-token]')
    .slice(0, MAX_ERROR_MESSAGE_CHARS);
}

/**
 * Build a sanitized error log from a caught submit failure. Pure: no I/O,
 * never throws. `error` may be a Firestore error (code + message) or any
 * other thrown value; `payloadFieldNames` must be keys only.
 */
export function buildClientErrorLog(input: {
  error: unknown;
  operation: string;
  payloadFieldNames: unknown;
  context?: string;
  nowMs?: number;
  /** Team 2 guard verdict for this submit attempt, when the handler ran it. */
  freshness?: { status: string; liveBuildId: string | null };
}): ClientErrorLog {
  const { error, operation, payloadFieldNames } = input;
  const err = (error ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  const errorCode =
    typeof err.code === 'string' && err.code.length > 0
      ? err.code.slice(0, 128)
      : typeof err.name === 'string' && err.name.length > 0
        ? err.name.slice(0, 128)
        : 'unknown';
  const version = getClientVersionMarker(input.nowMs);
  let userAgent = 'unknown';
  let pathname = 'unknown';
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
      userAgent = navigator.userAgent.slice(0, 512);
    }
    if (typeof window !== 'undefined' && typeof window.location?.pathname === 'string') {
      pathname = window.location.pathname.slice(0, 256);
    }
  } catch {
    // Keep the safe defaults above.
  }
  return {
    kind: 'induction-submit-failure',
    operation: typeof operation === 'string' && operation.length > 0 ? operation.slice(0, 128) : 'unknown',
    errorCode,
    errorMessage: scrubErrorMessage(err.message),
    payloadFieldNames: sanitizeFieldNames(payloadFieldNames),
    context:
      typeof input.context === 'string' && input.context.length > 0
        ? input.context.slice(0, 128)
        : 'induction-submit',
    ...version,
    freshnessStatus:
      typeof input.freshness?.status === 'string' && input.freshness.status.length > 0
        ? input.freshness.status.slice(0, 64)
        : 'not-checked',
    liveBuildId:
      typeof input.freshness?.liveBuildId === 'string'
        ? input.freshness.liveBuildId.slice(0, 128)
        : null,
    clientTimestamp: new Date(input.nowMs ?? Date.now()).toISOString(),
    userAgent,
    pathname,
  };
}

/**
 * Send a sanitized log to POST /api/client-errors. Fire-and-forget: never
 * throws, never rejects, and a logging failure must never change what the
 * applicant sees. Also mirrors the log to console.error so the browser
 * console holds it even if the endpoint is unreachable.
 */
export async function reportClientError(log: ClientErrorLog): Promise<void> {
  try {
    console.error('[induction-submit-failure]', JSON.stringify(log));
  } catch {
    // Console logging must never break the caller.
  }
  try {
    await fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
      keepalive: true,
    });
  } catch {
    // Logging failure is silent by design: it never blocks the user flow.
  }
}
