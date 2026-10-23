/**
 * @jest-environment node
 *
 * DELETE /api/admin/roles/[slug] - actor-set unification
 * (side-door item, plan section 3.5 / T-G; ruling R8, G5 binding
 * check 4). After the fix the ONLY ways past the actor check are
 * the Founder (by UID, via config) or a role the permissions matrix
 * grants canManagePermissions (hasServerPermission). The retired
 * literals - userRole === 'superadmin', the hard-coded founder UID
 * string, userRole === 'president_national' - and the legacy
 * permissions/{role}.manageRoles fallback read must grant NOTHING.
 * The consent gate, the holder fence and the protected-slug list in
 * the same route are untouched and pinned here as regressions.
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
import { hasServerPermission } from '@/lib/server/permissions';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;

interface Op {
  op: string;
  col: string;
  id: string;
}

interface FakeState {
  permissionDocs?: Record<string, Record<string, unknown>>;
  holders?: number;
  primaryHolderIds?: string[];
  additionalHolderIds?: string[];
}

function makeDb(state: FakeState) {
  const ops: Op[] = [];
  const db = {
    __ops: ops,
    collection: (name: string) => ({
      doc: (id?: string) => {
        const ref = {
          __col: name,
          __id: id ?? 'auto-id',
          get: async () => {
            if (name === 'roleDefinitions') {
              return { exists: true, id, data: () => ({ name: 'Poster Team' }) };
            }
            if (name === 'permissions' && id && state.permissionDocs?.[id]) {
              const data = state.permissionDocs[id];
              return { exists: true, id, data: () => data };
            }
            return { exists: false, id, data: () => undefined };
          },
        };
        return ref;
      },
      where: (field: string) => ({
        get: async () => {
          let ids: string[];
          if (field === 'additionalRoles') {
            ids = state.additionalHolderIds ?? [];
          } else if (state.primaryHolderIds) {
            ids = state.primaryHolderIds;
          } else {
            const holders = state.holders ?? 0;
            ids = Array.from({ length: holders }, (_, i) => `primary-holder-${i + 1}`);
          }
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

function asUser(userId: string, role: string) {
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId, role, displayName: 'Test Admin', email: 'admin@example.com' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPerm.mockResolvedValue(false);
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockDbHolder.db = makeDb({});
  asUser('admin-1', 'executive_director');
});

it('the Founder passes the actor check by UID with NO matrix grant', async () => {
  asUser(FOUNDER_UID, 'member');
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(200);
  const deletes = db.__ops.filter((o) => o.op === 'delete').map((o) => o.col);
  expect(deletes).toEqual(expect.arrayContaining(['roleDefinitions', 'permissions']));
});

it('deleting a definition removes ALL THREE stores, including the role_permissions mirror', async () => {
  asUser(FOUNDER_UID, 'member');
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(200);
  const deletes = db.__ops.filter((o) => o.op === 'delete');
  expect(deletes).toEqual(
    expect.arrayContaining([
      { op: 'delete', col: 'roleDefinitions', id: 'custom_poster_team_lead' },
      { op: 'delete', col: 'permissions', id: 'custom_poster_team_lead' },
      { op: 'delete', col: 'role_permissions', id: 'custom_poster_team_lead' },
    ]),
  );
});

it('a role the matrix grants canManagePermissions passes the actor check', async () => {
  mockPerm.mockResolvedValue(true);
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(200);
  expect(mockPerm).toHaveBeenCalledWith('executive_director', 'canManagePermissions');
});

it('president_national WITHOUT a matrix grant gets 403 (the literal no longer suffices)', async () => {
  asUser('admin-2', 'president_national');
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
  expect(db.__ops).toHaveLength(0);
});

it('the superadmin role literal no longer suffices without a matrix grant', async () => {
  asUser('admin-3', 'superadmin');
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
});

it('a permissions doc carrying only the legacy manageRoles key no longer suffices', async () => {
  asUser('admin-9', 'chapter_treasurer');
  mockDbHolder.db = makeDb({
    permissionDocs: { chapter_treasurer: { manageRoles: true } },
  });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
  expect(db.__ops).toHaveLength(0);
});

it('an ordinary role with no grant gets 403 and the gate is not consulted', async () => {
  asUser('admin-4', 'chapter_treasurer');
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
});

it('unauthenticated gets 401', async () => {
  mockAuth.mockResolvedValue({ authenticated: false });
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(401);
});

it('regression: the holder fence still refuses while anyone holds the role', async () => {
  asUser(FOUNDER_UID, 'member');
  mockDbHolder.db = makeDb({ holders: 2 });
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.holderCount).toBe(2);
});

it('regression: protected slugs are still refused before the gate', async () => {
  asUser(FOUNDER_UID, 'member');
  const res = await DELETE(req('member'), { params: { slug: 'member' } });
  expect(res.status).toBe(400);
  expect(mockGate).not.toHaveBeenCalled();
});

it('regression: the role_catalog consent gate still gates the delete', async () => {
  asUser(FOUNDER_UID, 'member');
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

it('S-FENCE: a holder via additionalRoles ONLY refuses 409 and is counted', async () => {
  asUser(FOUNDER_UID, 'member');
  mockDbHolder.db = makeDb({
    primaryHolderIds: [],
    additionalHolderIds: ['holder-additional-1'],
  });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.holderCount).toBe(1);
  expect(json.error).toContain("Role 'Poster Team' is still held by 1 user(s)");
  expect(db.__ops).toHaveLength(0);
});

it('S-FENCE: a primary-only holder still refuses 409', async () => {
  asUser(FOUNDER_UID, 'member');
  mockDbHolder.db = makeDb({
    primaryHolderIds: ['holder-primary-1'],
    additionalHolderIds: [],
  });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.holderCount).toBe(1);
  expect(db.__ops).toHaveLength(0);
});

it('S-FENCE: one primary holder + one additionalRoles holder refuses 409 with holderCount 2', async () => {
  asUser(FOUNDER_UID, 'member');
  mockDbHolder.db = makeDb({
    primaryHolderIds: ['holder-primary-1'],
    additionalHolderIds: ['holder-additional-1'],
  });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.holderCount).toBe(2);
  expect(json.error).toContain("Role 'Poster Team' is still held by 2 user(s)");
  expect(db.__ops).toHaveLength(0);
});

it('S-FENCE: the same holder in both queries is not double-counted', async () => {
  asUser(FOUNDER_UID, 'member');
  mockDbHolder.db = makeDb({
    primaryHolderIds: ['holder-shared-1'],
    additionalHolderIds: ['holder-shared-1'],
  });
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.holderCount).toBe(1);
});

it('S-FENCE: no holders returns 200 and the three-store delete proceeds', async () => {
  asUser(FOUNDER_UID, 'member');
  mockDbHolder.db = makeDb({ primaryHolderIds: [], additionalHolderIds: [] });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const res = await DELETE(req('custom_poster_team_lead'), {
    params: { slug: 'custom_poster_team_lead' },
  });
  expect(res.status).toBe(200);
  const deletes = db.__ops.filter((o) => o.op === 'delete');
  expect(deletes).toEqual(
    expect.arrayContaining([
      { op: 'delete', col: 'roleDefinitions', id: 'custom_poster_team_lead' },
      { op: 'delete', col: 'permissions', id: 'custom_poster_team_lead' },
      { op: 'delete', col: 'role_permissions', id: 'custom_poster_team_lead' },
    ]),
  );
});
