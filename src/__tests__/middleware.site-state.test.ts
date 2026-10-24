/**
 * @jest-environment node
 *
 * Suite H middleware: the fail-open site-state gate.
 *
 * Read-burn fix (2026-10-24): the gate no longer fetches /api/site-state
 * from middleware (that self-fetch was the #1 Function Invocation leak
 * in the Vercel limits audit). It is env-driven instead:
 * PLATFORM_GATE_MODE=live|maintenance|disabled|revoked, with
 * PLATFORM_GATE_BYPASS=1 forcing live. Every unrecognised / unset value
 * must pass requests through; only an affirmative non-live mode pauses,
 * and never for admin/auth/state surfaces. No test may observe a fetch.
 */

import { NextRequest } from 'next/server';

const fetchMock = jest.fn();

async function loadMiddleware() {
  jest.resetModules();
  const mod = await import('@/middleware');
  return mod.middleware;
}

function req(path: string) {
  return new NextRequest(`https://site.test${path}`);
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.PLATFORM_GATE_BYPASS;
  delete process.env.PLATFORM_GATE_MODE;
  delete process.env.PLATFORM_GATE_LICENCE_PUBLIC_NOTICE;
});

afterEach(() => {
  delete process.env.PLATFORM_GATE_BYPASS;
  delete process.env.PLATFORM_GATE_MODE;
  delete process.env.PLATFORM_GATE_LICENCE_PUBLIC_NOTICE;
});

describe('middleware site-state gate', () => {
  it('M1: unset gate mode passes the request through (fail open), with no fetch', async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M1b: an unrecognised gate mode also passes through (fail open)', async () => {
    process.env.PLATFORM_GATE_MODE = 'banana';
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M2: maintenance rewrites pages to /site-paused and 503s public APIs', async () => {
    process.env.PLATFORM_GATE_MODE = 'maintenance';
    const middleware = await loadMiddleware();
    const page = await middleware(req('/about'));
    const rewrite = page.headers.get('x-middleware-rewrite') ?? '';
    expect(rewrite).toContain('/site-paused');
    expect(rewrite).toContain('mode=maintenance');

    const api = await middleware(req('/api/tasks'));
    expect(api.status).toBe(503);
    const body = await api.json();
    expect(body.code).toBe('SITE_MAINTENANCE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M3: revoked rewrites with the public notice and 503s APIs', async () => {
    process.env.PLATFORM_GATE_MODE = 'revoked';
    process.env.PLATFORM_GATE_LICENCE_PUBLIC_NOTICE = 'Licence revoked.';
    const middleware = await loadMiddleware();
    const page = await middleware(req('/'));
    const rewrite = page.headers.get('x-middleware-rewrite') ?? '';
    expect(rewrite).toContain('/site-paused');
    expect(rewrite).toContain('mode=revoked');
    expect(rewrite).toContain('notice=');

    const api = await middleware(req('/api/contact'));
    expect(api.status).toBe(503);
    expect((await api.json()).code).toBe('LICENCE_REVOKED');
  });

  it('M3b: disabled 503s public APIs with SITE_DISABLED', async () => {
    process.env.PLATFORM_GATE_MODE = 'disabled';
    const middleware = await loadMiddleware();
    const api = await middleware(req('/api/tasks'));
    expect(api.status).toBe(503);
    expect((await api.json()).code).toBe('SITE_DISABLED');
  });

  it('M4: admin, auth, state and paused surfaces are never gated', async () => {
    process.env.PLATFORM_GATE_MODE = 'revoked';
    process.env.PLATFORM_GATE_LICENCE_PUBLIC_NOTICE = 'x';
    const middleware = await loadMiddleware();

    // /admin without a session hits the EXISTING login redirect, not the gate.
    const admin = await middleware(req('/admin/tasks'));
    expect(admin.headers.get('x-middleware-rewrite')).toBeNull();
    expect(admin.headers.get('location') ?? '').toContain('/auth/login');

    const auth = await middleware(req('/auth/login'));
    expect(auth.headers.get('x-middleware-rewrite')).toBeNull();
    expect(auth.status).toBe(200);

    const state = await middleware(req('/api/site-state'));
    expect(state.status).toBe(200);

    const paused = await middleware(req('/site-paused?mode=revoked'));
    expect(paused.headers.get('x-middleware-rewrite')).toBeNull();
    expect(paused.status).toBe(200);
  });

  it('M5: PLATFORM_GATE_BYPASS=1 disables the gate entirely', async () => {
    process.env.PLATFORM_GATE_BYPASS = '1';
    process.env.PLATFORM_GATE_MODE = 'revoked';
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M6: live mode passes everything through', async () => {
    process.env.PLATFORM_GATE_MODE = 'live';
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
