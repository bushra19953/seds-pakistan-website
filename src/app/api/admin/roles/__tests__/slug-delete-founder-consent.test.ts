/**
 * @jest-environment node
 *
 * Fix 1 Tier 2 (plan 4.2, G9): DELETE /api/admin/roles/[slug] founder-act
 * coverage. The actor-set, fence and denial regressions for this route
 * live in slug-delete.test.ts; this file adds the founder-act pass and
 * pins the ordering property (fences and validation run BEFORE the
 * gate, so a refused delete can never leave an auto-consent record —
 * the writer is reachable only from inside assertConsentFor). The gate
 * is mocked; the real founder logic is Tier 1's job.
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

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(false),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { NextRequest } from 'next/server';
import { DELETE } from '@/app/api/admin/roles/[slug]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;

interface Op {
  op: string;
  col: string;
  id: string;
}

function makeDb(state: { holders?: number } = {}) {
  const ops: Op[] = [];
  const db = {
    __ops: ops,
    collection: (name: string) => ({
      doc: (id?: string) => ({
        __col: name,
        __id: id ?? 'auto-id',
        get: async () => {
          if (name === 'roleDefinitions') {
            return { exists: true, id, data: () => ({ name: 'Poster Team' }) };
          }
          return { exists: false, id, data: () => undefined };
        },
      }),
      where: () => ({
        get: async () => {
          const holders = state.holders ?? 0;
          const ids = Array.from({ length: holders }, (_, i) => `holder-${i + 1}`);
          return {
            empty: ids.length === 0,
            size: ids.length,
            docs: ids.map((id) => ({ id })),
            forEach: () => undefined,
          };
        },
      }),
    }),
    batch: () => {
      const batchOps: Op[] = [];
      return {
        set: (ref: { __col: string; __id: string }) =>
          batchOps.push({ op: 'set', col: ref.__col, id: ref.__id }),
        delete: (ref: { __col: string; __id: string }) =>
          batchOps.push({ op: 'delete', col: ref.__col, id: ref.__id }),
        update: (ref: { __col: string; __id: string }) =>
          batchOps.push({ op: 'update', col: ref.__col, id: ref.__id }),
        commit: async () => {
          ops.push(...batchOps);
        },
      };
    },
  };
  return db;
}

function req(slug: string) {
  return new NextRequest(`http://localhost/api/admin/roles/${slug}`, {
    method: 'DELETE',
    body: JSON.stringify({}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockResolvedValue({
    mode: 'hard',
    outcome: 'founder_act',
    consentRequestId: 'cr-auto-1',
  });
  mockDbHolder.db = makeDb({});
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: FOUNDER_UID, role: 'member', displayName: 'Founder', email: 'f@example.com' },
  });
});

describe('G9 founder act + ordering', () => {
  it('founder act: gate resolving founder_act deletes all three stores, gate called once with the delete subject', async () => {
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await DELETE(req('custom_poster_team_lead'), {
      params: { slug: 'custom_poster_team_lead' },
    });
    expect(res.status).toBe(200);
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUid: FOUNDER_UID,
        matterKey: 'role_catalog',
        subjectRef: { type: 'role_definition', slug: 'custom_poster_team_lead', action: 'delete' },
      }),
    );
    const deletes = db.__ops.filter((o) => o.op === 'delete').map((o) => o.col);
    expect(deletes).toEqual(expect.arrayContaining(['roleDefinitions', 'permissions', 'role_permissions']));
  });

  it('invalid: a protected slug returns 400 BEFORE the gate (gate never called, no record possible)', async () => {
    const res = await DELETE(req('member'), { params: { slug: 'member' } });
    expect(res.status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('invalid: the holders fence returns 409 BEFORE the gate (gate never called, no record possible)', async () => {
    mockDbHolder.db = makeDb({ holders: 2 });
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await DELETE(req('custom_poster_team_lead'), {
      params: { slug: 'custom_poster_team_lead' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).holderCount).toBe(2);
    expect(mockGate).not.toHaveBeenCalled();
    expect(db.__ops).toHaveLength(0);
  });

  it('non-founder without consent: the gate throw surfaces the exact pre-change 409 body and deletes nothing', async () => {
    mockGate.mockRejectedValue(
      new ConsentRequiredError({
        matterKey: 'role_catalog',
        subjectRef: { type: 'role_definition', slug: 'custom_poster_team_lead', action: 'delete' },
        consentRequestId: null,
        reason: 'missing',
      }),
    );
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const res = await DELETE(req('custom_poster_team_lead'), {
      params: { slug: 'custom_poster_team_lead' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONSENT_REQUIRED');
    expect(db.__ops).toHaveLength(0);
  });
});
