/**
 * @jest-environment node
 *
 * Suite H middleware (spec M1-M4): the fail-open site-state gate.
 * Every failure mode must pass requests through; only an affirmative
 * non-live state pauses, and never for admin/auth/state surfaces.
 */

import { NextRequest } from 'next/server';

const fetchMock = jest.fn();

function stateResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  });
}

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
});

afterEach(() => {
  delete process.env.PLATFORM_GATE_BYPASS;
});

describe('middleware site-state gate', () => {
  it('M1: state fetch failure passes the request through (fail open)', async () => {
    fetchMock.mockRejectedValue(new Error('state route down'));
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('M1b: a 500 from the state route also passes through', async () => {
    fetchMock.mockImplementation(() => stateResponse({}, false));
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('M2: maintenance rewrites pages to /site-paused and 503s public APIs', async () => {
    fetchMock.mockImplementation(() => stateResponse({ mode: 'maintenance' }));
    const middleware = await loadMiddleware();
    const page = await middleware(req('/about'));
    const rewrite = page.headers.get('x-middleware-rewrite') ?? '';
    expect(rewrite).toContain('/site-paused');
    expect(rewrite).toContain('mode=maintenance');

    const api = await middleware(req('/api/tasks'));
    expect(api.status).toBe(503);
    const body = await api.json();
    expect(body.code).toBe('SITE_MAINTENANCE');
  });

  it('M3: revoked rewrites with the public notice and 503s APIs', async () => {
    fetchMock.mockImplementation(() =>
      stateResponse({ mode: 'revoked', licencePublicNotice: 'Licence revoked.' }),
    );
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

  it('M4: admin, auth, state and paused surfaces are never gated', async () => {
    fetchMock.mockImplementation(() =>
      stateResponse({ mode: 'revoked', licencePublicNotice: 'x' }),
    );
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
    fetchMock.mockImplementation(() => stateResponse({ mode: 'revoked' }));
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M6: live mode passes everything through', async () => {
    fetchMock.mockImplementation(() => stateResponse({ mode: 'live' }));
    const middleware = await loadMiddleware();
    const res = await middleware(req('/about'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(200);
  });
});
