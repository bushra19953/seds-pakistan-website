/**
 * @jest-environment node
 *
 * Role catalog gate tests (spec B.7 cases 14-16): create/permissions/scope
 * classification, single-batch triple write, gated deletes on both routes.
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
import { POST, DELETE } from '@/app/api/admin/role-permissions/route';
import { DELETE as slugDelete } from '@/app/api/admin/roles/[slug]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;

interface Op {
  op: string;
  col: string;
  id: string;
  data?: Record<string, unknown>;
}

function makeDb(existingDef: Record<string, unknown> | null) {
  const ops: Op[] = [];
  const db = {
    __ops: ops,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'roleDefinitions' && existingDef) {
            return { exists: true, id, data: () => existingDef };
          }
          return { exists: false, id, data: () => undefined };
        },
      }),
      where: () => ({ get: async () => ({ docs: [], forEach: () => undefined }) }),
    }),
    batch: () => {
      const batchOps: Op[] = [];
      const capture =
        (op: string) =>
        (ref: { __col: string; __id: string }, data?: Record<string, unknown>) => {
          batchOps.push({ op, col: ref.__col, id: ref.__id, data });
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
  // Batch refs need collection identity: rebuild doc() to tag refs.
  const origCollection = db.collection.bind(db);
  db.collection = (name: string) => {
    const col = origCollection(name);
    const origDoc = col.doc.bind(col);
    col.doc = (id: string) => {
      const ref = origDoc(id) as never as Record<string, unknown>;
      ref.__col = name;
      ref.__id = id;
      return ref as ReturnType<typeof origDoc>;
    };
    return col;
  };
  return db;
}

function req(url: string, method: string, body: Record<string, unknown>) {
  return new NextRequest(url, { method, body: JSON.stringify(body) });
}

function gateMissing(slug: string, action: string) {
  return new ConsentRequiredError({
    matterKey: 'role_catalog',
    subjectRef: { type: 'role_definition', slug, action: action as never },
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
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
});

it('creating a role without consent returns 409 and writes nothing', async () => {
  const db = makeDb(null);
  mockDbHolder.db = db;
  mockGate.mockRejectedValue(gateMissing('treasurer', 'create'));
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'treasurer',
      label: 'Media Lead',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
    }),
  );
  expect(res.status).toBe(409);
  expect(db.__ops).toHaveLength(0);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'role_definition', slug: 'treasurer', action: 'create' },
    }),
  );
});

it('creating a role with consent writes all three stores in one batch', async () => {
  const db = makeDb(null);
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'treasurer',
      label: 'Media Lead',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  const sets = db.__ops.filter((o) => o.op === 'set').map((o) => o.col);
  expect(sets).toEqual(expect.arrayContaining(['roleDefinitions', 'role_permissions', 'permissions']));
});

it('a permissions change to an existing role without consent returns 409', async () => {
  const db = makeDb({ allowedPaths: ['/admin'], canAccessAdmin: true, scope: 'chapter' });
  mockDbHolder.db = db;
  mockGate.mockRejectedValue(gateMissing('chair_events', 'permissions'));
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'chair_events',
      label: 'Chair Events',
      allowedPaths: ['/admin', '/admin/tasks'],
      canAccessAdmin: true,
    }),
  );
  expect(res.status).toBe(409);
  expect(db.__ops).toHaveLength(0);
});

it('a description-only edit is ungated and proceeds', async () => {
  const db = makeDb({ allowedPaths: ['/admin'], canAccessAdmin: true, scope: 'chapter', description: 'old' });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'chair_events',
      label: 'Chair Events',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
      description: 'Runs all events.',
    }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
  expect(db.__ops.filter((o) => o.op === 'set')).toHaveLength(3);
});

it('a drawer payload (permissionKeys) gates and writes the boolean permissions map', async () => {
  const db = makeDb({ permissions: ['canViewAuditLogs'], scope: 'chapter', description: '' });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'chair_events',
      label: 'Chair Events',
      permissionKeys: ['canViewAuditLogs', 'canManageUsers'],
      allowedChapters: [],
      scope: 'chapter',
      description: '',
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'role_definition', slug: 'chair_events', action: 'permissions' },
    }),
  );
  const permWrite = db.__ops.find((o) => o.col === 'permissions');
  expect((permWrite?.data as Record<string, unknown>)?.canManageUsers).toBe(true);
  expect((permWrite?.data as Record<string, unknown>)?.canViewAuditLogs).toBe(true);
});

it('DELETE without consent returns 409 and deletes nothing', async () => {
  const db = makeDb({ allowedPaths: [], canAccessAdmin: false });
  mockDbHolder.db = db;
  mockGate.mockRejectedValue(gateMissing('chair_events', 'delete'));
  const res = await DELETE(
    req('http://localhost/api/admin/role-permissions', 'DELETE', { role: 'chair_events' }),
  );
  expect(res.status).toBe(409);
  expect(db.__ops).toHaveLength(0);
});

it('DELETE with consent deletes all three docs', async () => {
  const db = makeDb({ allowedPaths: [], canAccessAdmin: false });
  mockDbHolder.db = db;
  const res = await DELETE(
    req('http://localhost/api/admin/role-permissions', 'DELETE', {
      role: 'chair_events',
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  const deletes = db.__ops.filter((o) => o.op === 'delete').map((o) => o.col);
  expect(deletes).toEqual(expect.arrayContaining(['roleDefinitions', 'role_permissions', 'permissions']));
});

it('roles/[slug] nuclear DELETE without consent returns the gate 409', async () => {
  const db = makeDb({ name: 'Chair Events' });
  mockDbHolder.db = db;
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin' },
  });
  mockGate.mockRejectedValue(gateMissing('chair_events', 'delete'));
  const res = await slugDelete(
    req('http://localhost/api/admin/roles/chair_events', 'DELETE', {}),
    { params: { slug: 'chair_events' } },
  );
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('CONSENT_REQUIRED');
});

// ---------------------------------------------------------------------------
// LEGACY-JUNK item (Custom Roles Fix Program), plan section 9.2.
//
// The four census junk ids (permissions-store doc ids: hyphenated spellings
// of Block 2 legacy aliases) must fail create-validation EXACTLY like an
// unknown slug: the plan section 5.2 guard classifies the RAW body value
// before the route's line-132 normalisation, the closure, the isCreate
// classification and the consent gate. On today's code these POSTs PASS the
// closure (resolveRole re-normalises hyphens away), reach the gate and
// write all three stores - plan section 4, HOLE 1. The junk cases below
// are the regression pin for the whole item and FAIL until the guard
// lands; the unknown-slug and legacy control cases pass before and after.
// ---------------------------------------------------------------------------

const JUNK_IDS = ['pakistan-president', 'super-admin', 'chair-design-media', 'advisor-faculty-head'];

function registryCreateBody(role: string) {
  // The exact shape the role registry's Create dialog sends
  // (role-registry.tsx handleCreateRole).
  return {
    role,
    label: 'Some Label',
    description: '',
    category: 'Committee',
    permissionKeys: [] as string[],
    allowedChapters: [] as string[],
    scope: 'chapter',
    isActive: true,
    consentRequestId: 'cr-1',
  };
}

describe('legacy-junk guard: junk ids fail create-validation like unknown slugs', () => {
  it.each(JUNK_IDS)('POST %s returns the Unknown-role 400, writes nothing, never reaches the consent gate', async (junk) => {
    const db = makeDb(null);
    mockDbHolder.db = db;
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', registryCreateBody(junk)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      `Unknown role "${junk}". Roles are fixed by the Role Catalog.`,
    );
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('an unknown invented slug fails identically (control: passes before and after the guard)', async () => {
    const db = makeDb(null);
    mockDbHolder.db = db;
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', registryCreateBody('media_lead')),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      'Unknown role "media_lead". Roles are fixed by the Role Catalog.',
    );
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('a junk create is refused BEFORE the consent gate: gate missing still yields 400, not the gate 409', async () => {
    const db = makeDb(null);
    mockDbHolder.db = db;
    mockGate.mockRejectedValue(gateMissing('super-admin', 'create'));
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', registryCreateBody('super-admin')),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      'Unknown role "super-admin". Roles are fixed by the Role Catalog.',
    );
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it('an edit-shaped POST for a junk id (definition doc already exists) is still 400: the guard precedes isCreate', async () => {
    const db = makeDb({ slug: 'super-admin', name: 'Super Admin', permissions: [] });
    mockDbHolder.db = db;
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', registryCreateBody('super-admin')),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      'Unknown role "super-admin". Roles are fixed by the Role Catalog.',
    );
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it.each([
    'Super-Admin',
    'SUPER-ADMIN',
    ' super-admin ',
    'super admin',
    'Chair-Design-Media',
    'CHAIR-DESIGN-MEDIA',
    'Pakistan-President',
    'PAKISTAN-PRESIDENT',
    'Advisor-Faculty-Head',
    'ADVISOR-FACULTY-HEAD',
  ])('normalisation attack %j cannot bypass the guard: 400 and no writes', async (raw) => {
    const db = makeDb(null);
    mockDbHolder.db = db;
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', registryCreateBody(raw)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /^Unknown role ".*"\. Roles are fixed by the Role Catalog\.$/,
    );
    expect(db.__ops).toHaveLength(0);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("control: the exact Block 2 legacy key 'super_admin' is NOT junk and still passes (ruling C2)", async () => {
    const db = makeDb(null);
    mockDbHolder.db = db;
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', registryCreateBody('super_admin')),
    );
    expect(res.status).toBe(200);
    const defWrite = db.__ops.find((o) => o.op === 'set' && o.col === 'roleDefinitions');
    expect(defWrite?.id).toBe('super_admin');
  });
});
