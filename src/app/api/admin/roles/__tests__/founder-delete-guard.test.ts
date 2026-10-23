/**
 * @jest-environment node
 *
 * Founder-transfer program, Family C: the DELETE guards become
 * reference-aware.
 *
 * roles/[slug] route: 'superadmin' leaves the name-based protected
 * list; the holders fence is widened to primary 'role' AND
 * 'additionalRoles' (unioned, counted once) and moved ABOVE the
 * consent gate, so a refused delete never consumes a consent.
 * 'president_national' and 'member' stay name-protected (400);
 * 'founder_patron' is protected only by the fence on this route.
 *
 * role-permissions route: the 'superadmin' name ban becomes an
 * emptiness check only; the holders fence runs for EVERY slug (custom
 * slugs keep the exact CUSTOM_ROLE_IN_USE body); 'founder_patron'
 * stays refused by the catalog block (403).
 *
 * Both fences count the full reference set (founder-rederive-api.md
 * section 10 items 1-3): roles primary + roles additionalRoles + the
 * users mirror (role / displayRole / additionalRoles), unioned by uid.
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
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { NextRequest } from 'next/server';
import { DELETE as slugDelete } from '@/app/api/admin/roles/[slug]/route';
import { DELETE as rpDelete } from '@/app/api/admin/role-permissions/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { assertConsentFor } from '@/lib/server/consent-gate';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;

interface Op {
  op: string;
  col: string;
  id: string;
}

interface MakeDbOptions {
  /** roleDefinitions docs keyed by doc id; a null/absent id = doc missing. */
  defs?: Record<string, Record<string, unknown> | null>;
  /** roles/{uid} holder docs, served to the roles fence queries. */
  roleHolders?: Array<{ id: string; role?: string; additionalRoles?: string[] }>;
  /** users/{uid} mirror docs, served to the users fence queries
   *  (role / displayRole / additionalRoles). */
  userHolders?: Array<{
    id: string;
    role?: string;
    displayRole?: string;
    additionalRoles?: string[];
  }>;
}

function makeDb(opts: MakeDbOptions = {}) {
  const ops: Op[] = [];
  const db = {
    __ops: ops,
    collection: (name: string) => ({
      doc: (id?: string) => {
        const ref: Record<string, unknown> = {
          __col: name,
          __id: id ?? 'auto-id',
          get: async () => {
            if (name === 'roleDefinitions' && id) {
              const def = opts.defs?.[id];
              return def
                ? { exists: true, id, data: () => def }
                : { exists: false, id, data: () => undefined };
            }
            return { exists: false, id, data: () => undefined };
          },
        };
        return ref;
      },
      where: (field: string, op: string, value: unknown) => ({
        get: async () => {
          let docs: Array<{ id: string }> = [];
          if (name === 'roles' && opts.roleHolders) {
            docs = opts.roleHolders
              .filter((h) =>
                field === 'role' && op === '=='
                  ? h.role === value
                  : field === 'additionalRoles' && op === 'array-contains'
                    ? (h.additionalRoles || []).includes(value as string)
                    : false,
              )
              .map((h) => ({ id: h.id }));
          }
          if (name === 'users' && opts.userHolders) {
            docs = opts.userHolders
              .filter((h) =>
                (field === 'role' || field === 'displayRole') && op === '=='
                  ? h[field] === value
                  : field === 'additionalRoles' && op === 'array-contains'
                    ? (h.additionalRoles || []).includes(value as string)
                    : false,
              )
              .map((h) => ({ id: h.id }));
          }
          return {
            docs,
            empty: docs.length === 0,
            size: docs.length,
            forEach: (cb: (d: { id: string }) => void) => docs.forEach(cb),
          };
        },
      }),
    }),
    batch: () => {
      const batchOps: Op[] = [];
      const capture =
        (op: string) =>
        (ref: { __col: string; __id: string }) => {
          batchOps.push({ op, col: ref.__col, id: ref.__id });
        };
      return {
        set: capture('set'),
        delete: capture('delete'),
        update: capture('update'),
        commit: async () => {
          ops.push(...batchOps);
        },
      };
    },
  };
  return db;
}

