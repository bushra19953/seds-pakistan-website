/**
 * Edge middleware: server-side guard for admin pages and admin APIs.
 *
 * - Browser visits to /admin/* without a session are redirected to
 *   /auth/login?callbackUrl=<path-with-query> before any private dashboard UI
 *   can render (prevents authenticated-only content from flashing).
 * - Calls to /api/admin/* without a session are rejected with 401 JSON
 *   (API clients do not follow login redirects).
 * - A fail-open platform gate (Workstream H) can pause public routes;
 *   admin, auth, and the state route are never gated. The gate is now
 *   ENV-DRIVEN (see below) and performs NO network fetch per request.
 *
 * Session detection is intentionally lightweight: the client sets an
 * `__session` cookie holding the Firebase ID token on sign-in
 * (see src/firebase/user-provider.tsx). Full token verification happens
 * inside API routes and server components via the Admin SDK, which is not
 * available in the Edge runtime.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SIGNIN_PATH = '/auth/login';

/**
 * Platform site-state gate (Workstream H, spec 4.2) — env-driven.
 *
 * HISTORY / WHY THIS CHANGED (read-burn fix, 2026-10-24):
 * The gate previously fetched GET /api/site-state over HTTP from inside
 * middleware, cached module-level for only 30 s per Edge isolate. Edge
 * isolates are numerous and ephemeral, so that "cache" was weak in
 * practice: every cold isolate's first non-exempt request in each 30 s
 * window fired a full /api/site-state Function Invocation. The Vercel
 * limits audit (~/workspace/vercel_limits_audit/,
 * invocations-edge-requests.md §1, driver #1) estimated this leak at
 * ~100k-600k invocations/month — the #1 invocation driver in the repo,
 * scaling with isolates x time rather than with users, and returning
 * "live" almost always. That per-request self-fetch is REMOVED.
 *
 * REPLACEMENT — bounded-staleness, zero-fetch:
 * The gate mode is read synchronously, per request, from deployment
 * environment variables. No fetch, no Function Invocation, no Firestore
 * read is added to any request:
 *
 *   PLATFORM_GATE_MODE=live|maintenance|disabled|revoked
 *   PLATFORM_GATE_LICENCE_PUBLIC_NOTICE=<text>   (revoked mode only)
 *   PLATFORM_GATE_BYPASS=1                       (forces live; wins over MODE)
 *
 * STALENESS BOUND: the gate state is exactly as stale as the deployment
 * environment. Changing the mode requires changing the env var and
 * redeploying / restarting the service (on Vercel and Render an env
 * change takes effect on the next deployment / service restart). There
 * is NO automatic propagation and NO time-based TTL any more: worst-case
 * pause/unpause lag is therefore "until the next deploy/restart after
 * the env change", not 30 s. That is the accepted trade for eliminating
 * the invocation leak (the audit itself recommends Edge Config/KV or a
 * 5-15 min TTL as lesser alternatives; env is the zero-cost floor).
 *
 * BEHAVIOUR DIFFERENCE (honest): Firestore-backed switches no longer
 * pause the site through middleware. Toggling settings/siteWide
 * (siteEnabled / maintenanceMode) or a licence revocation becoming
 * effective in governance/platform_licence (the data behind
 * /api/site-state) does NOT, by itself, rewrite pages to /site-paused
 * or 503 public APIs via middleware any more. Those records are still
 * honoured server-side by API handlers that call
 * getEffectiveSiteState() / assertSiteOperational() directly
 * (src/lib/server/platform-licence.ts, unchanged), and /api/site-state
 * itself still reports them. To pause the whole site at the edge,
 * set PLATFORM_GATE_MODE and redeploy.
 *
 * FAIL-OPEN BY CONSTRUCTION: only an affirmative, allow-listed
 * PLATFORM_GATE_MODE value pauses the site. Unset, empty, "live", or
 * any unrecognised value returns null here and the request proceeds
 * untouched, so a typo can never brick the site.
 */

interface GateState {
  mode: string;
  licencePublicNotice?: string;
}

const GATE_MODES = ['live', 'maintenance', 'disabled', 'revoked'] as const;

