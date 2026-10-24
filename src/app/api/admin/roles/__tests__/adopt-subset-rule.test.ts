/**
 * @jest-environment node
 *
 * Adoption pack items 4, 5, 23 (RP-05 / RP-13):
 *  - Item 4 (Q1): subset rule at role create, editor save, and
 *    assignment. A non-founder actor can only grant permissions they
 *    themselves hold (holder-scoped union); violations are rejected
 *    (SUBSET_VIOLATION), never stripped. Founder exempt.
 *  - Item 5 (Q2): the subset rule also covers catalog definition
 *    edits, and non-founder self-assignment of a permission-bearing
 *    role is banned outright (SELF_ASSIGNMENT_FORBIDDEN).
 *  - Item 23 (Q18): DELETE /api/admin/roles/[slug] refuses catalog
 *    slugs with the exact 403 body of the UI route
 *    (DELETE /api/admin/role-permissions).
 */

jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    assertConsentFor: jest.fn(),
    isCategoryBRole: jest.fn().mockResolvedValue(false),
    canonicaliseRoleKey: (k: string) => String(k ?? '').trim().toLowerCase(),
    consentGateHttpError: (err: unknown) =>
      err instanceof types.ConsentRequiredError
        ? { status: 409, body: { error: 'CONSENT_REQUIRED', code: 'CONSENT_REQUIRED' } }
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
  hasServerPermission: jest.fn(),
  hasServerPermissionForUser: jest.fn(),
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
    assignRole: jest.fn().mockResolvedValue({
      roleDoc: { role: 'member', additionalRoles: [], expiresAt: null },
      previousEffectiveRole: null,
      newEffectiveRole: 'member',
      alreadyApplied: false,
    }),
    removeRole: jest.fn().mockResolvedValue({
      previousEffectiveRole: 'member',
      alreadyApplied: false,
    }),
    validateAssignRoleInput: jest.fn().mockResolvedValue(undefined),
    validateRemoveRoleInput: jest.fn(),
    RoleWriteError,
  };
});

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { NextRequest } from 'next/server';
import { POST as rpPOST, DELETE as rpDELETE } from '@/app/api/admin/role-permissions/route';
import { DELETE as slugDELETE } from '@/app/api/admin/roles/[slug]/route';
import { POST as writePOST } from '@/app/api/admin/roles/write/route';
import { POST as assignPOST } from '@/app/api/admin/roles/assign/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission, hasServerPermissionForUser } from '@/lib/server/permissions';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { assignRole } from '@/lib/server/role-writes';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermission as jest.Mock;
const mockPermForUser = hasServerPermissionForUser as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockAssign = assignRole as jest.Mock;

/** Permissions the actor effectively holds (holder-scoped union). */
let actorHeld: Set<string>;
/** Permissions each role slug grants, as hasServerPermission sees it. */
let roleGrants: Record<string, string[]>;

interface Holder {
  id: string;
  role?: string;
  displayRole?: string;
  additionalRoles?: string[];
}

