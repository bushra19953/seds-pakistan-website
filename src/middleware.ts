/**
 * Edge middleware: server-side guard for admin pages and admin APIs.
 *
 * - Browser visits to /admin/* without a session are redirected to
 *   /auth/login?callbackUrl=<path-with-query> before any private dashboard UI
 *   can render (prevents authenticated-only content from flashing).
 * - Calls to /api/admin/* without a session are rejected with 401 JSON
 *   (API clients do not follow login redirects).
 * - A fail-open platform gate (Workstream H) pauses public routes via
 *   /api/site-state; admin, auth, and the state route are never gated.
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
 * Platform site-state gate (Workstream H, spec 4.2).
 *
 * FAIL-OPEN BY CONSTRUCTION: this gate can only ever pause the site
 * when GET /api/site-state affirmatively reports a non-live mode.
 * Every failure mode (fetch error, timeout, non-200, unparseable
 * body, unknown mode string) returns null here and the request
 * proceeds untouched. PLATFORM_GATE_BYPASS=1 skips the gate entirely,
 * so the switch can never brick the site it controls.
 *
 * The Edge runtime cannot use the Admin SDK, so the gate polls the
 * public /api/site-state route and caches the answer module-level for
 * 30 seconds (worst-case pause/unpause lag).
 */
const GATE_CACHE_TTL_MS = 30_000;
const GATE_FETCH_TIMEOUT_MS = 1_500;

interface GateState {
  mode: string;
  licencePublicNotice?: string;
}

let gateCache: { state: GateState | null; at: number } | null = null;

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

async function fetchGateState(request: NextRequest): Promise<GateState | null> {
  try {
    if (process.env.PLATFORM_GATE_BYPASS === '1') return null;
    const nowMs = Date.now();
    if (gateCache && nowMs - gateCache.at < GATE_CACHE_TTL_MS) {
      return gateCache.state;
    }
    let state: GateState | null = null;
    try {
      const res = await fetch(new URL('/api/site-state', request.url), {
        cache: 'no-store',
        signal: AbortSignal.timeout(GATE_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (
          body &&
          typeof body === 'object' &&
          typeof (body as { mode?: unknown }).mode === 'string'
        ) {
          const mode = (body as { mode: string }).mode;
          if (['live', 'maintenance', 'disabled', 'revoked'].includes(mode)) {
            state = {
              mode,
              licencePublicNotice:
                typeof (body as { licencePublicNotice?: unknown })
                  .licencePublicNotice === 'string'
                  ? ((body as { licencePublicNotice: string })
                      .licencePublicNotice as string)
                  : undefined,
            };
          }
        }
      }
    } catch {
      state = null; // unreachable/slow state route: fail open
    }
    gateCache = { state, at: nowMs };
    return state;
  } catch {
    return null;
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

  // Platform site-state gate (Workstream H). Runs FIRST; exempt
  // surfaces (admin, auth, the state route itself, the paused page,
  // static infrastructure) are never gated, so the people who can fix
  // the site can always reach it.
  if (!isGateExempt(pathname)) {
    const gate = await fetchGateState(request);
    if (gate && gate.mode !== 'live') {
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
