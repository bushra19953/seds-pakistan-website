/**
 * @jest-environment node
 *
 * Parity tests for /api/chapter-applications (Family F, F8-F10).
 *
 * The gate used to read the token's `role` CLAIM (D-CLAIM). It now calls
 * hasServerPermissionForUser(db, decoded.uid, 'canManageChapterApplications')
 * against Firestore. These tests run the REAL permissions module over an
 * in-memory Firestore and hand the route a decoded token with NO role
 * claim at all: admission can only come from the holder record.
 *
 * Canonical holder fixture: primary `member` + additionalRoles
 * ['custom_verify_design_aide'] + roleDefinitions/custom_verify_design_aide
 * { isCustom: true, permissions: ['canManageChapterApplications'] }.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'holder-1' };

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({
      // Deliberately NO `role` property: a token claim must not admit anyone.
      verifyIdToken: async () => ({ uid: mockState.uid }),
    }),
    firestore: {
      Timestamp: {
        now: () => new Date(),
        fromDate: (d: Date) => d,
      },
      FieldValue: {
        serverTimestamp: () => new Date(),
        delete: () => ({ __delete: true }),
      },
    },
  },
  getDb: () => mockHolder.db,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/app/actions/chapter-applications', () => ({
  updateChapterApplicationStatus: jest.fn(async () => ({ success: true, chapterId: 'chap-1' })),
  deleteChapterWithCleanup: jest.fn(async () => ({ success: true, usersUpdated: 2 })),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

jest.mock('@/lib/server/consent-gate', () => ({
  consentGateHttpError: jest.fn(() => ({ status: 409, body: { error: 'consent required' } })),
}));

jest.mock('@/lib/server/consent-gate-types', () => {
  class ConsentRequiredError extends Error {}
  return { ConsentRequiredError };
});

import { GET, PATCH, DELETE } from '@/app/api/chapter-applications/route';

const CUSTOM = 'custom_verify_design_aide';
const KEY = 'canManageChapterApplications';

function seedDefinition(db: FakeFirestore) {
  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: [KEY] });
}

function seedHolder(db: FakeFirestore, uid: string, extra: Record<string, unknown> = {}) {
  db.__seed('roles', uid, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...extra,
  });
}

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/chapter-applications', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let db: FakeFirestore;

beforeEach(() => {
  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'holder-1';
  seedDefinition(db);
  seedHolder(db, 'holder-1');
  seedHolder(db, 'expired-1', {
    expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresRoleKey: CUSTOM,
  });
  db.__seed('roles', 'plain-1', { role: 'member' });
  db.__seed('chapter_applications', 'app-1', {
    applicantId: 'applicant-1',
    proposedChapterName: 'SEDS Fixture',
    status: 'pending_review',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('chapter-applications parity (F8-F10)', () => {
  it('GET: custom holder (primary member) is admitted via Firestore, not the token claim', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].id).toBe('app-1');
  });

  it('PATCH: custom holder is admitted', async () => {
    const res = await PATCH(
      req('PATCH', { applicationId: 'app-1', status: 'under_review' })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('DELETE: custom holder is admitted', async () => {
    const res = await DELETE(req('DELETE', { chapterId: 'chap-1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('GET: expired custom grant is denied with the original 403 body', async () => {
    mockState.uid = 'expired-1';
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('PATCH: expired custom grant is denied with the original 403 body', async () => {
    mockState.uid = 'expired-1';
    const res = await PATCH(
      req('PATCH', { applicationId: 'app-1', status: 'under_review' })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('GET: caller with no grant is denied with the original 403 body', async () => {
    mockState.uid = 'plain-1';
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
