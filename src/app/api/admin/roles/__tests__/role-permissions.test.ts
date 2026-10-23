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

import { NextRequest, NextResponse } from 'next/server';
import { POST, DELETE } from '@/app/api/admin/role-permissions/route';
import { DELETE as slugDelete } from '@/app/api/admin/roles/[slug]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { ADMIN_PERMISSIONS } from '@/config/permission-registry';

const mockAuth = verifyAuthentication as jest.Mock;
const mockGate = assertConsentFor as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;

interface Op {
  op: string;
  col: string;
  id: string;
  data?: Record<string, unknown>;
}

interface MakeDbOptions {
  /** roleDefinitions docs keyed by doc id; a null/absent id = doc missing.
   *  When given, replaces the single-def behaviour of `existingDef`. */
  defs?: Record<string, Record<string, unknown> | null>;
  /** chapters docs keyed by doc id; a null/absent id = doc missing. */
  chapters?: Record<string, Record<string, unknown> | null>;
  /** roles/{uid} grant docs, served to `where('role','==',slug)` and
   *  `where('additionalRoles','array-contains',slug)` queries so the
   *  DELETE holders fences see real holders instead of zero docs. */
  roleHolders?: Array<{ id: string; role?: string; additionalRoles?: string[] }>;
}

function makeDb(existingDef: Record<string, unknown> | null, opts: MakeDbOptions = {}) {
  const ops: Op[] = [];
  const docSnapshot = (name: string, id: string) => {
    if (name === 'roleDefinitions') {
      if (opts.defs) {
        const def = opts.defs[id];
        return def
          ? { exists: true, id, data: () => def }
          : { exists: false, id, data: () => undefined };
      }
      if (existingDef) return { exists: true, id, data: () => existingDef };
      return { exists: false, id, data: () => undefined };
    }
    if (name === 'chapters' && opts.chapters) {
      const chapter = opts.chapters[id];
      return chapter
        ? { exists: true, id, data: () => chapter }
        : { exists: false, id, data: () => undefined };
    }
    return { exists: false, id, data: () => undefined };
  };
  const db = {
    __ops: ops,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => docSnapshot(name, id),
      }),
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
// CREATE-PATH (custom roles): plan.md section 6 cases T1-T14, written
// against globals/contracts.md sections 1.1-1.5 and 3.1 (BINDING). Where
// the plan's draft and contracts disagreed, contracts won - notably the
// immutability trigger, which contracts 3.1 folds into
// CUSTOM_DEFINITION_INVALID (the plan's CUSTOM_IMMUTABLE_FIELD code was
// not adopted). All custom validation must run BEFORE the consent gate:
// every rejection below asserts gate-not-called, zero batch ops, and no
// governance audit.
// ---------------------------------------------------------------------------

const CHAPTER_ID = 'seds-ist-chapter';
const OTHER_CHAPTER_ID = 'seds-other-chapter';
const CUSTOM_SLUG = 'custom_poster_team_lead';

const ACTIVE_CHAPTERS: Record<string, Record<string, unknown>> = {
  [CHAPTER_ID]: { name: 'SEDS IST Chapter', isActive: true },
  [OTHER_CHAPTER_ID]: { name: 'SEDS Other Chapter', isActive: true },
};

const VALID_CUSTOM_DEF: Record<string, unknown> = {
  role: CUSTOM_SLUG,
  slug: CUSTOM_SLUG,
  name: 'Poster Team Lead',
  label: 'Poster Team Lead',
  isCustom: true,
  parentRoleKey: 'chapter_design_chair',
  chapterId: CHAPTER_ID,
  description: '',
  permissions: [],
  scope: 'chapter',
  category: 'Custom',
  allowedChapters: [CHAPTER_ID],
  allowedPaths: [],
  canAccessAdmin: true,
  isActive: true,
};

function customCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: CUSTOM_SLUG,
    label: 'Poster Team Lead',
    description: 'Runs the poster team for the chapter.',
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER_ID,
    permissionKeys: [],
    allowedPaths: ['/admin/tasks'],
    allowedChapters: [CHAPTER_ID],
    scope: 'chapter',
    canAccessAdmin: true,
    isActive: true,
    consentRequestId: 'cr-1',
    ...overrides,
  };
}

function editorSaveBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: CUSTOM_SLUG,
    label: 'Poster Team Lead',
    permissionKeys: [],
    allowedPaths: [],
    allowedChapters: [CHAPTER_ID],
    scope: 'chapter',
    category: 'Custom',
    isActive: true,
    description: '',
    ...overrides,
  };
}

function dbWithCustomDef(
  def: Record<string, unknown> = VALID_CUSTOM_DEF,
  extra: MakeDbOptions = {},
) {
  return makeDb(null, {
    defs: { [CUSTOM_SLUG]: def },
    chapters: ACTIVE_CHAPTERS,
    ...extra,
  });
}

async function expectRejection(
  res: NextResponse,
  db: ReturnType<typeof makeDb>,
  code: string,
) {
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.code).toBe(code);
  expect(typeof json.error).toBe('string');
  expect(db.__ops).toHaveLength(0);
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
}

it('T1: a genuinely new custom role creates through the gate and writes all three stores', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', customCreateBody()),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, role: CUSTOM_SLUG });
  expect(mockGate).toHaveBeenCalledTimes(1);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      matterKey: 'role_catalog',
      subjectRef: { type: 'role_definition', slug: CUSTOM_SLUG, action: 'create' },
    }),
  );
  expect(mockAudit).toHaveBeenCalledTimes(1);
  const sets = db.__ops.filter((o) => o.op === 'set');
  expect(sets).toHaveLength(3);
  expect(sets.map((o) => o.col)).toEqual(
    expect.arrayContaining(['roleDefinitions', 'role_permissions', 'permissions']),
  );
  expect(sets.every((o) => o.id === CUSTOM_SLUG)).toBe(true);
  const defWrite = sets.find((o) => o.col === 'roleDefinitions');
  expect(defWrite?.data).toEqual(
    expect.objectContaining({
      isCustom: true,
      parentRoleKey: 'chapter_design_chair',
      chapterId: CHAPTER_ID,
      scope: 'chapter',
      category: 'Custom',
      allowedChapters: [CHAPTER_ID],
      permissions: [],
      name: 'Poster Team Lead',
      label: 'Poster Team Lead',
    }),
  );
  const permData = sets.find((o) => o.col === 'permissions')?.data as Record<string, unknown>;
  expect(permData._scope).toBe('chapter');
  expect(permData._allowedChapters).toEqual([CHAPTER_ID]);
  for (const key of Object.keys(ADMIN_PERMISSIONS)) {
    expect(permData[key]).toBe(false);
  }
});

it('T1b: create stores the sent permissionKeys and defaultTermDays on the definition', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ permissionKeys: ['canManageTasks'], defaultTermDays: 90 }),
    ),
  );
  expect(res.status).toBe(200);
  const defWrite = db.__ops.find((o) => o.col === 'roleDefinitions');
  expect(defWrite?.data).toEqual(
    expect.objectContaining({ permissions: ['canManageTasks'], defaultTermDays: 90 }),
  );
  const permData = db.__ops.find((o) => o.col === 'permissions')?.data as Record<string, unknown>;
  expect(permData.canManageTasks).toBe(true);
  expect(permData.canManageUsers).toBe(false);
  expect(permData.canManagePermissions).toBe(false);
  expect(permData.canManageRoles).toBe(false);
});

it('T2: custom create without consent returns the 409 gate body and writes nothing', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  mockGate.mockRejectedValue(gateMissing(CUSTOM_SLUG, 'create'));
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', customCreateBody()),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CONSENT_REQUIRED');
  expect(json.matter).toBe('role_catalog');
  expect(db.__ops).toHaveLength(0);
  expect(mockAudit).not.toHaveBeenCalled();
});

it.each([['canManageRoles'], ['canManagePermissions']])(
  'T3: custom create with reserved key %s is rejected before the gate',
  async (key) => {
    const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
    mockDbHolder.db = db;
    const res = await POST(
      req(
        'http://localhost/api/admin/role-permissions',
        'POST',
        customCreateBody({ permissionKeys: ['canManageTasks', key] }),
      ),
    );
    await expectRejection(res, db, 'RESERVED_PERMISSION_FOR_CUSTOM_ROLE');
  },
);

