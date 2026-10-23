/**
 * @jest-environment node
 *
 * Parity tests for POST /api/v1/chapters/invoice (Family F, F16).
 *
 * The staff arm of Gate 3 used to derive the caller's role via
 * resolveCanonicalRole(db, callerUid) feeding hasServerPermission; it now
 * calls hasServerPermissionForUser(db, callerUid,
 * 'canManageChapterApplications'). These tests run the REAL permissions
 * module over an in-memory Firestore; the existing route.test.ts suite in
 * this directory keeps the mocked-permission coverage of the other gates.
 *
 * Canonical holder fixture: primary `member` + additionalRoles
 * ['custom_verify_design_aide'] + roleDefinitions/custom_verify_design_aide
 * { isCustom: true, permissions: ['canManageChapterApplications'] }.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'staff-1', saves: [] as Array<{ path: string }> };

const mockStorage = {
  bucket: (_name: string) => ({
    file: (path: string) => ({
      save: async () => {
        mockState.saves.push({ path });
      },
      getSignedUrl: async () => ['https://storage.example.test/invoice.pdf'],
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: () => mockHolder.db,
  getAdminStorage: () => mockStorage,
}));

jest.mock('@/lib/auth/verifySession', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextResponse } = require('next/server');
  class SessionError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'SessionError';
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError,
    verifySession: jest.fn(async () => ({ uid: mockState.uid })),
    toSessionErrorResponse: (err: unknown) =>
      err instanceof SessionError
        ? NextResponse.json({ error: err.message }, { status: err.statusCode })
        : null,
  };
});

import { POST } from '@/app/api/v1/chapters/invoice/route';

const CUSTOM = 'custom_verify_design_aide';
const KEY = 'canManageChapterApplications';
const FORBIDDEN_BODY = {
  error: 'Forbidden: you can only generate an invoice for your own chapter application',
};

const VALID_ENV = {
  SEDS_NTN: '1234567-8',
  SEDS_BANK_NAME: 'Fixture Bank Limited',
  SEDS_IBAN: 'PK36FIXT0000001123456702',
};

const ENV_KEYS = ['SEDS_NTN', 'SEDS_BANK_NAME', 'SEDS_IBAN', 'SEDS_PAYEE_NAME'];
let savedEnv: Record<string, string | undefined> = {};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    applicantId: 'user-b',
    applicantName: 'Applicant B',
    applicantEmail: 'b@example.com',
    institutional: {
      universityName: 'Fixture University',
      campusCity: 'Islamabad',
      deanOrFocalName: 'Fixture Dean',
      deanOrFocalEmail: 'dean@example.com',
      postalAddress: 'Fixture Address, Islamabad',
    },
    officers: [
      { role: 'president', name: 'Officer One', email: 'one@example.com' },
      { role: 'vice_president', name: 'Officer Two', email: 'two@example.com' },
      { role: 'secretary', name: 'Officer Three', email: 'three@example.com' },
      { role: 'treasurer', name: 'Officer Four', email: 'four@example.com' },
      { role: 'communications', name: 'Officer Five', email: 'five@example.com' },
    ],
    beachhead: { hasExistingSpaceSociety: false },
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/chapters/invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let db: FakeFirestore;

function collectionSize(name: string): number {
  return ((db as any).__store.get(name) as Map<string, unknown> | undefined)?.size ?? 0;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v;
  delete process.env.SEDS_PAYEE_NAME;

  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'staff-1';
  mockState.saves = [];

  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: [KEY] });
  db.__seed('roles', 'staff-1', { role: 'member', additionalRoles: [CUSTOM] });
  db.__seed('roles', 'expired-1', {
    role: 'member',
    additionalRoles: [CUSTOM],
    expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresRoleKey: CUSTOM,
  });
  db.__seed('roles', 'plain-1', { role: 'member' });
  db.__seed('users', 'user-b', { isBlacklisted: false });
  db.__seed('warningConfig', 'global', { enforcementEnabled: true });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  (console.error as jest.Mock).mockRestore?.();
});

describe('invoice staff-gate parity (F16)', () => {
  it('custom holder acting for another applicant is admitted and issues the invoice', async () => {
    const res = await POST(postRequest(validBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(collectionSize('chapter_applications')).toBe(1);
    expect(collectionSize('audit_logs')).toBe(1);
    expect(mockState.saves).toHaveLength(1);
  });

  it('expired custom grant is denied with the original 403 body and zero writes', async () => {
    mockState.uid = 'expired-1';
    const res = await POST(postRequest(validBody()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN_BODY);
    expect(collectionSize('chapter_applications')).toBe(0);
    expect(collectionSize('audit_logs')).toBe(0);
    expect(mockState.saves).toHaveLength(0);
  });

  it('staff caller with no grant is denied with the original 403 body and zero writes', async () => {
    mockState.uid = 'plain-1';
    const res = await POST(postRequest(validBody()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN_BODY);
    expect(collectionSize('chapter_applications')).toBe(0);
    expect(collectionSize('audit_logs')).toBe(0);
    expect(mockState.saves).toHaveLength(0);
  });
});
