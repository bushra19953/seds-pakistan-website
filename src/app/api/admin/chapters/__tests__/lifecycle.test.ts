/**
 * @jest-environment node
 *
 * Chapters API lifecycle classification tests (spec B.7 case 12 + B.3b.4):
 * suspend is gated, reactivation is not, cosmetic edits are not.
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
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/admin/chapters/[id]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;

function makeDb(chapter: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    __updates: updates,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: true, id, data: () => chapter }),
        update: async (data: Record<string, unknown>) => {
          updates.push(data);
        },
      }),
    }),
  };
  return db;
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/chapters/seds-test', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'seds-test' }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  });
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
});

it('suspending an active chapter without consent returns 409 and writes nothing', async () => {
  const db = makeDb({ name: 'SEDS Test', isActive: true, status: 'active' });
  mockDbHolder.db = db;
  mockGate.mockRejectedValue(
    new ConsentRequiredError({
      matterKey: 'chapter_lifecycle',
      subjectRef: { type: 'chapter', chapterId: 'seds-test', action: 'suspend' },
      consentRequestId: null,
      reason: 'missing',
    }),
  );
  const res = await PATCH(req({ isActive: false }), params);
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('CONSENT_REQUIRED');
  expect(db.__updates).toHaveLength(0);
});

it('reactivating a suspended chapter is NOT gated', async () => {
  const db = makeDb({ name: 'SEDS Test', isActive: false, status: 'suspended' });
  mockDbHolder.db = db;
  const res = await PATCH(req({ isActive: true }), params);
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
  expect(db.__updates).toHaveLength(1);
  expect(db.__updates[0].status).toBe('active');
});

it('cosmetic-only edits are NOT gated', async () => {
  const db = makeDb({ name: 'SEDS Test', isActive: true, status: 'active' });
  mockDbHolder.db = db;
  const res = await PATCH(req({ city: 'Karachi', logoUrl: 'https://example.com/logo.png' }), params);
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
  expect(db.__updates[0].city).toBe('Karachi');
});