function req(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, { method: 'DELETE', body: JSON.stringify(body) });
}

const SUPERADMIN_DEF = { superadmin: { name: 'Super Admin' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockPerm.mockResolvedValue(true);
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director', displayName: 'Test Admin', email: 'admin@example.com' },
  });
  mockDbHolder.db = makeDb({ defs: { ...SUPERADMIN_DEF } });
});

// ---------------------------------------------------------------------------
// C1: roles/[slug] DELETE
// ---------------------------------------------------------------------------

it('C1: superadmin with a primary holder is refused 409 by the fence, before the consent gate', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [{ id: 'u1', role: 'superadmin' }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: superadmin held ONLY via additionalRoles is refused 409 with holderCount 1', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [{ id: 'u2', role: 'member', additionalRoles: ['superadmin'] }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: a holder in both fields is counted once (union)', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [{ id: 'u3', role: 'superadmin', additionalRoles: ['superadmin'] }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
});

it('C1: superadmin held ONLY in the users mirror (role) is refused 409', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [],
    userHolders: [{ id: 'u4', role: 'superadmin' }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: superadmin held ONLY in the users mirror (displayRole) is refused 409', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [],
    userHolders: [{ id: 'u5', role: 'member', displayRole: 'superadmin' }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: superadmin held ONLY in the users mirror (additionalRoles) is refused 409', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [],
    userHolders: [{ id: 'u6', role: 'member', additionalRoles: ['superadmin'] }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: the same uid in the roles store and the users mirror is counted once', async () => {
  mockDbHolder.db = makeDb({
    defs: { ...SUPERADMIN_DEF },
    roleHolders: [{ id: 'u7', role: 'superadmin' }],
    userHolders: [{ id: 'u7', role: 'superadmin', displayRole: 'superadmin' }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
});

it('C1: superadmin with zero holders and consent deletes all three stores (200)', async () => {
  const db = makeDb({ defs: { ...SUPERADMIN_DEF }, roleHolders: [] });
  mockDbHolder.db = db;
  const res = await slugDelete(
    req('http://localhost/api/admin/roles/superadmin', { consentRequestId: 'cr-1' }),
    { params: { slug: 'superadmin' } },
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalled();
  const deletes = db.__ops.filter((o) => o.op === 'delete');
  expect(deletes).toEqual(
    expect.arrayContaining([
      { op: 'delete', col: 'roleDefinitions', id: 'superadmin' },
      { op: 'delete', col: 'permissions', id: 'superadmin' },
      { op: 'delete', col: 'role_permissions', id: 'superadmin' },
    ]),
  );
});

it('C1: president_national with zero holders is still name-refused 400', async () => {
  mockDbHolder.db = makeDb({
    defs: { president_national: { name: 'President' } },
    roleHolders: [],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/president_national', {}), {
    params: { slug: 'president_national' },
  });
  expect(res.status).toBe(400);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: member is still name-refused 400', async () => {
  mockDbHolder.db = makeDb({ defs: { member: { name: 'Member' } }, roleHolders: [] });
  const res = await slugDelete(req('http://localhost/api/admin/roles/member', {}), {
    params: { slug: 'member' },
  });
  expect(res.status).toBe(400);
});

it('C1: founder_patron with a holder is refused 409 by the fence, not a name ban', async () => {
  mockDbHolder.db = makeDb({
    defs: { founder_patron: { name: 'Founder Patron' } },
    roleHolders: [{ id: 'u9', role: 'founder_patron' }],
  });
  const res = await slugDelete(req('http://localhost/api/admin/roles/founder_patron', {}), {
    params: { slug: 'founder_patron' },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
});

it('C1: unauthorized actor still gets 403', async () => {
  mockPerm.mockResolvedValue(false);
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(403);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C1: missing definition still gets 404', async () => {
  mockDbHolder.db = makeDb({ defs: {} });
  const res = await slugDelete(req('http://localhost/api/admin/roles/superadmin', {}), {
    params: { slug: 'superadmin' },
  });
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// C2: role-permissions DELETE
// ---------------------------------------------------------------------------

it('C2: superadmin with a primary holder is refused 409 (was 400 name ban)', async () => {
  mockDbHolder.db = makeDb({
    roleHolders: [{ id: 'u1', role: 'superadmin' }],
  });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'superadmin' }),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.holderCount).toBe(1);
  expect(json.code).toBeUndefined();
  expect(mockGate).not.toHaveBeenCalled();
});

it('C2: superadmin held ONLY via additionalRoles is refused 409', async () => {
  mockDbHolder.db = makeDb({
    roleHolders: [{ id: 'u2', role: 'member', additionalRoles: ['superadmin'] }],
  });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'superadmin' }),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
});

it('C2: superadmin held ONLY in the users mirror (role) is refused 409', async () => {
  mockDbHolder.db = makeDb({
    roleHolders: [],
    userHolders: [{ id: 'u4', role: 'superadmin' }],
  });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'superadmin' }),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C2: superadmin held ONLY in the users mirror (displayRole) is refused 409', async () => {
  mockDbHolder.db = makeDb({
    roleHolders: [],
    userHolders: [{ id: 'u5', role: 'member', displayRole: 'superadmin' }],
  });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'superadmin' }),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C2: superadmin held ONLY in the users mirror (additionalRoles) is refused 409, counted once across stores', async () => {
  mockDbHolder.db = makeDb({
    roleHolders: [{ id: 'u6', role: 'superadmin' }],
    userHolders: [{ id: 'u6', role: 'member', additionalRoles: ['superadmin'] }],
  });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'superadmin' }),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).holderCount).toBe(1);
  expect(mockGate).not.toHaveBeenCalled();
});

