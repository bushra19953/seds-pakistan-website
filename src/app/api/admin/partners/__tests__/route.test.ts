/**
 * @jest-environment node
 *
 * Sponsor/partner gate tests (spec B.7 cases 17-19). The gate is mocked to
 * hard mode; needsPartnerGate runs for real.
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
import { POST, PATCH, DELETE } from '@/app/api/admin/partners/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;

function makeDb(existing: Record<string, unknown> | null) {
  const state = {
    added: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    deletes: 0,
  };
  const db = {
    __state: state,
    collection: () => ({
      add: async (data: Record<string, unknown>) => {
        state.added.push(data);
        return { id: 'partner-new' };
      },
      doc: (id: string) => ({
        get: async () =>
          existing
            ? { exists: true, id, data: () => existing }
            : { exists: false, id, data: () => undefined },
        update: async (data: Record<string, unknown>) => {
          state.updates.push(data);
        },
        delete: async () => {
          state.deletes += 1;
        },
      }),
    }),
  };
  return db;
}

function req(method: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/partners', {
    method,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  });
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockDbHolder.db = makeDb(null);
});

it('flagged create without consent returns 409 and creates nothing (hard mode)', async () => {
  mockGate.mockRejectedValue(
    new ConsentRequiredError({
      matterKey: 'sponsor_partner_flagged',
      subjectRef: {
        type: 'partner_record',
        recordId: null,
        organizationName: 'Acme',
        collection: 'sponsors_partners',
        action: 'create',
      },
      consentRequestId: null,
      reason: 'missing',
    }),
  );
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await POST(
    req('POST', { organizationName: 'Acme', isRelatedParty: true, relatedPartyNature: 'Founder employer' }),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('CONSENT_REQUIRED');
  expect(db.__state.added).toHaveLength(0);
});

it('flagged create with consent proceeds (subject names the organisation, recordId null)', async () => {
  const res = await POST(
    req('POST', { organizationName: 'Acme', carriesConditions: true, consentRequestId: 'cr-1' }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      matterKey: 'sponsor_partner_flagged',
      subjectRef: {
        type: 'partner_record',
        recordId: null,
        organizationName: 'Acme',
        collection: 'sponsors_partners',
        action: 'create',
      },
    }),
  );
});

it('unflagged create never consults the gate', async () => {
  const res = await POST(req('POST', { organizationName: 'Plain Sponsor Co' }));
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
});

it('an interaction-only update on a flagged record is exempt', async () => {
  mockDbHolder.db = makeDb({ organizationName: 'Acme', isRelatedParty: true, timeline: [] });
  const res = await PATCH(
    req('PATCH', {
      id: 'p-1',
      timeline: [{ id: 'i-1', type: 'call', direction: 'sent', content: 'Called', timestamp: null, author: 'admin' }],
      lastActivityAt: '2026-10-21T00:00:00.000Z',
      lastActivityType: 'Call',
    }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  expect(db.__state.updates).toHaveLength(1);
});

it('a substantive update on a flagged record is gated', async () => {
  mockDbHolder.db = makeDb({ organizationName: 'Acme', isRelatedParty: true, financials: { pledgedAmount: 100 } });
  const res = await PATCH(
    req('PATCH', { id: 'p-1', financials: { pledgedAmount: 5000 }, consentRequestId: 'cr-1' }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'partner_record', recordId: 'p-1', collection: 'sponsors_partners', action: 'update' },
    }),
  );
});

it('unflagging a record (resulting record unflagged) is ungated', async () => {
  mockDbHolder.db = makeDb({ organizationName: 'Acme', isRelatedParty: true });
  const res = await PATCH(req('PATCH', { id: 'p-1', isRelatedParty: false }));
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
});

it('deletion is never gated', async () => {
  mockDbHolder.db = makeDb({ organizationName: 'Acme', isRelatedParty: true });
  const res = await DELETE(req('DELETE', { id: 'p-1' }));
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  expect(db.__state.deletes).toBe(1);
});