const GATE_EXEMPT_PREFIXES = [
  '/site-paused',
  '/api/site-state',
  '/api/admin',
  '/admin',
  '/auth',
  '/_next',
  '/favicon',
  '/icons',
  '/fonts',
] as const;

const GATE_EXEMPT_EXACT = new Set([
  '/manifest.json',
  '/robots.txt',
  '/sitemap.xml',
]);

function isGateExempt(pathname: string): boolean {
  if (GATE_EXEMPT_EXACT.has(pathname)) return true;
  return GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Synchronous env-driven gate state. Returns null (= pass through) for
 * bypass, unset, "live", and any invalid value. Never throws, never
 * fetches.
 */
function getGateState(): GateState | null {
  try {
    if (process.env.PLATFORM_GATE_BYPASS === '1') return null;
    const mode = process.env.PLATFORM_GATE_MODE;
    if (!mode || !(GATE_MODES as readonly string[]).includes(mode)) {
      return null;
    }
    if (mode === 'live') return null;
    const notice = process.env.PLATFORM_GATE_LICENCE_PUBLIC_NOTICE;
    return {
      mode,
      licencePublicNotice:
        mode === 'revoked' && typeof notice === 'string' && notice
          ? notice
          : undefined,
    };
  } catch {
    return null; // fail open
  }
}

function gateBlockBody(mode: string): Record<string, string> {
  if (mode === 'revoked') {
    return { error: 'Site unavailable', code: 'LICENCE_REVOKED' };
  }
  if (mode === 'disabled') {
    return { error: 'Site disabled', code: 'SITE_DISABLED' };
  }
  return { error: 'Site under maintenance', code: 'SITE_MAINTENANCE' };
}

function hasSessionCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get('__session')?.value);
}

function hasBearerHeader(request: NextRequest): boolean {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  return !!header && header.startsWith('Bearer ');
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Platform site-state gate (Workstream H), env-driven. Runs FIRST;
  // exempt surfaces (admin, auth, the state route itself, the paused
  // page, static infrastructure) are never gated, so the people who can
  // fix the site can always reach it. No fetch is performed.
  if (!isGateExempt(pathname)) {
    const gate = getGateState();
    if (gate) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(gateBlockBody(gate.mode), { status: 503 });
      }
      const url = request.nextUrl.clone();
      url.pathname = '/site-paused';
      url.search = '';
      url.searchParams.set('mode', gate.mode);
      if (gate.mode === 'revoked' && gate.licencePublicNotice) {
        url.searchParams.set('notice', gate.licencePublicNotice);
      }
      return NextResponse.rewrite(url);
    }
  }

  // Guard admin JSON APIs: reject unauthenticated callers with 401.
  if (pathname.startsWith('/api/admin/')) {
    if (!hasSessionCookie(request) && !hasBearerHeader(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Guard admin pages: redirect unauthenticated browser visits to sign-in.
  if (pathname.startsWith('/admin')) {
    // Defensive: never redirect the sign-in page itself (avoids loops).
    if (pathname.startsWith(SIGNIN_PATH)) {
      return NextResponse.next();
    }
    // Local development serves over HTTP, where browsers do not send
    // Secure cookies. Skip the gate there so dev admin testing keeps working.
    if (process.env.NODE_ENV === 'development') {
      return NextResponse.next();
    }
    if (!hasSessionCookie(request)) {
      // Preserve the full original destination, including its query string,
      // so the user returns to exactly where they were going after sign-in
      // (e.g. /admin/tasks?foo=bar, not just /admin/tasks).
      const callbackUrl = pathname + request.nextUrl.search;
      const url = request.nextUrl.clone();
      url.pathname = SIGNIN_PATH;
      // Drop the original page's params from the sign-in URL itself; they
      // travel inside callbackUrl, not as top-level login-page params.
      url.search = '';
      url.searchParams.set('callbackUrl', callbackUrl);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Widened for the site-state gate (Workstream H): the gate must see
  // public routes to pause them. Static Next internals stay excluded.
  // The gate is now a synchronous env read, so widening the matcher no
  // longer multiplies Function Invocations.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
