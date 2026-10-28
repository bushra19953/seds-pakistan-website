/**
 * Shared safe-redirect validation (security audit 2026-10-28, item 19).
 *
 * ONE validator for every post-auth / callbackUrl / redirect consumer:
 * the Google auth form, the /welcome page, the /auth/login + /auth/signup
 * forwarders, and the role-aware post-login redirect in use-user.ts.
 * Never copy-paste a local variant — a partial check is how the
 * protocol-relative bypass (`//evil.com` passing a bare
 * `startsWith('/')`) shipped in the first place.
 *
 * A candidate is safe only when ALL of the following hold, checked on
 * the value as received AND on its fully percent-decoded form (so
 * encoded and double-encoded attacks cannot slip a dangerous shape
 * past the structural checks):
 *
 * - it is a non-empty string within a sane length;
 * - it contains no control characters (NUL–US, DEL) as received, and
 *   its decoded form contains none either (defeats %0a / %09 tricks);
 * - it starts with exactly one `/` — the second character is neither
 *   `/` nor `\` (defeats `//evil.com` and `/\evil.com`, both of which
 *   browsers resolve off-origin);
 * - its decoded form also starts with exactly one `/` and its second
 *   decoded character is neither `/` nor `\` (defeats `%2fevil.com`,
 *   `/%2fevil.com`, `/%5cevil.com`, double-encoded variants, …);
 * - no `..` path segment, raw or decoded (the historical rule);
 * - it does not point back into the auth flow (`/auth/…`), the rule the
 *   original auth-form validator enforced to avoid redirect loops;
 * - as a final belt-and-braces check, resolving the decoded form
 *   against a placeholder origin stays on that origin.
 *
 * Percent-decoding is applied repeatedly until the value stops
 * changing (bounded), which collapses double/triple encoding to the
 * shape the browser would ultimately navigate to. A malformed escape
 * sequence simply stops decoding at that round: the undecodable
 * remainder stays literal text in a same-origin path and cannot become
 * a separator.
 *
 * The value returned on success is the candidate AS RECEIVED (already
 * decoded once by URLSearchParams in every consumer): the browser and
 * Next's router apply the final, safe normalization themselves.
 */

const PLACEHOLDER_ORIGIN = 'https://safe-redirect.invalid';
const MAX_REDIRECT_LENGTH = 2048;
const MAX_DECODE_ROUNDS = 5;
// NUL through US (includes tab, LF, CR) plus DEL. Plain space is not
// included: it legitimately appears in decoded query values
// (e.g. `?q=hello world`) and cannot smuggle a scheme or a separator.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function fullyDecode(value: string): string {
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed escape (e.g. a literal '%' in a query value). The
      // remainder cannot decode into a separator, so stop here and let
      // the structural checks judge the partially decoded form.
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** True when the value starts with a single '/' and only a single '/'. */
function hasExactlyOneLeadingSlash(value: string): boolean {
  return value.startsWith('/') && value[1] !== '/' && value[1] !== '\\';
}

function hasDotDotSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '..');
}

function passesChecks(value: string, decoded: string): boolean {
  if (!hasExactlyOneLeadingSlash(value)) return false;
  if (!hasExactlyOneLeadingSlash(decoded)) return false;
  if (CONTROL_CHARS.test(value) || CONTROL_CHARS.test(decoded)) return false;
  if (hasDotDotSegment(value) || hasDotDotSegment(decoded)) return false;
  // Keep the auth form's historical rule: never redirect back into the
  // auth flow (loop / phishing-laundering guard).
  if (decoded.startsWith('/auth/')) return false;
  // Final guard: WHATWG URL resolution (which treats '\' as '/' for
  // special schemes and normalizes dot segments) must keep the target
  // on the placeholder origin.
  try {
    if (new URL(decoded, PLACEHOLDER_ORIGIN).origin !== PLACEHOLDER_ORIGIN) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * True when `candidate` is a same-origin relative path that is safe to
 * hand to `router.push` / `router.replace` / `window.location.replace`.
 */
export function isSafeRedirectPath(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false;
  if (candidate.length === 0 || candidate.length > MAX_REDIRECT_LENGTH) {
    return false;
  }
  return passesChecks(candidate, fullyDecode(candidate));
}

/**
 * Returns `candidate` when it is a safe same-origin relative path,
 * otherwise `fallback` (default '/'). Callers pass their own historical
 * default — '/profile' for the auth form and the welcome page.
 */
export function getSafeRedirectPath(
  candidate: unknown,
  fallback: string = '/',
): string {
  return isSafeRedirectPath(candidate) ? candidate : fallback;
}
