/**
 * @jest-environment node
 *
 * Fix 1 Tier 2 (plan 4.2, G3/G4): founder-act coverage for both chapter
 * routes — POST /api/admin/chapters (admit) and PATCH
 * /api/admin/chapters/[id] (suspend/expel). The PATCH lifecycle
 * classification cases live in lifecycle.test.ts in this folder; this
 * file covers both routes' founder passes and the invalid-ordering
 * property (permission / validation / duplicate / not-found all run
 * BEFORE the gate, so a refused request can never leave an
 * auto-consent record — the writer is gate-internal). The gate is
 * mocked; the real founder logic is Tier 1's job.
 */

jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    assertConsentFor: jest.fn(),
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

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'ts' },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/chapters/route';
import { PATCH } from '@/app/api/admin/chapters/[id]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockPermForUser = hasServerPermissionForUser as jest.Mock;

function makeDb(opts: { chapterExists?: boolean; chapter?: Record<string, unknown> } = {}) {
  const sets: Array<{ id: string; data: Record<string, unknown> }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const chapter = opts.chapter ?? { name: 'SEDS Test', isActive: true, status: 'active' };
  const db = {
    __sets: sets,
    __updates: updates,
    collection: () => ({
      doc: (id: string) => ({
        get: async () =>
          opts.chapterExists
            ? { exists: true, id, data: () => chapter }
            : { exists: false, id, data: () => undefined },
        set: async (data: Record<string, unknown>) => {
          sets.push({ id, data });
        },
        update: async (data: Record<string, unknown>) => {
          updates.push(data);
        },
      }),
    }),
  };
  return db;
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/chapters', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function patchReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/chapters/seds-test', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

const patchParams = { params: Promise.resolve({ id: 'seds-test' }) };

function gateMissing(action: string) {
  return new ConsentRequiredError({
    matterKey: 'chapter_lifecycle',
    subjectRef: { type: 'chapter', chapterId: 'seds-test', action: action as never },
    consentRequestId: null,
    reason: 'missing',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  });
  mockPermForUser.mockResolvedValue(true);
  mockGate.mockResolvedValue({
    mode: 'hard',
    outcome: 'founder_act',
    consentRequestId: 'cr-auto-1',
  });
  mockDbHolder.db = makeDb({ chapterExists: false });
});

describe('G4 POST /api/admin/chapters (admit)', () => {
  it('founder act: gate resolving founder_act creates the chapter', async () => {
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await POST(postReq({ name: 'SEDS Test', slug: 'seds-test' }));
    expect(res.status).toBe(200);
    expect((await res.json()).chapterId).toBe('seds-test');
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        matterKey: 'chapter_lifecycle',
        subjectRef: { type: 'chapter', chapterId: 'seds-test', action: 'admit' },
      }),
    );
    expect(db.__sets).toHaveLength(1);
  });

  it('invalid: missing name/slug returns 400 BEFORE the gate', async () => {
    const res = await POST(postReq({ name: 'SEDS Test' }));
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('invalid: a non-kebab slug returns 400 BEFORE the gate', async () => {
    const res = await POST(postReq({ name: 'SEDS Test', slug: 'SEDS Test!' }));
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('invalid: a duplicate slug returns 409 BEFORE the gate', async () => {
    mockDbHolder.db = makeDb({ chapterExists: true });
    const res = await POST(postReq({ name: 'SEDS Test', slug: 'seds-test' }));
    expect(res.status).toBe(409);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('permission denied returns 403 BEFORE the gate', async () => {
    mockPermForUser.mockResolvedValue(false);
    const res = await POST(postReq({ name: 'SEDS Test', slug: 'seds-test' }));
    expect(res.status).toBe(403);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('non-founder without consent: the gate throw surfaces the exact 409 body and creates nothing', async () => {
    mockGate.mockRejectedValue(gateMissing('admit'));
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await POST(postReq({ name: 'SEDS Test', slug: 'seds-test' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
    expect(db.__sets).toHaveLength(0);
  });
});

describe('G3 PATCH /api/admin/chapters/[id] (suspend/expel)', () => {
  beforeEach(() => {
    mockDbHolder.db = makeDb({
      chapterExists: true,
      chapter: { name: 'SEDS Test', isActive: true, status: 'active' },
    });
  });

  it('founder act: gate resolving founder_act lets the suspension write through', async () => {
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await PATCH(patchReq({ isActive: false }), patchParams);
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectRef: { type: 'chapter', chapterId: 'seds-test', action: 'suspend' },
      }),
    );
    expect(db.__updates).toHaveLength(1);
  });

  it('permission denied returns 403 BEFORE the gate', async () => {
    mockPermForUser.mockResolvedValue(false);
    const res = await PATCH(patchReq({ isActive: false }), patchParams);
    expect(res.status).toBe(403);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('non-founder without consent: suspend returns the exact 409 body and writes nothing', async () => {
    mockGate.mockRejectedValue(gateMissing('suspend'));
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await PATCH(patchReq({ isActive: false }), patchParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
    expect(db.__updates).toHaveLength(0);
  });
});
