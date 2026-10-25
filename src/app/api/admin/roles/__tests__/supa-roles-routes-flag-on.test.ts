/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION — ROLES+PERMISSIONS cluster, group 2 flag-ON
 * tests (R16 resume). The routes under test are the ones pinned by
 * supa-roles-routes-contracts.test.ts; this suite replays key
 * scenarios with the flag ON, the adapter mocked AT THE SEAM BOUNDARY
 * (src/lib/server/supa-roles-seam's __setSupaAdapterForTests — the
 * same injection point supa-roles-flag-states.test.ts uses), proving:
 *
 *   - reads are served from the adapter (Supabase-side data wins over
 *     divergent Firestore data, and adapter-only docs are visible);
 *   - writes stay Firestore-primary (the contracts' batch/audit
 *     effects still land in Firestore) and are mirrored to the
 *     adapter where the route owns the store;
 *   - adapter errors fall back to Firestore with identical responses;
 *   - flag OFF (adapter present, useSupa false) never calls the
 *     adapter's data functions;
 *   - envelopes, statuses and error codes are the contracts' ones.
 *
 * ZERO live reads: Firestore and the adapter are both in-memory.
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
    constructor(code: string, httpStatus: number, message: string) {
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
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
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
import { assignRole, removeRole } from '@/lib/server/role-writes';
import { __setSupaAdapterForTests } from '@/lib/server/supa-roles-seam';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockIsCatB = isCategoryBRole as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;
const mockAssign = assignRole as jest.Mock;
const mockRemove = removeRole as jest.Mock;

// ---------------------------------------------------------------------------
// Store-based Firestore fake (same shape as the contracts suite).
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

// ---------------------------------------------------------------------------
// In-memory seam adapter (the seam's { exists, data } interface).
// ---------------------------------------------------------------------------

class FakeSupaAdapter {
  store = new Map<string, Map<string, DocData>>();
  on = true;
  throwOn: 'getDoc' | 'listDocs' | null = null;

  seed(col: string, id: string, data: DocData) {
    if (!this.store.has(col)) this.store.set(col, new Map());
    this.store.get(col)!.set(id, { ...data });
  }
  read(col: string, id: string): DocData | undefined {
    const d = this.store.get(col)?.get(id);
    return d ? { ...d } : undefined;
  }

  useSupa = jest.fn((_surface: string) => this.on);
  getDoc = jest.fn(async (collection: string, id: string) => {
    if (this.throwOn === 'getDoc') throw new Error('supa boom');
    const data = this.store.get(collection)?.get(id);
    return data ? { exists: true, data: { ...data } } : { exists: false };
  });
  listDocs = jest.fn(async (collection: string) => {
    if (this.throwOn === 'listDocs') throw new Error('supa boom');
    return [...(this.store.get(collection)?.entries() ?? [])].map(([id, data]) => ({
      id,
      data: { ...data },
    }));
  });
  setDoc = jest.fn(async (collection: string, id: string, data: DocData) => {
    this.seed(collection, id, { ...(this.read(collection, id) ?? {}), ...data });
  });
  updateDoc = jest.fn(async (collection: string, id: string, data: DocData) => {
    this.seed(collection, id, { ...(this.read(collection, id) ?? {}), ...data });
  });
  deleteDoc = jest.fn(async (collection: string, id: string) => {
    this.store.get(collection)?.delete(id);
  });
}

let fake: StoreDb;
let supa: FakeSupaAdapter;
function req(url: string, method: string, body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const RP = 'http://localhost/api/admin/role-permissions';
const SYNC = 'http://localhost/api/admin/sync-user-role';
const WRITE = 'http://localhost/api/admin/roles/write';
const ASSIGN = 'http://localhost/api/admin/roles/assign';

beforeEach(() => {
  jest.clearAllMocks();
  fake = new StoreDb();
  mockDbHolder.db = fake;
  supa = new FakeSupaAdapter();
  __setSupaAdapterForTests(supa);
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
afterEach(() => {
  __setSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/v1/roles
// ---------------------------------------------------------------------------

describe('flag ON: GET /api/v1/roles', () => {
  it('roles list comes from the adapter; the users read stays on Firestore', async () => {
    supa.seed('roles', 'a1', { role: 'Supa Only' });
    fake.seed('roles', 'r1', { role: 'Firestore Only' });
    fake.seed('users', 'u1', { role: 'chapter_president', position: 'chapter_treasurer' });
    const res = await v1RolesGET();
    expect(res.status).toBe(200);
    const keys = (await res.json()).roles.map((r: { key: string }) => r.key);
    expect(keys).toContain('supa_only');
    expect(keys).not.toContain('firestore_only');
    expect(keys).toContain('chapter_treasurer'); // users.position, Firestore
    expect(supa.listDocs).toHaveBeenCalledWith('roles');
  });

  it('adapter error on the list falls back to the Firestore roles list, same envelope', async () => {
    supa.throwOn = 'listDocs';
    supa.seed('roles', 'a1', { role: 'Supa Only' });
    fake.seed('roles', 'r1', { role: 'Firestore Only' });
    const res = await v1RolesGET();
    expect(res.status).toBe(200);
    const keys = (await res.json()).roles.map((r: { key: string }) => r.key);
    expect(keys).toContain('firestore_only');
    expect(keys).not.toContain('supa_only');
  });
});

// ---------------------------------------------------------------------------
// /api/admin/role-permissions
// ---------------------------------------------------------------------------

describe('flag ON: GET /api/admin/role-permissions', () => {
  it('merge is served from the adapter: definition wins, adapter-only docs visible, Firestore-only docs invisible', async () => {
    supa.seed('roleDefinitions', 'chapter_president', {
      name: 'Chapter President',
      allowedPaths: ['/admin'],
      permissions: ['canManageTasks'],
    });
    supa.seed('role_permissions', 'chapter_president', { label: 'STALE MIRROR' });
    supa.seed('role_permissions', 'legacy_only', { label: 'Legacy Only' });
    fake.seed('roleDefinitions', 'chapter_president', { name: 'FIRESTORE NAME' });
    fake.seed('roleDefinitions', 'fs_only', { name: 'Firestore Only' });
    const res = await rpGET(req(RP, 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toHaveLength(2);
    const pres = body.roles.find((r: { id: string }) => r.id === 'chapter_president');
    expect(pres.label).toBe('Chapter President');
    expect(body.roles.find((r: { id: string }) => r.id === 'legacy_only').label).toBe('Legacy Only');
  });
});

describe('flag ON: POST /api/admin/role-permissions', () => {
  const createBody = {
    role: 'treasurer',
    label: 'Media Lead',
    allowedPaths: ['/admin'],
    canAccessAdmin: true,
    consentRequestId: 'cr-1',
  };

  it('200 create: Firestore batch stays primary and all three stores are mirrored (timestamps as ISO strings)', async () => {
    const res = await rpPOST(req(RP, 'POST', createBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, role: 'treasurer' });
    // Firestore primary (contracts' effect).
    expect(fake.read('roleDefinitions', 'treasurer')).toBeTruthy();
    expect(fake.read('role_permissions', 'treasurer')).toBeTruthy();
    expect(fake.read('permissions', 'treasurer')).toBeTruthy();
    // Adapter mirrors.
    expect(supa.read('roleDefinitions', 'treasurer')).toEqual(
      expect.objectContaining({ slug: 'treasurer', name: 'Media Lead' }),
    );
    expect(typeof supa.read('roleDefinitions', 'treasurer')?.updatedAt).toBe('string');
    expect(supa.read('role_permissions', 'treasurer')).toBeTruthy();
    expect(supa.read('permissions', 'treasurer')).toBeTruthy();
    expect(supa.setDoc).toHaveBeenCalledWith('roleDefinitions', 'treasurer', expect.any(Object));
    expect(supa.setDoc).toHaveBeenCalledWith('role_permissions', 'treasurer', expect.any(Object));
    expect(supa.setDoc).toHaveBeenCalledWith('permissions', 'treasurer', expect.any(Object));
  });

  it('existing definition is read from the adapter: a description-only edit stays ungated', async () => {
    supa.seed('roleDefinitions', 'chair_events', {
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
    // With a Firestore read this would look like a create and hit the gate.
    expect(mockGate).not.toHaveBeenCalled();
    expect(fake.read('roleDefinitions', 'chair_events')?.description).toBe('Runs all events.');
    expect(supa.read('roleDefinitions', 'chair_events')?.description).toBe('Runs all events.');
  });
});

describe('flag ON: DELETE /api/admin/role-permissions', () => {
  it('409 CUSTOM_ROLE_IN_USE from the adapter roles list (additionalRoles surface)', async () => {
    supa.seed('roleDefinitions', 'custom_poster_team_lead', { name: 'Poster Team Lead' });
    supa.seed('roles', 'holder-1', { role: 'member', additionalRoles: ['custom_poster_team_lead'] });
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'custom_poster_team_lead' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CUSTOM_ROLE_IN_USE');
    expect(body.holderCount).toBe(1);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('200 delete: Firestore stores deleted and the three deletes mirrored', async () => {
    for (const col of ['roleDefinitions', 'role_permissions', 'permissions']) {
      fake.seed(col, 'president', { name: 'President (legacy)', label: 'President' });
      supa.seed(col, 'president', { name: 'President (legacy)', label: 'President' });
    }
    const res = await rpDELETE(req(RP, 'DELETE', { role: 'president', consentRequestId: 'cr-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: 'president' });
    expect(fake.read('roleDefinitions', 'president')).toBeUndefined();
    expect(supa.read('roleDefinitions', 'president')).toBeUndefined();
    expect(supa.deleteDoc).toHaveBeenCalledWith('roleDefinitions', 'president');
    expect(supa.deleteDoc).toHaveBeenCalledWith('role_permissions', 'president');
    expect(supa.deleteDoc).toHaveBeenCalledWith('permissions', 'president');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/sync-user-role
// ---------------------------------------------------------------------------

describe('flag ON: POST /api/admin/sync-user-role', () => {
  it('roles record served from the adapter: mirror repair succeeds where Firestore has no record', async () => {
    supa.seed('roles', 'u1', { role: 'member' });
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', role: 'member' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uid: 'u1' });
    const written = fake.read('users', 'u1');
    expect(written?.role).toBe('member');
    expect(written?.displayRole).toBe('member');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'role_mirror_repair', targetId: 'u1' }),
    );
  });

  it('409 ROLE_WRITE_ROUTE_REQUIRED with the effective role taken from the adapter record', async () => {
    supa.seed('roles', 'u1', { role: 'member' });
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', role: 'chapter_president' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ROLE_WRITE_ROUTE_REQUIRED');
    expect(body.effectiveRole).toBe('member');
    expect(fake.read('users', 'u1')).toBeUndefined();
  });

  it('adapter error falls back to the Firestore roles record', async () => {
    supa.throwOn = 'getDoc';
    fake.seed('roles', 'u1', { role: 'member' });
    const res = await syncPOST(req(SYNC, 'POST', { uid: 'u1', role: 'member' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uid: 'u1' });
    expect(fake.read('users', 'u1')?.role).toBe('member');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/roles/assign + /api/admin/roles/write
// ---------------------------------------------------------------------------

describe('flag ON: POST /api/admin/roles/assign', () => {
  it('custom appoint keeps the primary read from the adapter roles record', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    supa.seed('roles', 'u9', { role: 'chapter_president', additionalRoles: [] });
    mockAuth.mockResolvedValue({
      authenticated: true,
      user: { userId: FOUNDER_UID, role: 'founder_patron' },
    });
    const res = await assignPOST(
      req(ASSIGN, 'POST', {
        targetUid: 'u9',
        role: 'custom_poster_team_lead',
        reason: 'a justification that is long enough',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'chapter_president' });
    // Without the seam read the Firestore-missing record would floor
    // the primary at member_basic.
    expect(mockAssign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        uid: 'u9',
        role: 'chapter_president',
        additionalRoles: ['custom_poster_team_lead'],
      }),
    );
  });
});

describe('flag ON: POST /api/admin/roles/write', () => {
  it('remove: the consent-gate role key is resolved from the adapter roles record', async () => {
    mockAuth.mockResolvedValue({
      authenticated: true,
      user: { userId: FOUNDER_UID, role: 'founder_patron' },
    });
    supa.seed('roles', 'u9', { role: 'chapter_president' });
    mockIsCatB.mockResolvedValue(true);
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
    expect(mockIsCatB).toHaveBeenCalledWith(expect.anything(), 'chapter_president');
    expect(mockGate).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectRef: expect.objectContaining({ roleKey: 'chapter_president', action: 'remove' }),
      }),
    );
    expect(mockRemove).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/roles/[slug]
// ---------------------------------------------------------------------------

describe('flag ON: DELETE /api/admin/roles/[slug]', () => {
  const call = (slug: string) =>
    slugDELETE(req(`http://localhost/api/admin/roles/${slug}`, 'DELETE', {}), {
      params: { slug },
    });

  it('200 for a definition that exists only in the adapter; deletes mirrored, audit doc written', async () => {
    supa.seed('roleDefinitions', 'legacy_junk_role', { name: 'Junk Role' });
    supa.seed('permissions', 'legacy_junk_role', { canAccessAdmin: true });
    const res = await call('legacy_junk_role');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: "Role definition 'Junk Role' deleted.",
    });
    expect(supa.deleteDoc).toHaveBeenCalledWith('roleDefinitions', 'legacy_junk_role');
    expect(supa.deleteDoc).toHaveBeenCalledWith('permissions', 'legacy_junk_role');
    expect(supa.deleteDoc).toHaveBeenCalledWith('role_permissions', 'legacy_junk_role');
    expect(fake.all('audit_logs')).toHaveLength(1);
    expect(fake.all('audit_logs')[0].data.type).toBe('ROLE_DEFINITION_DELETE');
  });

  it('409 with holderCount from the adapter roles list (primary surface)', async () => {
    supa.seed('roleDefinitions', 'chapter_events_chair', { name: 'Chapter Events Chair' });
    supa.seed('roles', 'holder-1', { role: 'chapter_events_chair' });
    const res = await call('chapter_events_chair');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.holderCount).toBe(1);
    expect(body.error).toContain('still held by 1 user(s)');
    expect(mockGate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flag OFF with an adapter present: byte-identical Firestore behavior
// ---------------------------------------------------------------------------

describe('flag OFF (adapter injected, useSupa false)', () => {
  it('role-permissions GET serves Firestore and never calls the adapter data functions', async () => {
    supa.on = false;
    supa.seed('roleDefinitions', 'chapter_president', { name: 'SUPA NAME' });
    fake.seed('roleDefinitions', 'chapter_president', { name: 'Chapter President' });
    const res = await rpGET(req(RP, 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles.find((r: { id: string }) => r.id === 'chapter_president').label).toBe(
      'Chapter President',
    );
    expect(supa.getDoc).not.toHaveBeenCalled();
    expect(supa.listDocs).not.toHaveBeenCalled();
    expect(supa.setDoc).not.toHaveBeenCalled();
    expect(supa.deleteDoc).not.toHaveBeenCalled();
  });
});
