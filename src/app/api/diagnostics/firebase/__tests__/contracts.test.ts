/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET /api/diagnostics/firebase.
 *
 * This route had NO tests before this suite. Pins CURRENT behaviour.
 *
 * H-11: the route performs NO authentication and echoes selected
 * environment values verbatim in the response. That is pinned here as
 * current behaviour (a security flag), NOT fixed. All env values used
 * below are fake fixtures invented for this test — never put a real
 * credential value in a test, fixture, or snapshot. The
 * GOOGLE_APPLICATION_CREDENTIALS fixture is a fake filesystem PATH
 * string only, which is all the route ever echoes for that variable.
 */

import { NextRequest } from 'next/server';

const state = {
  diagnostics: {
    initialized: true,
    appsCount: 1,
    initMode: 'fixture-mode',
    projectId: 'fixture-project',
    env: { FIREBASE_CONFIG: true },
    lastError: null,
  } as any,
  diagnosticsError: null as any,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getAdminDiagnostics: jest.fn(() => {
    if (state.diagnosticsError) throw state.diagnosticsError;
    return state.diagnostics;
  }),
}));

import { GET } from '../route';

const ENV_KEYS = [
  'FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_CONFIG',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  state.diagnosticsError = null;
  // Fake fixture values only.
  process.env.FIREBASE_PROJECT_ID = 'fixture-project-id';
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'fixture-public-project-id';
  process.env.GOOGLE_CLOUD_PROJECT = 'fixture-gcp-project';
  process.env.GCLOUD_PROJECT = 'fixture-gcloud-project';
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fake/fixture/service-account.json';
  process.env.FIREBASE_CONFIG = '{"fixture":true}';
});

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/diagnostics/firebase', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/diagnostics/firebase — migration contract', () => {
  // SECURITY FLAG H-11 (current behaviour, pinned not fixed): a request
  // with no credentials of any kind receives the full diagnostics
  // payload with HTTP 200. There is no auth check in this route.
  it('SECURITY FLAG H-11: unauthenticated request (no headers at all) gets 200 and the full payload', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.environment.FIREBASE_PROJECT_ID).toBe('fixture-project-id');
  });

  it('response top-level keys are exactly [success, diagnostics, environment, timestamp]', async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['diagnostics', 'environment', 'success', 'timestamp'].sort(),
    );
  });

  it('diagnostics is the verbatim return value of getAdminDiagnostics()', async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body.diagnostics).toEqual(state.diagnostics);
  });

  it('environment keys are exactly the six pinned names, values echoed verbatim, FIREBASE_CONFIG coerced to boolean', async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(Object.keys(body.environment).sort()).toEqual([...ENV_KEYS].sort());
    expect(body.environment).toEqual({
      FIREBASE_PROJECT_ID: 'fixture-project-id',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'fixture-public-project-id',
      GOOGLE_CLOUD_PROJECT: 'fixture-gcp-project',
      GCLOUD_PROJECT: 'fixture-gcloud-project',
      GOOGLE_APPLICATION_CREDENTIALS: '/fake/fixture/service-account.json',
      FIREBASE_CONFIG: true,
    });
  });

  it('FIREBASE_CONFIG is false (boolean) when the variable is unset, not undefined', async () => {
    delete process.env.FIREBASE_CONFIG;
    const res = await GET(req());
    const body = await res.json();
    expect(body.environment.FIREBASE_CONFIG).toBe(false);
  });

  it('timestamp is an ISO-8601 string generated at request time', async () => {
    const before = Date.now();
    const res = await GET(req());
    const body = await res.json();
    const ts = Date.parse(body.timestamp);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('diagnostics failure -> 500 { success: false, error: "Failed to check Firebase configuration", message }', async () => {
    state.diagnosticsError = new Error('diag exploded');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Failed to check Firebase configuration',
      message: 'diag exploded',
    });
  });
});
