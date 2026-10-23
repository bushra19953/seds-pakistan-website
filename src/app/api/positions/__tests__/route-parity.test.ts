/**
 * @jest-environment node
 *
 * Family G parity tests for POST /api/positions (G4).
 *
 * checkPositionManagementPermission has two arms:
 *  - the token-claims pre-arm (claims.managePositions via
 *    admin.auth().getUser) is OUT OF SCOPE for the parity program and
 *    must stay byte-identical — pinned here by the claims-only case,
 *    which passes with NO Firestore role record at all;
 *  - the Firestore arm now resolves holder-scoped via
 *    hasServerPermissionForUser(db, uid, 'canManagePositions'), so a
 *    holder whose primary is `member` with the key only in a custom
 *    additionalRoles grant is admitted; expired / missing grants keep
 *    the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver runs against a hand-rolled
 * Firestore double serving roles / users / roleDefinitions docs.
 * The consent gate is mocked off (isCategoryBRole -> false), exactly
 * as in the sibling consent-gate suite, which keeps passing unchanged.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const state = {
  claims: {} as Record<string, unknown>,
};

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn(async () => ({ mode: 'hard', outcome: 'consented' })),
  isCategoryBRole: jest.fn(async () => false),
  canonicaliseRoleKey: (k: string) => String(k ?? '').trim().toLowerCase(),
  consentGateHttpError: () => ({ status: 500, body: { error: 'CONSENT_CHECK_UNAVAILABLE' } }),
}));

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'token-1',
  verifyIdTokenString: jest.fn(async () => {
    const pid =
      process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'test-proj';
    return { uid: 'holder-1', iss: `https://securetoken.google.com/${pid}`, aud: pid };
  }),
  SessionError: class SessionError extends Error {
    statusCode = 401;
  },
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({
      getUser: async () => ({ customClaims: state.claims }),
    }),
    firestore: {
      Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
    },
  },
  getDb: () => mockDbHolder.db,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/positions/route';

function makeDb() {
  const docs: Record<string, any> = {
    'users/user-1': { displayName: 'Test User', email: 'u@example.com' },
  };
  const db = {
    docs,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs[`${name}/${id}`];
          return { exists: data !== undefined, id, data: () => data };
        },
        update: async () => undefined,
        delete: async () => undefined,
      }),
      add: async (data: any) => {
        docs[`${name}/pos-new`] = data;
        return { id: 'pos-new' };
      },
    }),
  };
  return db;
}

function seedHolder(db: ReturnType<typeof makeDb>, expired = false) {
  db.docs[`roles/${HOLDER}`] = {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? { expiresAt: new Date(Date.now() - 60_000), expiresRoleKey: CUSTOM }
      : {}),
  };
  db.docs[`roleDefinitions/${CUSTOM}`] = {
    isCustom: true,
    permissions: ['canManagePositions'],
  };
}

function createReq() {
  return new NextRequest('http://localhost/api/positions', {
    method: 'POST',
    body: JSON.stringify({ role: 'chair_events', userId: 'user-1', startDate: '2026-10-21' }),
    headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  state.claims = {};
  mockDbHolder.db = makeDb();
});

describe('POST /api/positions permission parity (G4)', () => {
  it('claims arm untouched: a managePositions token claim passes with no Firestore role record', async () => {
    state.claims = { managePositions: true };
    const res = await POST(createReq());
    expect(res.status).toBe(200);
    expect((mockDbHolder.db as any).docs['positions/pos-new']).toBeDefined();
  });

  it('Firestore arm: primary member with canManagePositions only via a custom grant can create a position', async () => {
    seedHolder(mockDbHolder.db as ReturnType<typeof makeDb>);
    const res = await POST(createReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect((mockDbHolder.db as any).docs['positions/pos-new']).toBeDefined();
  });

  it('Firestore arm: expired custom grant keeps the original 403', async () => {
    seedHolder(mockDbHolder.db as ReturnType<typeof makeDb>, true);
    const res = await POST(createReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: insufficient privileges to manage positions',
    });
    expect((mockDbHolder.db as any).docs['positions/pos-new']).toBeUndefined();
  });

  it('Firestore arm: no custom grant keeps the original 403', async () => {
    (mockDbHolder.db as any).docs[`roles/${HOLDER}`] = { role: 'member' };
    const res = await POST(createReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: insufficient privileges to manage positions',
    });
  });
});