function makeDb(opts: {
  defs?: Record<string, Record<string, unknown> | null>;
  chapters?: Record<string, Record<string, unknown> | null>;
  users?: Record<string, Record<string, unknown>>;
  roles?: Record<string, Record<string, unknown>>;
  holders?: Holder[];
} = {}) {
  const ops: Array<{ op: string; col: string; id: string }> = [];
  const docData = (name: string, id: string) => {
    if (name === 'roleDefinitions') return opts.defs?.[id] ?? null;
    if (name === 'chapters') return opts.chapters?.[id] ?? null;
    if (name === 'users') return opts.users?.[id] ?? null;
    if (name === 'roles') return opts.roles?.[id] ?? null;
    return null;
  };
  const db = {
    __ops: ops,
    collection: (name: string) => ({
      doc: (id: string) => ({
        __col: name,
        __id: id,
        get: async () => {
          const data = docData(name, id);
          return data
            ? { exists: true, id, data: () => data }
            : { exists: false, id, data: () => undefined };
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => {
          const docs = (opts.holders ?? [])
            .filter((h) =>
              field === 'additionalRoles'
                ? (h.additionalRoles ?? []).includes(value as string)
                : (h as unknown as Record<string, unknown>)[field] === value,
            )
            .map((h) => ({ id: h.id }));
          return { docs, empty: docs.length === 0, size: docs.length };
        },
      }),
    }),
    batch: () => {
      const batchOps: Array<{ op: string; col: string; id: string }> = [];
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

function req(url: string, method: string, body: Record<string, unknown>) {
  return new NextRequest(url, { method, body: JSON.stringify(body) });
}

function asUser(userId: string, role: string) {
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId, uid: userId, role, displayName: 'Test', email: 't@example.com' },
  });
}

const CHAPTER_ID = 'seds-ist-chapter';
const CUSTOM_SLUG = 'custom_poster_team_lead';

function customCreateBody(permissionKeys: string[]) {
  return {
    role: CUSTOM_SLUG,
    label: 'Poster Team Lead',
    description: 'Runs posters.',
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER_ID,
    permissionKeys,
    allowedPaths: ['/admin/tasks'],
    allowedChapters: [CHAPTER_ID],
    scope: 'chapter',
    canAccessAdmin: true,
    isActive: true,
    consentRequestId: 'cr-1',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  actorHeld = new Set();
  roleGrants = {};
  mockPerm.mockImplementation(async (role: string, key: string) => {
    if (role === 'founder_patron' || role === 'superadmin') return true;
    const grants = roleGrants[role];
    return grants ? grants.includes(key) : false;
  });
  mockPermForUser.mockImplementation(async (_db: unknown, _uid: string, key: string) =>
    actorHeld.has(key),
  );
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockAssign.mockResolvedValue({
    roleDoc: { role: 'member', additionalRoles: [], expiresAt: null },
    previousEffectiveRole: null,
    newEffectiveRole: 'member',
    alreadyApplied: false,
  });
  asUser('admin-1', 'executive_director');
});

// ---------------------------------------------------------------------
// Item 4/5: role-permissions POST (create, editor save, catalog edits)
// ---------------------------------------------------------------------

describe('subset rule: role-permissions POST', () => {
  it('non-founder creating a custom role with a permission they lack is rejected, no writes, no gate', async () => {
    actorHeld = new Set(['canManagePermissions', 'canManageTasks']);
    roleGrants = { executive_director: ['canManagePermissions', 'canManageTasks'] };
    const db = makeDb({ chapters: { [CHAPTER_ID]: { name: 'IST', isActive: true } } });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST',
        customCreateBody(['canManageTasks', 'canManageFinance'])),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('SUBSET_VIOLATION');
    expect(json.missingPermissions).toEqual(['canManageFinance']);
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('non-founder editor save of a custom role with a permission they lack is rejected', async () => {
    actorHeld = new Set(['canManagePermissions', 'canManageTasks']);
    roleGrants = { executive_director: ['canManagePermissions', 'canManageTasks'] };
    const db = makeDb({
      defs: {
        [CUSTOM_SLUG]: {
          isCustom: true, parentRoleKey: 'chapter_design_chair', chapterId: CHAPTER_ID,
          permissions: ['canManageTasks'], scope: 'chapter',
        },
      },
      chapters: { [CHAPTER_ID]: { name: 'IST', isActive: true } },
    });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST', {
        role: CUSTOM_SLUG, label: 'Poster Team Lead',
        permissionKeys: ['canManageTasks', 'canManageFinance'],
        allowedChapters: [CHAPTER_ID], scope: 'chapter', consentRequestId: 'cr-1',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SUBSET_VIOLATION');
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('catalog edit: non-founder adding a permission they lack to a catalog role is rejected (item 5)', async () => {
    actorHeld = new Set(['canManagePermissions', 'canManageTasks']);
    roleGrants = { executive_director: ['canManagePermissions', 'canManageTasks'] };
    const db = makeDb({
      defs: { chapter_treasurer: { permissions: ['canManageTasks'], scope: 'chapter' } },
    });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST', {
        role: 'chapter_treasurer', label: 'Chapter Treasurer',
        permissionKeys: ['canManageTasks', 'canManageFinance'],
        allowedChapters: [], scope: 'chapter', consentRequestId: 'cr-1',
      }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('SUBSET_VIOLATION');
    expect(json.missingPermissions).toEqual(['canManageFinance']);
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('catalog edit: non-founder granting a Reserved Power they lack is rejected (no catalog ceiling bypass)', async () => {
    actorHeld = new Set(['canManagePermissions', 'canManageTasks']);
    roleGrants = { executive_director: ['canManagePermissions', 'canManageTasks'] };
    const db = makeDb({
      defs: { chapter_treasurer: { permissions: ['canManageTasks'], scope: 'chapter' } },
    });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST', {
        role: 'chapter_treasurer', label: 'Chapter Treasurer',
        permissionKeys: ['canManageTasks', 'canManageRoles'],
        allowedChapters: [], scope: 'chapter', consentRequestId: 'cr-1',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).missingPermissions).toEqual(['canManageRoles']);
    expect(db.__ops).toHaveLength(0);
  });

  it('subset grant passes: non-founder granting only permissions they hold succeeds', async () => {
    actorHeld = new Set(['canManagePermissions', 'canManageTasks', 'canManageFinance']);
    roleGrants = { executive_director: ['canManagePermissions', 'canManageTasks', 'canManageFinance'] };
    const db = makeDb({ chapters: { [CHAPTER_ID]: { name: 'IST', isActive: true } } });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST',
        customCreateBody(['canManageTasks', 'canManageFinance'])),
    );
    expect(res.status).toBe(200);
    expect(db.__ops.filter((o) => o.op === 'set')).toHaveLength(3);
  });

  it('founder is exempt at custom create even when the holder-scoped set is empty', async () => {
    actorHeld = new Set();
    asUser(FOUNDER_UID, 'founder_patron');
    const db = makeDb({ chapters: { [CHAPTER_ID]: { name: 'IST', isActive: true } } });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST',
        customCreateBody(['canManageFinance'])),
    );
    expect(res.status).toBe(200);
    expect(db.__ops.filter((o) => o.op === 'set')).toHaveLength(3);
  });

  it('founder is exempt at catalog editor save', async () => {
    actorHeld = new Set();
    asUser(FOUNDER_UID, 'founder_patron');
    const db = makeDb({
      defs: { chapter_treasurer: { permissions: ['canManageTasks'], scope: 'chapter' } },
    });
    mockDbHolder.db = db;
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST', {
        role: 'chapter_treasurer', label: 'Chapter Treasurer',
        permissionKeys: ['canManageFinance'],
        allowedChapters: [], scope: 'chapter', consentRequestId: 'cr-1',
      }),
    );
    expect(res.status).toBe(200);
    expect(db.__ops.filter((o) => o.op === 'set')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------
// Item 4/5: assignment (roles/write and roles/assign)
// ---------------------------------------------------------------------

describe('subset rule: assignment via roles/write', () => {
  function writeDb() {
    return makeDb({ users: { 'admin-1': { role: 'president_national' } } });
  }

  it('non-founder assigning a role whose permissions exceed their own is rejected before the gate', async () => {
    actorHeld = new Set(['canManageRoles', 'canManageTasks']);
    roleGrants = {
      president_national: ['canManageRoles', 'canManageTasks'],
      chapter_treasurer: ['canAccessAdmin', 'canManageFinance'],
    };
    mockDbHolder.db = writeDb();
    const res = await writePOST(
      req('http://localhost/api/admin/roles/write', 'POST', {
        action: 'assign', uid: 'user-9', role: 'chapter_treasurer',
        reason: 'Appointing the treasurer',
      }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('SUBSET_VIOLATION');
    expect(json.missingPermissions).toEqual(expect.arrayContaining(['canManageFinance']));
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('founder is exempt at assignment', async () => {
    actorHeld = new Set();
    asUser(FOUNDER_UID, 'founder_patron');
    mockDbHolder.db = makeDb({ users: { [FOUNDER_UID]: { role: 'founder_patron' } } });
    roleGrants = { chapter_treasurer: ['canAccessAdmin', 'canManageFinance'] };
    const res = await writePOST(
      req('http://localhost/api/admin/roles/write', 'POST', {
        action: 'assign', uid: 'user-9', role: 'chapter_treasurer',
        reason: 'Appointing the treasurer',
      }),
    );
    expect(res.status).toBe(200);
    expect(mockAssign).toHaveBeenCalled();
  });

  it('self-assignment of a permission-bearing role is refused outright even when the actor holds its permissions (item 5)', async () => {
    actorHeld = new Set(['canManageRoles', 'canManageTasks', 'canAccessAdmin']);
    roleGrants = {
      president_national: ['canManageRoles', 'canManageTasks', 'canAccessAdmin'],
      chapter_treasurer: ['canAccessAdmin', 'canManageTasks'],
    };
    mockDbHolder.db = writeDb();
    const res = await writePOST(
      req('http://localhost/api/admin/roles/write', 'POST', {
        action: 'assign', uid: 'admin-1', role: 'chapter_treasurer',
        reason: 'Making myself treasurer',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_ASSIGNMENT_FORBIDDEN');
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('subset assignment to another person passes when the actor holds the role permissions', async () => {
    actorHeld = new Set(['canManageRoles', 'canManageTasks', 'canAccessAdmin']);
    roleGrants = {
      president_national: ['canManageRoles', 'canManageTasks', 'canAccessAdmin'],
      chapter_treasurer: ['canAccessAdmin', 'canManageTasks'],
    };
    mockDbHolder.db = writeDb();
    const res = await writePOST(
      req('http://localhost/api/admin/roles/write', 'POST', {
        action: 'assign', uid: 'user-9', role: 'chapter_treasurer',
        reason: 'Appointing the treasurer',
      }),
    );
    expect(res.status).toBe(200);
    expect(mockAssign).toHaveBeenCalled();
  });
});

describe('subset rule: assignment via roles/assign', () => {
  function assignDb(target = 'user-1') {
    return makeDb({
      users: { [target]: { role: 'member_basic' }, 'admin-1': { role: 'member_basic' } },
      roles: { [target]: { role: 'member_basic', additionalRoles: [] }, 'admin-1': { role: 'member_basic', additionalRoles: [] } },
    });
  }

  it('non-founder assigning a role with a permission they lack is rejected', async () => {
    actorHeld = new Set(['canManageRoles', 'canManageTasks']);
    roleGrants = {
      executive_director: ['canManageRoles', 'canManageTasks'],
      chapter_treasurer: ['canAccessAdmin', 'canManageFinance'],
    };
    mockDbHolder.db = assignDb();
    const res = await assignPOST(
      req('http://localhost/api/admin/roles/assign', 'POST', {
        targetUid: 'user-1', role: 'chapter_treasurer', reason: 'Appointing the treasurer',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SUBSET_VIOLATION');
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('self-assignment of a permission-bearing role is refused outright via roles/assign (item 5)', async () => {
    actorHeld = new Set(['canManageRoles', 'canManageTasks', 'canAccessAdmin']);
    roleGrants = {
      executive_director: ['canManageRoles', 'canManageTasks', 'canAccessAdmin'],
      chapter_treasurer: ['canAccessAdmin', 'canManageTasks'],
    };
    mockDbHolder.db = assignDb('admin-1');
    const res = await assignPOST(
      req('http://localhost/api/admin/roles/assign', 'POST', {
        targetUid: 'admin-1', role: 'chapter_treasurer', reason: 'Making myself treasurer',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_ASSIGNMENT_FORBIDDEN');
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('founder is exempt at assignment via roles/assign', async () => {
    actorHeld = new Set();
    asUser(FOUNDER_UID, 'founder_patron');
    roleGrants = { chapter_treasurer: ['canAccessAdmin', 'canManageFinance'] };
    mockDbHolder.db = assignDb();
    const res = await assignPOST(
      req('http://localhost/api/admin/roles/assign', 'POST', {
        targetUid: 'user-1', role: 'chapter_treasurer', reason: 'Appointing the treasurer',
      }),
    );
    expect(res.status).toBe(200);
    expect(mockAssign).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Item 23: [slug] DELETE catalog-slug block mirrors the UI route
// ---------------------------------------------------------------------

describe('item 23: roles/[slug] DELETE catalog block', () => {
  it('holderless catalog slug is refused 403 with the exact UI-route body, gate never called', async () => {
    asUser(FOUNDER_UID, 'founder_patron');
    const db = makeDb({ defs: { chapter_treasurer: { name: 'Chapter Treasurer' } }, holders: [] });
    mockDbHolder.db = db;
    const res = await slugDELETE(
      req('http://localhost/api/admin/roles/chapter_treasurer', 'DELETE', {}),
      { params: { slug: 'chapter_treasurer' } },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Role "chapter_treasurer" is a catalog role and cannot be deleted.',
    });
    expect(mockGate).not.toHaveBeenCalled();
    expect(db.__ops).toHaveLength(0);

    // Identical refusal from the UI route for the same slug.
    const uiRes = await rpDELETE(
      req('http://localhost/api/admin/role-permissions', 'DELETE', { role: 'chapter_treasurer' }),
    );
    expect(uiRes.status).toBe(403);
    expect(await uiRes.json()).toEqual({
      error: 'Role "chapter_treasurer" is a catalog role and cannot be deleted.',
    });
  });

  it('control: a holderless non-catalog slug still deletes through the [slug] route', async () => {
    asUser(FOUNDER_UID, 'founder_patron');
    const db = makeDb({ defs: { custom_poster_team_lead: { name: 'Poster Team' } }, holders: [] });
    mockDbHolder.db = db;
    const res = await slugDELETE(
      req('http://localhost/api/admin/roles/custom_poster_team_lead', 'DELETE', {}),
      { params: { slug: 'custom_poster_team_lead' } },
    );
    expect(res.status).toBe(200);
    expect(db.__ops.filter((o) => o.op === 'delete').length).toBeGreaterThanOrEqual(3);
  });
});
