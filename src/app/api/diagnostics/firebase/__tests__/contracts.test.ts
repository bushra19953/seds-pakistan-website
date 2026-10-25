/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET /api/diagnostics/firebase.
 *
 * This route had NO tests before this suite. It originally pinned the
 * pre-fix behaviour, including the H-11 hole (NO authentication, raw
 * environment values echoed verbatim).
 *
 * DELIBERATE RE-PIN at the H-11 merge (merge program finisher,
 * 2026-10-26): fix/diagnostics-route founder-gates this route and the
 * environment block now reports PRESENCE BOOLEANS ONLY. The pins below
 * assert the FIXED behaviour — the same deliberate pin-update pattern
 * as the step-17 status-semantics re-pins. The H-11 regression detail
 * lives in the sibling route.test.ts (real founder gate, mocked
 * session seam).
 *
 * All env values used below are fake fixtures invented for this test —
 * never put a real credential value in a test, fixture, or snapshot.
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

// Session seam mocked exactly as in the sibling route.test.ts: the real
// founder gate runs; a Bearer token's suffix is the session uid.
jest.mock('@/lib/auth/verifySession', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextResponse } = require('next/server');
  class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError,
    verifySession: jest.fn(
      async (req: { headers: { get(name: string): string | null } }) => {
        const header = req.headers.get('authorization');
        if (!header?.startsWith('Bearer ')) {
          throw new SessionError('Unauthorized: missing Bearer token', 401);
        }
        return { uid: header.slice('Bearer '.length) };
      },
    ),
    toSessionErrorResponse: (err: unknown) =>
      err instanceof SessionError
        ? NextResponse.json(
            { error: (err as Error).message },
            { status: (err as SessionError).statusCode },
          )
        : null,
  };
});

import { GET } from '../route';
import { FOUNDER_UID } from '@/lib/roles';

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

function founderReq() {
  return req({ authorization: `Bearer ${FOUNDER_UID}` });
}

describe('GET /api/diagnostics/firebase — migration contract', () => {
  // H-11 FIXED (re-pinned at the H-11 merge): a request with no
  // credentials of any kind is rejected and receives NO payload.
  it('H-11 FIXED: unauthenticated request (no headers at all) gets 401 and no environment payload', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.environment).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('fixture-project-id');
  });

  it('response top-level keys are exactly [success, diagnostics, environment, timestamp]', async () => {
    const res = await GET(founderReq());
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['diagnostics', 'environment', 'success', 'timestamp'].sort(),
    );
  });

  it('diagnostics is the verbatim return value of getAdminDiagnostics()', async () => {
    const res = await GET(founderReq());
    const body = await res.json();
    expect(body.diagnostics).toEqual(state.diagnostics);
  });

  it('environment keys are exactly the six pinned names, values are presence booleans only (H-11 fix)', async () => {
    const res = await GET(founderReq());
    const body = await res.json();
    expect(Object.keys(body.environment).sort()).toEqual([...ENV_KEYS].sort());
    expect(body.environment).toEqual({
      FIREBASE_PROJECT_ID: true,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: true,
      GOOGLE_CLOUD_PROJECT: true,
      GCLOUD_PROJECT: true,
      GOOGLE_APPLICATION_CREDENTIALS: true,
      FIREBASE_CONFIG: true,
    });
    // No env VALUE ever leaves the server, including to the founder.
    expect(JSON.stringify(body)).not.toContain('/fake/fixture/service-account.json');
    expect(JSON.stringify(body)).not.toContain('fixture-project-id');
  });

  it('FIREBASE_CONFIG is false (boolean) when the variable is unset, not undefined', async () => {
    delete process.env.FIREBASE_CONFIG;
    const res = await GET(founderReq());
    const body = await res.json();
    expect(body.environment.FIREBASE_CONFIG).toBe(false);
  });

  it('timestamp is an ISO-8601 string generated at request time', async () => {
    const before = Date.now();
    const res = await GET(founderReq());
    const body = await res.json();
    const ts = Date.parse(body.timestamp);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // Re-pinned at the H-11 merge: the fixed route no longer echoes the
  // raw error message in the 500 body (it is logged server-side only).
  it('diagnostics failure -> 500 { success: false, error: "Failed to check Firebase configuration" }', async () => {
    state.diagnosticsError = new Error('diag exploded');
    const res = await GET(founderReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Failed to check Firebase configuration',
    });
  });
});