it.each([['canManageRoles'], ['canManagePermissions']])(
  'T3: editor save of a custom role with reserved key %s is rejected before the gate',
  async (key) => {
    const db = dbWithCustomDef();
    mockDbHolder.db = db;
    const res = await POST(
      req(
        'http://localhost/api/admin/role-permissions',
        'POST',
        editorSaveBody({ permissionKeys: ['canManageUsers', key] }),
      ),
    );
    await expectRejection(res, db, 'RESERVED_PERMISSION_FOR_CUSTOM_ROLE');
  },
);

it.each([
  ['a legacy token', 'chair_events', 'CUSTOM_PARENT_INVALID'],
  ['another custom slug', 'custom_other', 'CUSTOM_PARENT_INVALID'],
  ['a junk slug', 'pakistan-president', 'CUSTOM_PARENT_INVALID'],
  ['an absent parentRoleKey', undefined, 'CUSTOM_FIELDS_REQUIRED'],
])('T4: custom create with %s as parent is rejected', async (_label, parent, code) => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ parentRoleKey: parent }),
    ),
  );
  await expectRejection(res, db, code as string);
});

it('T5: custom create without chapterId is rejected as missing fields', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ chapterId: undefined }),
    ),
  );
  await expectRejection(res, db, 'CUSTOM_FIELDS_REQUIRED');
});

it('T5: custom create for a missing chapter doc is rejected', async () => {
  const db = makeDb(null, { chapters: {} });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', customCreateBody()),
  );
  await expectRejection(res, db, 'CUSTOM_CHAPTER_INVALID');
});

it('T5: custom create for an inactive chapter is rejected', async () => {
  const db = makeDb(null, {
    chapters: { [CHAPTER_ID]: { name: 'SEDS IST Chapter', isActive: false } },
  });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', customCreateBody()),
  );
  await expectRejection(res, db, 'CUSTOM_CHAPTER_INVALID');
});

it.each([
  ['custom_'],
  ['custom_president_national'],
  ['custom_superadmin'],
  ['custom_admin'],
  ['custom_vice_president'],
  ['custom_chapter_design_chair'],
  ['custom_media-lead'],
  // Reserved stems (contracts ADDENDUM R6): the remainder resolves to
  // nothing known, but its FIRST token is founder / president /
  // superadmin, so the slug is refused on the stem alone.
  ['custom_founder_assistant'],
  ['custom_president_assistant'],
  ['custom_superadmin_assistant'],
])('T6: slug %s fails the custom slug grammar / anti-squat rules', async (role) => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', customCreateBody({ role })),
  );
  await expectRejection(res, db, 'CUSTOM_SLUG_INVALID');
});

it('T7: an unknown non-custom slug still gets the exact closure body with no code field', async () => {
  const db = makeDb(null);
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'media_lead',
      label: 'Media Lead',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
    }),
  );
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json).toEqual({
    error: 'Unknown role "media_lead". Roles are fixed by the Role Catalog.',
  });
  expect(json).not.toHaveProperty('code');
  expect(db.__ops).toHaveLength(0);
  expect(mockGate).not.toHaveBeenCalled();
});

it('T7: a legacy slug create (president) still flows through the gate exactly as on base', async () => {
  const db = makeDb(null);
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'president',
      label: 'President',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, role: 'president' });
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'role_definition', slug: 'president', action: 'create' },
    }),
  );
  const sets = db.__ops.filter((o) => o.op === 'set');
  expect(sets).toHaveLength(3);
  expect(sets.every((o) => o.id === 'president')).toBe(true);
});

it('T7: custom_president can never write a doc keyed president', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ role: 'custom_president' }),
    ),
  );
  // Anti-squat (contracts 1.1d + plan R2): the remainder "president"
  // resolves to a legacy token and is a reserved stem, so the create is
  // rejected outright; in no case may a write land on "president".
  await expectRejection(res, db, 'CUSTOM_SLUG_INVALID');
  expect(db.__ops.some((o) => o.id === 'president')).toBe(false);
});

it.each([
  ['National President', 'chapter_design_chair'],
  ['Founder and Patron-in-Chief', 'chapter_design_chair'],
  ['Chapter Design and Media Chair', 'chapter_events_chair'],
])(
  'T8: a custom create wearing the catalog title "%s" is rejected',
  async (label, parentRoleKey) => {
    const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
    mockDbHolder.db = db;
    const res = await POST(
      req(
        'http://localhost/api/admin/role-permissions',
        'POST',
        customCreateBody({ label, parentRoleKey }),
      ),
    );
    await expectRejection(res, db, 'CUSTOM_TITLE_RESERVED');
  },
);

