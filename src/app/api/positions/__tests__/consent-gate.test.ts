/**
 * @jest-environment node
 *
 * Positions consent-gate tests (spec B.7 cases 8-9 and B.3a.4).
 */

jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    assertConsentFor: jest.fn(),
    isCategoryBRole: jest.fn(),
    canonicaliseRoleKey: (k: string) => String(k ?? '').trim().toLowerCase(),
    consentGateHttpError: (err: unknown) =>
      err instanceof types.ConsentRequiredError
        ? {
            status: 409,
            body: {
              error: 'CONSENT_REQUIRED',
              code: 'CONSENT_REQUIRED',
              matter: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).matterKey,
              reason: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).reason,
              subject: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).subjectRef,
              consentRequestId: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).consentRequestId,
              fileRequestUrl: (err as import('@/lib/server/consent-gate-types').ConsentRequiredError).fileRequestUrl,
            },
          }
        : { status: 500, body: { error: 'CONSENT_CHECK_UNAVAILABLE', code: 'CONSENT_CHECK_UNAVAILABLE' } },
  };
});

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'token-1',
  verifyIdTokenString: jest.fn(async () => {
    const pid =
      process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'test-proj';
    return { uid: 'admin-1', iss: `https://securetoken.google.com/${pid}`, aud: pid };
  }),
  SessionError: class SessionError extends Error {
    statusCode = 401;
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({
      getUser: async () => ({ customClaims: { managePositions: true } }),
    }),
  },
  getDb: () => mockDbHolder.db,
}));

import { NextRequest } from 'next/server';
import { POST, PATCH, DELETE } from '@/app/api/positions/route';
import { assertConsentFor, isCategoryBRole } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockGate = assertConsentFor as jest.Mock;
const mockIsCatB = isCategoryBRole as jest.Mock;

function makeDb(position: Record<string, unknown> | null) {
  const db = {
    collection: (name: string) => {
      if (name === 'positions') {
        return {
          add: async () => ({ id: 'pos-new' }),
          doc: (id: string) => ({
            get: async () =>
              position
                ? { exists: true, id, data: () => position }
                : { exists: false, id, data: () => undefined },
            update: async () => undefined,
            delete: async () => undefined,
          }),
        };
      }
      if (name === 'users') {
        return {
          doc: (id: string) => ({
            get: async () => ({
              exists: true,
              id,
              data: () => ({ displayName: 'Test User', email: 'u@example.com' }),
            }),
          }),
        };
      }
      return { add: async () => ({ id: 'x' }), doc: () => ({ get: async () => ({ exists: false }) }) };
    },
  };
  return db;
}

function req(method: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/positions', {
    method,
    body: JSON.stringify(body),
    headers: { Authorization: 'Bearer token-1' },
  });
}

function gateMissing() {
  return new ConsentRequiredError({
    matterKey: 'catb_officer',
    subjectRef: { type: 'position', targetUid: 'user-1', roleKey: 'president_national', action: 'appoint' },
    consentRequestId: null,
    reason: 'missing',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsCatB.mockImplementation(async (_db: unknown, key: string) => key === 'president_national');
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockDbHolder.db = makeDb(null);
});

it('POST appointing a Category B position without consent returns 409 CONSENT_REQUIRED', async () => {
  mockGate.mockRejectedValue(gateMissing());
  const res = await POST(
    req('POST', { role: 'president_national', userId: 'user-1', startDate: '2026-10-21' }),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CONSENT_REQUIRED');
});

it('POST a non-Category B position proceeds with no gate call', async () => {
  const res = await POST(
    req('POST', { role: 'chair_events', userId: 'user-1', startDate: '2026-10-21' }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
});

it('DELETE of a current Category B position without consent returns 409 and deletes nothing', async () => {
  mockGate.mockRejectedValue(gateMissing());
  mockDbHolder.db = makeDb({ role: 'president_national', userId: 'user-1', endDate: null });
  const res = await DELETE(req('DELETE', { positionId: 'pos-1' }));
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CONSENT_REQUIRED');
});

it('DELETE of an already-ended Category B position is ungated record-keeping', async () => {
  mockDbHolder.db = makeDb({
    role: 'president_national',
    userId: 'user-1',
    endDate: new Date('2026-01-01'),
  });
  const res = await DELETE(req('DELETE', { positionId: 'pos-1' }));
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Fix 1 Tier 2 (plan 4.2, G13-G16): founder-act pass-through, invalid
// ordering, and the plan R9 double-gate PATCH shape. Gate is mocked;
// the real founder logic is Tier 1's job.
// ---------------------------------------------------------------------------

describe('Fix 1 Tier 2: founder act + invalid ordering (G13-G16)', () => {
  it('G13 founder act: gate resolving founder_act lets a Category B appointment proceed', async () => {
    mockGate.mockResolvedValue({
      mode: 'hard',
      outcome: 'founder_act',
      consentRequestId: 'cr-auto-1',
    });
    const res = await POST(
      req('POST', { role: 'president_national', userId: 'user-1', startDate: '2026-10-21' }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        matterKey: 'catb_officer',
        subjectRef: {
          type: 'position',
          targetUid: 'user-1',
          roleKey: 'president_national',
          action: 'appoint',
        },
      }),
    );
  });

  it('G13 invalid request: an invalid start date returns 400 BEFORE the gate (gate never called, no record possible)', async () => {
    const res = await POST(
      req('POST', { role: 'president_national', userId: 'user-1', startDate: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('G13 invalid request: a schema-invalid body returns 400 BEFORE the gate', async () => {
    const res = await POST(req('POST', { role: 'president_national' }));
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('G14+G15 founder act (plan R9): a PATCH that ends a current CatB position AND appoints a CatB successor calls the gate TWICE, once per subject', async () => {
    mockGate.mockResolvedValue({
      mode: 'hard',
      outcome: 'founder_act',
      consentRequestId: 'cr-auto-1',
    });
    mockDbHolder.db = makeDb({ role: 'president_national', userId: 'user-1', endDate: null });
    const res = await PATCH(
      req('PATCH', {
        positionId: 'pos-1',
        updates: { endDate: '2026-11-01', role: 'president_national' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(2);
    const subjects = mockGate.mock.calls.map(
      (c) => (c[0] as { subjectRef: { action: string } }).subjectRef.action,
    );
    expect(subjects.sort()).toEqual(['appoint', 'remove']);
  });

  it('G14 non-founder without consent: PATCH ending a current CatB position returns the exact 409 body', async () => {
    mockGate.mockRejectedValue(gateMissing());
    mockDbHolder.db = makeDb({ role: 'president_national', userId: 'user-1', endDate: null });
    const res = await PATCH(
      req('PATCH', { positionId: 'pos-1', updates: { endDate: '2026-11-01' } }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
  });

  it('G16 founder act: gate resolving founder_act lets the delete of a current CatB position proceed', async () => {
    mockGate.mockResolvedValue({
      mode: 'hard',
      outcome: 'founder_act',
      consentRequestId: 'cr-auto-1',
    });
    mockDbHolder.db = makeDb({ role: 'president_national', userId: 'user-1', endDate: null });
    const res = await DELETE(req('DELETE', { positionId: 'pos-1' }));
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
  });

  it('G16 invalid request: a missing positionId returns 400 BEFORE the gate', async () => {
    const res = await DELETE(req('DELETE', {}));
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });
});
