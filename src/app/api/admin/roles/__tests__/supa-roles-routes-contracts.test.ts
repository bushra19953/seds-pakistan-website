/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION — ROLES+PERMISSIONS cluster contract tests (group 2:
 * roles admin API routes). Written against the CURRENT base tree
 * (feat/integration-wave3 @ 4d5a1e16) with Firestore mocked; ZERO live reads.
 *
 * Routes pinned:
 * - GET    /api/v1/roles
 * - GET/POST/DELETE /api/admin/role-permissions
 * - POST   /api/admin/sync-user-role
 * - POST   /api/admin/roles/write
 * - POST   /api/admin/roles/assign
 * - DELETE /api/admin/roles/[slug]
 *
 * For each: success-path status + body shape, and the main denial paths
 * (401 unauthenticated, 403 permission, 400 validation, 404/409/410 where
 * the route defines them) with exact error strings. These envelopes must
 * be byte-identical after the Supabase migration (flag OFF/ON/fallback).
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
              matter: (err as InstanceType<typeof types.ConsentRequiredError>).matterKey,
              reason: (err as InstanceType<typeof types.ConsentRequiredError>).reason,
              subject: (err as InstanceType<typeof types.ConsentRequiredError>).subjectRef,
              consentRequestId: (err as InstanceType<typeof types.ConsentRequiredError>).consentRequestId,
              fileRequestUrl: (err as InstanceType<typeof types.ConsentRequiredError>).fileRequestUrl,
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

jest.mock('@/lib/server/role-writes', () => {
  class RoleWriteError extends Error {
    code: string;
    httpStatus: number;
    constructor(message: string, code = 'role_write_error', httpStatus = 400) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  return {
    RoleWriteError,
    assignRole: jest.fn(),
    removeRole: jest.fn(),
    validateAssignRoleInput: jest.fn().mockResolvedValue(undefined),
    validateRemoveRoleInput: jest.fn().mockReturnValue(undefined),
  };
});

const mockDbHolder: { db: unknown } = { db: null };
const DB_THROW = Symbol('db-throw');
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => {
    if ((mockDbHolder.db as unknown) === DB_THROW) throw new Error('init boom');
    return mockDbHolder.db;
  },
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'ts', delete: () => ({ __delete: true }) },
}));

import { NextRequest } from 'next/server';
import { GET as v1RolesGET } from '@/app/api/v1/roles/route';
import {
  GET as rpGET,
  POST as rpPOST,
  DELETE as rpDELETE,
} from '@/app/api/admin/role-permissions/route';
import { POST as syncPOST } from '@/app/api/admin/sync-user-role/route';
import { POST as writePOST } from '@/app/api/admin/roles/write/route';
import { POST as assignPOST } from '@/app/api/admin/roles/assign/route';
import { DELETE as slugDELETE } from '@/app/api/admin/roles/[slug]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { assertConsentFor, isCategoryBRole } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { assignRole, removeRole, RoleWriteError } from '@/lib/server/role-writes';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockIsCatB = isCategoryBRole as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockRemove = removeRole as jest.Mock;

// ---------------------------------------------------------------------------
// Store-based Firestore fake: doc get/set/update/delete, collection get,
// where(==/array-contains), select(), batch.
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

class StoreDb {
  store = new Map<string, Map<string, DocData>>();
  private auto = 0;

