/**
 * @jest-environment node
 *
 * Regression tests for POST /api/client-errors (Team 3 sink).
 *
 * (a) A valid sanitized report lands in the `client_errors` collection via
 *     the Admin SDK with the server-attached uid, and unknown keys
 *     (e.g. a smuggled email or form value) are dropped, never stored.
 * (b) Malformed / oversized payloads are rejected 400 / 413 without a
 *     Firestore write, and an Admin SDK failure still returns 200 because
 *     the server log line is the durable fallback.
 */

const mockState = {
  adminReady: true,
  addError: null as unknown,
  addedDocs: [] as Array<Record<string, unknown>>,
  verifiedUid: 'uid-from-token',
  verifyShouldThrow: false,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => mockState.adminReady),
  getDb: jest.fn(() => ({
    collection: (_name: string) => ({
      add: async (doc: Record<string, unknown>) => {
        if (mockState.addError) throw mockState.addError;
        mockState.addedDocs.push(doc);
        return { id: 'mock-doc-id' };
      },
    }),
  })),
}));

jest.mock('@/lib/auth/verifySession', () => ({
  verifyIdTokenString: jest.fn(async () => {
    if (mockState.verifyShouldThrow) throw new Error('bad token');
    return { uid: mockState.verifiedUid };
  }),
}));

import { POST } from '@/app/api/client-errors/route';
import { NextRequest } from 'next/server';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'induction-submit-failure',
    operation: 'batch.commit',
    errorCode: 'permission-denied',
    errorMessage: 'Missing or insufficient permissions.',
    payloadFieldNames: ['uid', 'email', 'status', 'hasApplied'],
    context: 'induction-submit',
    clientBuildId: 'unknown',
    tabLoadedAt: '2026-10-14T00:00:00.000Z',
    tabAgeMs: 1234,
    isStaleTabSuspected: false,
    freshnessStatus: 'fresh',
    liveBuildId: 'abc123',
    clientTimestamp: '2026-10-14T00:00:01.000Z',
    userAgent: 'jest',
    pathname: '/induction',
    ...overrides,
  };
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockState.adminReady = true;
  mockState.addError = null;
  mockState.addedDocs = [];
  mockState.verifyShouldThrow = false;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/client-errors', () => {
  it('stores a valid report with the verified uid and drops unknown keys', async () => {
    const res = await POST(
      postRequest({
        ...validBody(),
        email: 'smuggled@example.com',
        secretValue: 'SECRET-FORM-VALUE',
      }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockState.addedDocs).toHaveLength(1);
    const stored = mockState.addedDocs[0];
    expect(stored.errorCode).toBe('permission-denied');
    expect(stored.operation).toBe('batch.commit');
    expect(stored.payloadFieldNames).toEqual(['uid', 'email', 'status', 'hasApplied']);
    // No token was sent, so uid is null; smuggled keys never stored.
    expect(stored.uid).toBeNull();
    expect(stored).not.toHaveProperty('secretValue');
    expect(JSON.stringify(stored)).not.toContain('smuggled@example.com');
    expect(JSON.stringify(stored)).not.toContain('SECRET-FORM-VALUE');
  });

  it('attaches the verified token uid when a Bearer token is present', async () => {
    const res = await POST(
      postRequest(validBody(), { Authorization: 'Bearer good-token' }));
    expect(res.status).toBe(200);
    expect(mockState.addedDocs[0].uid).toBe('uid-from-token');
  });

  it('still returns 200 with uid null when the token is invalid (no 401)', async () => {
    mockState.verifyShouldThrow = true;
    const res = await POST(
      postRequest(validBody(), { Authorization: 'Bearer bad-token' }));
    expect(res.status).toBe(200);
    expect(mockState.addedDocs[0].uid).toBeNull();
  });

  it('rejects a malformed payload with 400 and no Firestore write', async () => {
    const res = await POST(
      postRequest(validBody({ payloadFieldNames: 'not-an-array' })));
    expect(res.status).toBe(400);
    expect(mockState.addedDocs).toHaveLength(0);
  });

  it('rejects invalid JSON with 400 and an oversized body with 413', async () => {
    const badJson = await POST(
      postRequest('{not json'));
    expect(badJson.status).toBe(400);
    const big = await POST(
      postRequest('x'.repeat(17 * 1024)));
    expect(big.status).toBe(413);
    expect(mockState.addedDocs).toHaveLength(0);
  });

  it('still returns 200 when the Admin SDK write fails (server log fallback)', async () => {
    mockState.addError = new Error('admin down');
    const res = await POST(
      postRequest(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