it.each([
  ['a different parentRoleKey', { parentRoleKey: 'chapter_events_chair' }],
  ['a different chapterId', { chapterId: OTHER_CHAPTER_ID }],
  ['isCustom: false', { isCustom: false }],
])(
  'T9: an update carrying %s against a stored custom definition is rejected',
  async (_label, extra) => {
    const db = dbWithCustomDef();
    mockDbHolder.db = db;
    const res = await POST(
      req('http://localhost/api/admin/role-permissions', 'POST', editorSaveBody(extra)),
    );
    await expectRejection(res, db, 'CUSTOM_DEFINITION_INVALID');
  },
);

it('T9: an update omitting isCustom/parentRoleKey/chapterId proceeds through normal classification', async () => {
  const db = dbWithCustomDef();
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: CUSTOM_SLUG,
      label: 'Poster Team Lead',
      allowedPaths: [],
      canAccessAdmin: true,
      description: 'Updated description.',
    }),
  );
  // Description-only change: ungated, exactly like the catalog path.
  expect(res.status).toBe(200);
  expect(mockGate).not.toHaveBeenCalled();
  expect(db.__ops.filter((o) => o.op === 'set')).toHaveLength(3);
});

it('T10: a save against a hand-written custom_ doc without isCustom fails closed', async () => {
  const db = makeDb(null, {
    defs: {
      [CUSTOM_SLUG]: {
        name: 'Poster Team Lead',
        label: 'Poster Team Lead',
        permissions: [],
        scope: 'chapter',
        allowedPaths: [],
        canAccessAdmin: true,
      },
    },
    chapters: ACTIVE_CHAPTERS,
  });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      editorSaveBody({ permissionKeys: ['canManageTasks'] }),
    ),
  );
  await expectRejection(res, db, 'CUSTOM_DEFINITION_INVALID');
});

it('T11: a create naming another chapter in allowedChapters is rejected', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ allowedChapters: [OTHER_CHAPTER_ID] }),
    ),
  );
  await expectRejection(res, db, 'CUSTOM_CHAPTERS_WIDENED');
});

it('T11: a create with empty allowedChapters stores exactly [chapterId]', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ allowedChapters: [] }),
    ),
  );
  expect(res.status).toBe(200);
  const defWrite = db.__ops.find((o) => o.col === 'roleDefinitions');
  expect(defWrite?.data).toEqual(expect.objectContaining({ allowedChapters: [CHAPTER_ID] }));
  const permData = db.__ops.find((o) => o.col === 'permissions')?.data as Record<string, unknown>;
  expect(permData._allowedChapters).toEqual([CHAPTER_ID]);
});

it('T11: an update widening allowedChapters beyond [chapterId] is rejected', async () => {
  const db = dbWithCustomDef();
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      editorSaveBody({ allowedChapters: [CHAPTER_ID, OTHER_CHAPTER_ID] }),
    ),
  );
  await expectRejection(res, db, 'CUSTOM_CHAPTERS_WIDENED');
});

it('T12: scope and category sent by the client are forced on a custom create', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req(
      'http://localhost/api/admin/role-permissions',
      'POST',
      customCreateBody({ scope: 'global', category: 'B' }),
    ),
  );
  expect(res.status).toBe(200);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'role_definition', slug: CUSTOM_SLUG, action: 'create' },
    }),
  );
  const defWrite = db.__ops.find((o) => o.col === 'roleDefinitions');
  expect(defWrite?.data).toEqual(expect.objectContaining({ scope: 'chapter', category: 'Custom' }));
  const permData = db.__ops.find((o) => o.col === 'permissions')?.data as Record<string, unknown>;
  expect(permData._scope).toBe('chapter');
});

it('T13: a path-model-only body cannot mint a custom role', async () => {
  const db = makeDb(null, { chapters: ACTIVE_CHAPTERS });
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: CUSTOM_SLUG,
      label: 'Poster Team Lead',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
    }),
  );
  await expectRejection(res, db, 'CUSTOM_FIELDS_REQUIRED');
});