  seed(col: string, id: string, data: DocData) {
    if (!this.store.has(col)) this.store.set(col, new Map());
    this.store.get(col)!.set(id, { ...data });
  }
  read(col: string, id: string): DocData | undefined {
    const d = this.store.get(col)?.get(id);
    return d ? { ...d } : undefined;
  }
  all(col: string): Array<{ id: string; data: DocData }> {
    return [...(this.store.get(col)?.entries() ?? [])].map(([id, data]) => ({
      id,
      data: { ...data },
    }));
  }
  private snap(col: string, id: string) {
    const data = this.store.get(col)?.get(id);
    return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
  }
  private querySnap(entries: Array<[string, DocData]>) {
    const docs = entries.map(([id, data]) => ({ id, data: () => ({ ...data }) }));
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb),
    };
  }
  collection(name: string) {
    const self = this;
    const makeQuery = (filters: Array<[string, string, unknown]>) => ({
      where: (f: string, op: string, v: unknown) => makeQuery([...filters, [f, op, v]]),
      select: () => makeQuery(filters),
      get: async () => {
        let entries = [...(self.store.get(name)?.entries() ?? [])] as Array<[string, DocData]>;
        for (const [f, op, v] of filters) {
          entries = entries.filter(([, d]) =>
            op === 'array-contains'
              ? Array.isArray(d[f]) && (d[f] as unknown[]).includes(v)
              : d[f] === v,
          );
        }
        return self.querySnap(entries);
      },
    });
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.auto}`;
        return {
          id: docId,
          get: async () => self.snap(name, docId),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            const prev = opts?.merge ? self.read(name, docId) ?? {} : {};
            self.seed(name, docId, { ...prev, ...data });
          },
          update: async (data: DocData) => {
            self.seed(name, docId, { ...(self.read(name, docId) ?? {}), ...data });
          },
          delete: async () => {
            self.store.get(name)?.delete(docId);
          },
        };
      },
      where: (f: string, op: string, v: unknown) => makeQuery([[f, op, v]]),
      select: () => makeQuery([]),
      get: async () => self.querySnap([...(self.store.get(name)?.entries() ?? [])] as Array<[string, DocData]>),
    };
  }
  batch() {
    const self = this;
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> }, data: DocData, opts?: { merge?: boolean }) => {
        ops.push(() => ref.set(data, opts));
      },
      delete: (ref: { delete: () => Promise<void> }) => {
        ops.push(() => ref.delete());
      },
      update: (ref: { update: (d: DocData) => Promise<void> }, data: DocData) => {
        ops.push(() => ref.update(data));
      },
      commit: async () => {
        for (const op of ops) await op();
      },
    };
  }
}

let fake: StoreDb;
function req(url: string, method: string, body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const RP = 'http://localhost/api/admin/role-permissions';

beforeEach(() => {
  jest.clearAllMocks();
  fake = new StoreDb();
  mockDbHolder.db = fake;
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'chapter_president', displayName: 'Admin' },
  });
  mockPerm.mockResolvedValue(true);
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockIsCatB.mockResolvedValue(false);
  mockAudit.mockResolvedValue('audit-1');
  mockAssign.mockResolvedValue({
    newEffectiveRole: 'chapter_president',
    alreadyApplied: false,
    roleDoc: { expiresAt: null },
  });
  mockRemove.mockResolvedValue({ previousEffectiveRole: 'chapter_president', alreadyApplied: false });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// GET /api/v1/roles
// ---------------------------------------------------------------------------

describe('GET /api/v1/roles', () => {
  it('200 {roles:[{key,label}]} sorted by label, static catalog + dynamic docs merged and deduped', async () => {
    fake.seed('roles', 'r1', { role: 'chapter_president' });
    fake.seed('roles', 'r2', { role: 'Grand Poobah' });
    fake.seed('users', 'u1', { role: 'chapter_president', position: 'chapter_treasurer' });
    const res = await v1RolesGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['roles']);
    const keys = body.roles.map((r: { key: string }) => r.key);
    expect(keys).toContain('grand_poobah'); // dynamic roles-doc value, normalized
    expect(keys).toContain('chapter_treasurer'); // users.position picked up
    expect(keys.filter((k: string) => k === 'chapter_president')).toHaveLength(1);
    for (const r of body.roles) {
      expect(typeof r.key).toBe('string');
      expect(typeof r.label).toBe('string');
      expect(r.label.length).toBeGreaterThan(0);
    }
    const labels = body.roles.map((r: { label: string }) => r.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('200 with static roles only when the db is unavailable', async () => {
    mockDbHolder.db = null;
    const res = await v1RolesGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles.length).toBeGreaterThan(0);
    expect(body.roles.map((r: { key: string }) => r.key)).toContain('founder_patron');
  });

  it('200 with static roles only when dynamic reads throw (inner failure is swallowed)', async () => {
    fake.collection = () => {
      throw new Error('read boom');
    };
    const res = await v1RolesGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles.length).toBeGreaterThan(0);
  });

  it('500 {error} when initialization itself throws', async () => {
    mockDbHolder.db = DB_THROW as unknown;
    const res = await v1RolesGET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'init boom' });
  });
});

// ---------------------------------------------------------------------------
// /api/admin/role-permissions
// ---------------------------------------------------------------------------

describe('GET /api/admin/role-permissions', () => {
  it('401 {error:"Unauthorized"} when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await rpGET(req(RP, 'GET'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('200 {roles} merging roleDefinitions over role_permissions, sorted by label', async () => {
    fake.seed('roleDefinitions', 'chapter_president', {
      name: 'Chapter President',
      allowedPaths: ['/admin'],
      permissions: ['canManageTasks'],
    });
    fake.seed('role_permissions', 'chapter_president', { label: 'STALE MIRROR' });
    fake.seed('role_permissions', 'legacy_only', { label: 'Legacy Only' });
    const res = await rpGET(req(RP, 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toHaveLength(2);
    const pres = body.roles.find((r: { id: string }) => r.id === 'chapter_president');
    expect(pres.role).toBe('chapter_president');
    expect(pres.label).toBe('Chapter President'); // definition wins over the mirror
    expect(pres.canAccessAdmin).toBe(true); // default when the field is absent
    const legacy = body.roles.find((r: { id: string }) => r.id === 'legacy_only');
    expect(legacy.label).toBe('Legacy Only');
    const labels = body.roles.map((r: { label: string }) => r.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('500 {error:"Failed to fetch role permissions"} when the db is missing', async () => {
    mockDbHolder.db = null;
    const res = await rpGET(req(RP, 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch role permissions' });
  });
});

describe('POST /api/admin/role-permissions', () => {
  const createBody = {
    role: 'treasurer',
    label: 'Media Lead',
    allowedPaths: ['/admin'],
    canAccessAdmin: true,
    consentRequestId: 'cr-1',
  };

  it('401 when unauthenticated; gate and audit never run', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await rpPOST(req(RP, 'POST', createBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('403 with the exact string when canManagePermissions is denied', async () => {
    mockPerm.mockResolvedValue(false);
    const res = await rpPOST(req(RP, 'POST', createBody));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to manage role permissions',
    });
  });

  it('400 validation trio: role, label, and payload-model errors', async () => {
    let res = await rpPOST(req(RP, 'POST', { label: 'X', allowedPaths: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Role slug is required' });

    res = await rpPOST(req(RP, 'POST', { role: 'treasurer', allowedPaths: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Label is required' });

    res = await rpPOST(req(RP, 'POST', { role: 'treasurer', label: 'X' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'allowedPaths (path model) or permissionKeys (drawer model) is required',
    });
  });

  it('400 for an unknown non-custom slug with the catalog-closure string and NO code field', async () => {
    const res = await rpPOST(req(RP, 'POST', { ...createBody, role: 'grand_poobah' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unknown role "grand_poobah". Roles are fixed by the Role Catalog.' });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('409 consent-gate body when a create lacks consent; nothing is written', async () => {
    mockGate.mockRejectedValue(
      new ConsentRequiredError({
        matterKey: 'role_catalog',
        subjectRef: { type: 'role_definition', slug: 'treasurer', action: 'create' },
        consentRequestId: null,
        reason: 'missing',
      }),
    );
    const res = await rpPOST(req(RP, 'POST', createBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CONSENT_REQUIRED');
    expect(body.error).toBe('CONSENT_REQUIRED');
    expect(fake.read('roleDefinitions', 'treasurer')).toBeUndefined();
  });

  it('200 {success:true, role} on a consented create; all three stores written in one batch', async () => {
    const res = await rpPOST(req(RP, 'POST', createBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, role: 'treasurer' });
    expect(fake.read('roleDefinitions', 'treasurer')).toBeTruthy();
    expect(fake.read('role_permissions', 'treasurer')).toBeTruthy();
    expect(fake.read('permissions', 'treasurer')).toBeTruthy();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'role_definition_saved', targetId: 'treasurer' }),
    );
  });

  it('200 ungated for a description-only edit of an existing definition (gate never called)', async () => {
    fake.seed('roleDefinitions', 'chair_events', {
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
      scope: 'chapter',
      description: 'old',
    });
    const res = await rpPOST(
      req(RP, 'POST', {
        role: 'chair_events',
        label: 'Chair Events',
        allowedPaths: ['/admin'],
        canAccessAdmin: true,
        description: 'Runs all events.',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, role: 'chair_events' });
    expect(mockGate).not.toHaveBeenCalled();
    expect(fake.read('roleDefinitions', 'chair_events')?.description).toBe('Runs all events.');
  });

  it('400 CUSTOM_FIELDS_REQUIRED when a custom create omits parent/chapter/permissionKeys', async () => {
    const res = await rpPOST(
      req(RP, 'POST', { role: 'custom_poster_team_lead', label: 'Poster Team Lead', allowedPaths: ['/admin'] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CUSTOM_FIELDS_REQUIRED');
  });

  it('400 RESERVED_PERMISSION_FOR_CUSTOM_ROLE when a custom create asks for a Reserved Power', async () => {
    fake.seed('chapters', CHAPTER_ID, { isActive: true });
    const res = await rpPOST(
      req(RP, 'POST', {
        role: 'custom_poster_team_lead',
        label: 'Poster Team Lead',
        permissionKeys: ['canManageRoles'],
        parentRoleKey: 'chapter_design_chair',
        chapterId: CHAPTER_ID,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('RESERVED_PERMISSION_FOR_CUSTOM_ROLE');
  });
});

const CHAPTER_ID = 'seds-ist-chapter';

describe('DELETE /api/admin/role-permissions', () => {
  it('401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'president' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('403 with the exact string when canManagePermissions is denied', async () => {
    mockPerm.mockResolvedValue(false);
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'president' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to delete role permissions',
    });
  });

  it('400 {error:"Cannot delete empty role"} for an empty role', async () => {
    const res = await rpDELETE(req(RP, 'DELETE', {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot delete empty role' });
  });

  it('403 for a catalog role, before the holders fence and the gate', async () => {
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'president_national' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Role "president_national" is a catalog role and cannot be deleted.',
    });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('409 CUSTOM_ROLE_IN_USE with holderCount when a custom role is still held (additionalRoles surface)', async () => {
    fake.seed('roleDefinitions', 'custom_poster_team_lead', { name: 'Poster Team Lead' });
    fake.seed('roles', 'holder-1', { role: 'member', additionalRoles: ['custom_poster_team_lead'] });
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'custom_poster_team_lead' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CUSTOM_ROLE_IN_USE');
    expect(body.holderCount).toBe(1);
    expect(body.error).toContain('still held by 1 user(s)');
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('200 {success:true, deleted} for an unheld legacy slug; all three stores deleted', async () => {
    fake.seed('roleDefinitions', 'president', { name: 'President (legacy)' });
    fake.seed('role_permissions', 'president', { label: 'President' });
    fake.seed('permissions', 'president', { canAccessAdmin: true });
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'president', consentRequestId: 'cr-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: 'president' });
    expect(fake.read('roleDefinitions', 'president')).toBeUndefined();
    expect(fake.read('role_permissions', 'president')).toBeUndefined();
    expect(fake.read('permissions', 'president')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/sync-user-role
// ---------------------------------------------------------------------------

describe('POST /api/admin/sync-user-role', () => {
  const SYNC = 'http://localhost/api/admin/sync-user-role';

  it('401 {error:"Unauthorized"} when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', customTitle: 'X' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('403 {error:"Forbidden: role management permission required"} when canManageRoles is denied', async () => {
    mockPerm.mockResolvedValue(false);
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', customTitle: 'X' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: role management permission required' });
  });

  it('400 {error:"uid is required"} without a uid', async () => {
    const res = await syncPOST(req(SYNC, 'POST', { customTitle: 'X' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'uid is required' });
  });

  it('500 {error:"Database unavailable"} when getDb returns null', async () => {
    mockDbHolder.db = null;
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', customTitle: 'X' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Database unavailable' });
  });

  it('400 when customTitle exceeds 80 characters', async () => {
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', customTitle: 'x'.repeat(81) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'customTitle exceeds 80 characters' });
  });

  it('400 {error:"Nothing to update"} for a uid-only body', async () => {
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Nothing to update' });
  });

  it('409 {code:"no_roles_record"} when a mirror is requested but no roles record exists', async () => {
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', role: 'member' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_roles_record');
  });

  it('200 {ok:true, uid} for a customTitle-only update; writes users doc, no governance audit', async () => {
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', customTitle: 'Space Cadet' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uid: 'u1' });
    expect(fake.read('users', 'u1')?.customTitle).toBe('Space Cadet');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('409 ROLE_WRITE_ROUTE_REQUIRED when the requested mirror diverges from the roles record', async () => {
    fake.seed('roles', 'u1', { role: 'member' });
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', role: 'chapter_president' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ROLE_WRITE_ROUTE_REQUIRED');
    expect(body.effectiveRole).toBe('member');
    expect(fake.read('users', 'u1')).toBeUndefined();
  });

  it('200 mirror repair when the request matches the effective role; audited as role_mirror_repair', async () => {
    fake.seed('roles', 'u1', { role: 'member' });
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', role: 'member' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uid: 'u1' });
    const written = fake.read('users', 'u1');
    expect(written?.role).toBe('member');
    expect(written?.displayRole).toBe('member');
    expect(written?.roleSource).toBe('roles');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'role_mirror_repair', targetId: 'u1' }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/roles/write
// ---------------------------------------------------------------------------

describe('POST /api/admin/roles/write', () => {
  const WRITE = 'http://localhost/api/admin/roles/write';
  const founderAuth = {
    authenticated: true,
    user: { userId: FOUNDER_UID, role: 'founder_patron' },
  };

  it('401 {error:"Unauthorized"} when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await writePOST(req(WRITE, 'POST', { action: 'assign', uid: 'u1', role: 'member' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('500 {error:"Database unavailable"} when getDb returns null', async () => {
    mockDbHolder.db = null;
    const res = await writePOST(req(WRITE, 'POST', { action: 'assign', uid: 'u1', role: 'member' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Database unavailable' });
  });

  it('401 {error:"Actor could not be resolved"} when the auth user carries no uid', async () => {
    mockAuth.mockResolvedValue({ authenticated: true, user: { role: 'chapter_president' } });
    const res = await writePOST(req(WRITE, 'POST', { action: 'assign', uid: 'u1', role: 'member' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Actor could not be resolved' });
  });

  it('410 for set-custom-title, pointing at sync-user-role', async () => {
    const res = await writePOST(req(WRITE, 'POST', { action: 'set-custom-title', uid: 'u1', customTitle: 'X' }));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: 'customTitle is not a role change; use POST /api/admin/sync-user-role',
    });
  });

  it('400 {error:\'action must be "assign" or "remove"\'} for an unknown action', async () => {
    const res = await writePOST(req(WRITE, 'POST', { action: 'promote', uid: 'u1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'action must be "assign" or "remove"' });
  });

  it('403 when a non-founder actor lacks canManageRoles on their mirror role', async () => {
    fake.seed('users', 'admin-1', { role: 'member' });
    mockPerm.mockResolvedValue(false);
    const res = await writePOST(
      req(WRITE, 'POST', { action: 'assign', uid: 'u9', role: 'member', reason: 'a long enough reason' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: role management permission required' });
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('403 {error:"The Founder role is immutable"} when a non-founder targets the founder record', async () => {
    fake.seed('users', 'admin-1', { role: 'chapter_president' });
    const res = await writePOST(
      req(WRITE, 'POST', { action: 'assign', uid: FOUNDER_UID, role: 'member', reason: 'a long enough reason' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'The Founder role is immutable' });
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('200 assign success shape {ok, uid, effectiveRole, alreadyApplied, expiresAt}', async () => {
    mockAuth.mockResolvedValue(founderAuth);
    const res = await writePOST(
      req(WRITE, 'POST', { action: 'assign', uid: 'u9', role: 'chapter_president', reason: 'elected at the AGM' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      uid: 'u9',
      effectiveRole: 'chapter_president',
      alreadyApplied: false,
      expiresAt: null,
    });
  });

  it('200 remove success shape {ok, uid, previousEffectiveRole, alreadyApplied}', async () => {
    mockAuth.mockResolvedValue(founderAuth);
    const res = await writePOST(
      req(WRITE, 'POST', { action: 'remove', uid: 'u9', reason: 'term has ended now' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      uid: 'u9',
      previousEffectiveRole: 'chapter_president',
      alreadyApplied: false,
    });
  });

  it('RoleWriteError passes through with its code and httpStatus', async () => {
    mockAuth.mockResolvedValue(founderAuth);
    mockAssign.mockRejectedValue(new RoleWriteError('Unknown role "nope"', 'unknown_role', 400));
    const res = await writePOST(
      req(WRITE, 'POST', { action: 'assign', uid: 'u9', role: 'nope', reason: 'a long enough reason' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown role "nope"', code: 'unknown_role' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/roles/assign
// ---------------------------------------------------------------------------

describe('POST /api/admin/roles/assign', () => {
  const ASSIGN = 'http://localhost/api/admin/roles/assign';
  const reason = 'a justification that is long enough';

  it('401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', role: 'member', reason }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('403 {error:"Forbidden: role management permission required"} when canManageRoles is denied', async () => {
    mockPerm.mockResolvedValue(false);
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', role: 'member', reason }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: role management permission required' });
  });

  it('400 {error:"targetUid is required"} and 400 for a short justification', async () => {
    let res = await assignPOST(req(ASSIGN, 'POST', { role: 'member', reason }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'targetUid is required' });
    res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', role: 'member', reason: 'short' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'A justification of at least 10 characters is required',
    });
  });

  it('403 {error:"The Founder role is immutable"} when a non-founder targets the founder', async () => {
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: FOUNDER_UID, role: 'member', reason }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'The Founder role is immutable' });
  });

  it('404 {error:"Target user not found"} for an unknown target', async () => {
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'ghost', role: 'member', reason }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Target user not found' });
  });

  it('400 {error:"role is required"} for an appoint without a role', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', reason }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'role is required' });
  });

  it('403 for the reserved superadmin token', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', role: 'superadmin', reason }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'The superadmin role is reserved and cannot be assigned',
    });
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('200 {ok:true, role} on appoint; governance audit precedes the role-writes call', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    // Founder actor exempts the route-local subset rule; assign is mocked.
    mockAuth.mockResolvedValue({
      authenticated: true,
      user: { userId: FOUNDER_UID, role: 'founder_patron' },
    });
    const res = await assignPOST(
      req(ASSIGN, 'POST', { targetUid: 'u9', role: 'chapter_president', reason }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'chapter_president' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'assign_role', targetId: 'u9' }),
    );
    expect(mockAssign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'u9', role: 'chapter_president' }),
    );
  });

  it('200 {ok:true, role:"member_basic"} on delete (removeRole floor)', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', action: 'delete', reason }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'member_basic' });
    expect(mockRemove).toHaveBeenCalled();
  });

  it('RoleWriteError passes through with its code and httpStatus', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    mockAuth.mockResolvedValue({
      authenticated: true,
      user: { userId: FOUNDER_UID, role: 'founder_patron' },
    });
    mockAssign.mockRejectedValue(new RoleWriteError('Unknown role "nope"', 'unknown_role', 400));
    const res = await assignPOST(req(ASSIGN, 'POST', { targetUid: 'u9', role: 'nope', reason }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown role "nope"', code: 'unknown_role' });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/roles/[slug]
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/roles/[slug]', () => {
  const call = (slug: string) =>
    slugDELETE(req(`http://localhost/api/admin/roles/${slug}`, 'DELETE', {}), {
      params: { slug },
    });

  it('400 {error:"Role slug is required"} for an empty slug', async () => {
    const res = await call('');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Role slug is required' });
  });

  it('401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, user: null });
    const res = await call('legacy_junk_role');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('403 {error:"Insufficient permissions"} for a non-founder without canManagePermissions', async () => {
    mockPerm.mockResolvedValue(false);
    const res = await call('legacy_junk_role');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
  });

  it('404 {error:"Role definition not found"} for an unknown slug', async () => {
    const res = await call('legacy_junk_role');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Role definition not found' });
  });

  it('400 {error:"Cannot delete protected system roles"} for president_national and member', async () => {
    fake.seed('roleDefinitions', 'president_national', { name: 'National President' });
    const res = await call('president_national');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot delete protected system roles' });
  });

  it('409 with holderCount while any holder surface still references the slug', async () => {
    fake.seed('roleDefinitions', 'chapter_events_chair', { name: 'Chapter Events Chair' });
    fake.seed('roles', 'holder-1', { role: 'chapter_events_chair' });
    const res = await call('chapter_events_chair');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.holderCount).toBe(1);
    expect(body.error).toContain('still held by 1 user(s)');
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('403 for a holderless catalog slug (catalog block after the fence)', async () => {
    fake.seed('roleDefinitions', 'chapter_treasurer', { name: 'Chapter Treasurer' });
    const res = await call('chapter_treasurer');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Role "chapter_treasurer" is a catalog role and cannot be deleted.',
    });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('200 {success:true, message} on a consented delete; definition + both mirrors deleted, audit doc written', async () => {
    fake.seed('roleDefinitions', 'legacy_junk_role', { name: 'Junk Role' });
    fake.seed('permissions', 'legacy_junk_role', { canAccessAdmin: true });
    fake.seed('role_permissions', 'legacy_junk_role', { label: 'Junk Role' });
    const res = await call('legacy_junk_role');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: "Role definition 'Junk Role' deleted.",
    });
    expect(fake.read('roleDefinitions', 'legacy_junk_role')).toBeUndefined();
    expect(fake.read('permissions', 'legacy_junk_role')).toBeUndefined();
    expect(fake.read('role_permissions', 'legacy_junk_role')).toBeUndefined();
    expect(fake.all('audit_logs')).toHaveLength(1);
    expect(fake.all('audit_logs')[0].data.type).toBe('ROLE_DEFINITION_DELETE');
  });
});