it('C2: superadmin with zero holders and consent deletes (200, deleted: superadmin)', async () => {
  const db = makeDb({ roleHolders: [] });
  mockDbHolder.db = db;
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', {
      role: 'superadmin',
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect((await res.json()).deleted).toBe('superadmin');
  const deletes = db.__ops.filter((o) => o.op === 'delete').map((o) => o.col);
  expect(deletes).toEqual(expect.arrayContaining(['roleDefinitions', 'role_permissions', 'permissions']));
});

it('C2: founder_patron is still refused 403 by the catalog block', async () => {
  mockDbHolder.db = makeDb({ roleHolders: [] });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'founder_patron' }),
  );
  expect(res.status).toBe(403);
});

it('C2: empty or missing role is 400 with the new error string', async () => {
  mockDbHolder.db = makeDb({});
  const resEmpty = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: '' }),
  );
  expect(resEmpty.status).toBe(400);
  expect((await resEmpty.json()).error).toBe('Cannot delete empty role');
  const resMissing = await rpDelete(req('http://localhost/api/admin/role-permissions', {}));
  expect(resMissing.status).toBe(400);
});

it('C2: custom slug in use still returns 409 CUSTOM_ROLE_IN_USE', async () => {
  mockDbHolder.db = makeDb({
    roleHolders: [{ id: 'u5', role: 'member', additionalRoles: ['custom_poster_team'] }],
  });
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'custom_poster_team' }),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CUSTOM_ROLE_IN_USE');
  expect(json.holderCount).toBe(1);
});

it('C2: custom slug unreferenced deletes as before', async () => {
  const db = makeDb({ roleHolders: [] });
  mockDbHolder.db = db;
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', {
      role: 'custom_poster_team',
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect((await res.json()).deleted).toBe('custom_poster_team');
});

it('C2: actor without canManagePermissions still gets 403', async () => {
  mockPerm.mockResolvedValue(false);
  mockDbHolder.db = makeDb({});
  const res = await rpDelete(
    req('http://localhost/api/admin/role-permissions', { role: 'superadmin' }),
  );
  expect(res.status).toBe(403);
});