it('T13: a path-model treasurer create behaves exactly as on base', async () => {
  const db = makeDb(null);
  mockDbHolder.db = db;
  const res = await POST(
    req('http://localhost/api/admin/role-permissions', 'POST', {
      role: 'treasurer',
      label: 'Treasurer',
      allowedPaths: ['/admin'],
      canAccessAdmin: true,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect(db.__ops.filter((o) => o.op === 'set')).toHaveLength(3);
});

it('T14: DELETE of a custom slug flows through the gated delete', async () => {
  const db = dbWithCustomDef();
  mockDbHolder.db = db;
  const res = await DELETE(
    req('http://localhost/api/admin/role-permissions', 'DELETE', {
      role: CUSTOM_SLUG,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, deleted: CUSTOM_SLUG });
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'role_definition', slug: CUSTOM_SLUG, action: 'delete' },
    }),
  );
  const deletes = db.__ops.filter((o) => o.op === 'delete').map((o) => o.col);
  expect(deletes).toEqual(
    expect.arrayContaining(['roleDefinitions', 'role_permissions', 'permissions']),
  );
});

// ---------------------------------------------------------------------------
// T14b-T14d: DELETE holders fence (contracts ADDENDUM R5, adopted from
// G5's dissent over Section 3.1's silence; implementer commit fbdf3e5).
// While any roles/{uid} holds the slug - as primary role OR inside
// additionalRoles - DELETE refuses 409 CUSTOM_ROLE_IN_USE BEFORE the
// consent gate, so a refused delete never consumes a consent. These
// cases run against the roleHolders harness: the where() stub serves
// real grant docs, so the fence is genuinely exercised (the pre-fence
// harness returned zero docs and T14 alone could not catch a broken
// fence).
// ---------------------------------------------------------------------------

it('T14b: DELETE of a custom slug held as a primary role is refused before the gate', async () => {
  const db = dbWithCustomDef(VALID_CUSTOM_DEF, {
    roleHolders: [{ id: 'user-primary', role: CUSTOM_SLUG }],
  });
  mockDbHolder.db = db;
  const res = await DELETE(
    req('http://localhost/api/admin/role-permissions', 'DELETE', {
      role: CUSTOM_SLUG,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CUSTOM_ROLE_IN_USE');
  expect(json.holderCount).toBe(1);
  expect(json.error).toContain('Poster Team Lead');
  expect(db.__ops).toHaveLength(0);
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

it('T14c: DELETE of a custom slug held in additionalRoles is refused, holders counted once', async () => {
  const db = dbWithCustomDef(VALID_CUSTOM_DEF, {
    roleHolders: [
      { id: 'user-add-1', role: 'member', additionalRoles: [CUSTOM_SLUG] },
      { id: 'user-add-2', additionalRoles: ['custom_other_role', CUSTOM_SLUG] },
      // Matches BOTH fence queries; the fence's id set must count it once.
      { id: 'user-both', role: CUSTOM_SLUG, additionalRoles: [CUSTOM_SLUG] },
      // Holds a different custom role only: must not be counted.
      { id: 'user-none', role: 'member', additionalRoles: ['custom_other_role'] },
    ],
  });
  mockDbHolder.db = db;
  const res = await DELETE(
    req('http://localhost/api/admin/role-permissions', 'DELETE', {
      role: CUSTOM_SLUG,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(409);
  const json = await res.json();
  expect(json.code).toBe('CUSTOM_ROLE_IN_USE');
  expect(json.holderCount).toBe(3);
  expect(db.__ops).toHaveLength(0);
  expect(mockGate).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

it('T14d: DELETE proceeds when grant docs exist but none hold the slug (fence control)', async () => {
  const db = dbWithCustomDef(VALID_CUSTOM_DEF, {
    roleHolders: [
      { id: 'user-x', role: 'custom_other_role' },
      { id: 'user-y', role: 'member', additionalRoles: ['custom_other_role'] },
    ],
  });
  mockDbHolder.db = db;
  const res = await DELETE(
    req('http://localhost/api/admin/role-permissions', 'DELETE', {
      role: CUSTOM_SLUG,
      consentRequestId: 'cr-1',
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, deleted: CUSTOM_SLUG });
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'role_definition', slug: CUSTOM_SLUG, action: 'delete' },
    }),
  );
  const deletes = db.__ops.filter((o) => o.op === 'delete').map((o) => o.col);
  expect(deletes).toEqual(
    expect.arrayContaining(['roleDefinitions', 'role_permissions', 'permissions']),
  );
});
