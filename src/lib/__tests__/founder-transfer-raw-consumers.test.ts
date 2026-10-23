/**
 * @jest-environment node
 *
 * Founder transfer, Family D — raw-stored-string consumers.
 *
 * Pins the founder-code-plan §4 fixes: consumers that compared a raw
 * stored role (or the canonical auth role) against a literal list
 * containing 'superadmin' — a value canonical resolution never
 * produces — now also recognise 'founder_patron'.
 *
 * Route-level tests: D1 (skills, both routes, delegating to
 * hasServerPermission). Pure tests: D9 (blog RBAC), D10 (announcement
 * officer set), D11 (governance ROLE_RANK). The remaining items
 * (D3–D8, D12) sit behind module-private helpers or heavy route
 * harnesses owned by other suites, so they are pinned at source level
 * here and behaviourally in their own suites (intake uncancel in
 * src/app/api/admin/intake-windows/__tests__/route.test.ts, profile
 * telemetry in src/app/api/profile/[userId]/telemetry/__tests__/route.test.ts,
 * submissions PATCH in src/app/api/submissions/__tests__/route.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// D1 — skills routes delegate to hasServerPermission
// ---------------------------------------------------------------------------

const mockVerifyIdToken = jest.fn();
const mockHasServerPermission = jest.fn();

const d1State = {
  storedRole: '' as string,
  collectionsRead: [] as string[],
};

const mockDb = {
  collection: jest.fn((name: string) => {
    d1State.collectionsRead.push(name);
    return {
      doc: jest.fn((id: string) => ({
        get: jest.fn(async () => {
          if (name === 'roles') {
            return d1State.storedRole
              ? { exists: true, data: () => ({ role: d1State.storedRole }) }
              : { exists: false, data: () => undefined };
          }
          return { exists: false, data: () => undefined };
        }),
        set: jest.fn(async () => undefined),
      })),
      add: jest.fn(async () => ({ id: 'skill-new' })),
      get: jest.fn(async () => ({ docs: [] })),
    };
  }),
  batch: jest.fn(() => ({
    set: jest.fn(),
    commit: jest.fn(async () => undefined),
  })),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  admin: {
    auth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
    firestore: {
      FieldValue: {
        arrayUnion: (...vals: unknown[]) => ({ __fv: 'arrayUnion', vals }),
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
      },
      FieldPath: { documentId: () => '__name__' },
    },
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: (...args: unknown[]) => mockHasServerPermission(...args),
}));

import { POST as skillsPOST } from '@/app/api/skills/route';
import { POST as assignBulkPOST } from '@/app/api/skills/assign-bulk/route';

function jsonReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('D1 skills canManage delegates to hasServerPermission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    d1State.storedRole = '';
    d1State.collectionsRead = [];
    mockDb.collection.mockClear();
    mockDb.batch.mockClear();
    mockVerifyIdToken.mockResolvedValue({ uid: 'caller-1' });
    // Stand-in for the merged Family A blanket: both founder tokens pass
    // with NO grant docs present; ordinary roles do not.
    mockHasServerPermission.mockImplementation(
      async (role: string, key: string) =>
        key === 'canManageSkills' && (role === 'founder_patron' || role === 'superadmin'),
    );
  });

  it('stored founder_patron with NO permissions/* docs at all is allowed (skills POST)', async () => {
    d1State.storedRole = 'founder_patron';
    const res = await skillsPOST(jsonReq('http://localhost/api/skills', { name: 'Welding' }));
    expect(res.status).toBe(200);
    expect(mockHasServerPermission).toHaveBeenCalledWith('founder_patron', 'canManageSkills');
    // The old exact-id read of permissions/{role} is gone.
    expect(d1State.collectionsRead).not.toContain('permissions');
  });

  it('stored superadmin with no docs is allowed (pre-flip pin)', async () => {
    d1State.storedRole = 'superadmin';
    const res = await skillsPOST(jsonReq('http://localhost/api/skills', { name: 'Welding' }));
    expect(res.status).toBe(200);
    expect(mockHasServerPermission).toHaveBeenCalledWith('superadmin', 'canManageSkills');
  });

  it('stored member is denied 403', async () => {
    d1State.storedRole = 'member';
    const res = await skillsPOST(jsonReq('http://localhost/api/skills', { name: 'Welding' }));
    expect(res.status).toBe(403);
  });

  it('assign-bulk: stored founder_patron is allowed, member denied', async () => {
    d1State.storedRole = 'founder_patron';
    const ok = await assignBulkPOST(
      jsonReq('http://localhost/api/skills/assign-bulk', { skillId: 's1', userIds: ['u1'] }),
    );
    expect(ok.status).toBe(200);
    expect(mockHasServerPermission).toHaveBeenCalledWith('founder_patron', 'canManageSkills');
    expect(d1State.collectionsRead).not.toContain('permissions');

    d1State.storedRole = 'member';
    const denied = await assignBulkPOST(
      jsonReq('http://localhost/api/skills/assign-bulk', { skillId: 's1', userIds: ['u1'] }),
    );
    expect(denied.status).toBe(403);
  });

  it('claim shortcut still short-circuits before any role read', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'caller-1', manageSkills: true });
    d1State.storedRole = 'member';
    const res = await skillsPOST(jsonReq('http://localhost/api/skills', { name: 'Welding' }));
    expect(res.status).toBe(200);
    expect(mockHasServerPermission).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D9 — blog RBAC (pure)
// ---------------------------------------------------------------------------

import { getBlogPermissions, BLOG_ROLE_PERMISSIONS } from '@/lib/blog-rbac';

describe('D9 blog-rbac founder_patron', () => {
  it('founder_patron resolves to blog_administrator permissions', () => {
    expect(getBlogPermissions('founder_patron')).toEqual(
      BLOG_ROLE_PERMISSIONS.blog_administrator,
    );
  });

  it('superadmin unchanged; member unchanged', () => {
    expect(getBlogPermissions('superadmin')).toEqual(
      BLOG_ROLE_PERMISSIONS.blog_administrator,
    );
    expect(getBlogPermissions('member')).toEqual(BLOG_ROLE_PERMISSIONS.blog_contributor);
  });
});

// ---------------------------------------------------------------------------
// D10 — announcements officer set (pure)
// ---------------------------------------------------------------------------

import { viewerIsOfficer } from '@/lib/announcements';

describe('D10 announcements officer tokens', () => {
  it('non-founder viewer with role founder_patron is an officer', () => {
    expect(
      viewerIsOfficer({ signedIn: true, uid: 'non-founder-uid', role: 'founder_patron' }),
    ).toBe(true);
  });

  it('superadmin regression; member is not an officer', () => {
    expect(
      viewerIsOfficer({ signedIn: true, uid: 'non-founder-uid', role: 'superadmin' }),
    ).toBe(true);
    expect(
      viewerIsOfficer({ signedIn: true, uid: 'non-founder-uid', role: 'member' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D11 — governance ROLE_RANK (pure)
// ---------------------------------------------------------------------------

import { getRoleRank } from '@/lib/governance/access';

describe('D11 governance role rank', () => {
  it('founder_patron ranks 4, same as superadmin (not 0/guest)', () => {
    expect(getRoleRank('founder_patron')).toBe(4);
    expect(getRoleRank('superadmin')).toBe(4);
    expect(getRoleRank('guest')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Source pins for the remaining D items (module-private helpers / heavy
// route harnesses; behavioural coverage lives in their own suites)
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..', '..');
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('Family D source pins', () => {
  it('D3 profit-settlement: both signoff predicates accept founder_patron', () => {
    const src = readSrc('app/api/admin/events/profit-settlement/route.ts');
    expect(src).toContain(
      'role === "president_national" || role === "superadmin" || role === "founder_patron"',
    );
    expect(src).toContain(
      'role === "treasurer" || role === "finance" || role === "superadmin" || role === "founder_patron"',
    );
  });

  it('D4 submissions: both isAdmin lists and the notification query include founder_patron', () => {
    const src = readSrc('app/api/submissions/route.ts');
    const lists = src.match(
      /\['superadmin', 'founder_patron', 'chapter_president', 'national_vp_operations'\]/g,
    );
    expect(lists).toHaveLength(2);
    expect(src).toContain("['admin', 'superadmin', 'president', 'founder_patron']");
  });

  it('D5 workflows: contact unmasking checks founder_patron first', () => {
    const src = readSrc('app/api/workflows/route.ts');
    expect(src).toContain(
      "const isAdmin = userRole === 'founder_patron' || userRole === 'superadmin'",
    );
  });

  it('D6 profile routes: all three ADMIN_ROLE_TOKENS sets include founder_patron', () => {
    for (const rel of [
      'app/api/profile/[userId]/telemetry/route.ts',
      'app/api/profile/[userId]/credential-pdf/route.ts',
      'app/api/profile/[userId]/credential-qr/route.ts',
    ]) {
      expect(readSrc(rel)).toContain(
        "new Set(['superadmin', 'president_national', 'founder_patron'])",
      );
    }
  });

  it('D7 admin/users: both identity-alias filters include founder_patron', () => {
    const src = readSrc('app/api/admin/users/route.ts');
    const matches = src.match(
      /role === 'president_national' \|\| role === 'superadmin' \|\| role === 'founder_patron'/g,
    );
    expect(matches).toHaveLength(2);
  });

  it('D2 intake uncancel: gate is founder_patron canonical or Founder UID, error body unchanged', () => {
    const src = readSrc('app/api/admin/intake-windows/[windowId]/route.ts');
    expect(src).toContain("role !== 'founder_patron' && !isFounderUid(uid)");
    expect(src).toContain("error: 'superadmin_required'");
  });

  it('D8 compliance obligations: gate also accepts a stored founder_patron role', () => {
    const src = readSrc('app/api/admin/compliance/obligations/route.ts');
    expect(src).toContain("userHoldsRole(uid, 'superadmin')");
    expect(src).toContain("userHoldsRole(uid, 'founder_patron')");
  });

  it('D12 positions: validRoles includes founder_patron, unknown roles still rejected by the set', () => {
    const src = readSrc('app/api/positions/route.ts');
    expect(src).toContain("'superadmin', 'founder_patron', 'president_national'");
    expect(src).toContain('if (!validRoles.has(updatesToApply.role))');
  });

  it('EXTRA (rederive-api §2.2) hierarchy shell-create refuses founder_patron outright', () => {
    const src = readSrc('app/api/admin/hierarchy/user/route.ts');
    expect(src).toContain("requested === 'founder_patron'");
    expect(src).toContain("requested === 'superadmin'");
  });

  it('EXTRA (rederive-server A5) reconciliation founder predicate includes the founder_patron store token', () => {
    const src = readSrc('lib/server/role-reconciliation.ts');
    expect(src).toContain("rolesDoc.role === 'founder_patron'");
    expect(src).toContain("userDoc.role === 'founder_patron'");
  });
});

// ---------------------------------------------------------------------------
// EXTRA (rederive-server A9) — roles.ts helpers with no UID bypass:
// 'superadmin' passed hasRecruitmentAccess via its CTO resolution while
// 'founder_patron' resolved to itself and failed; isSuperAdmin likewise
// only recognised the CTO key for a role-only caller.
// ---------------------------------------------------------------------------

import { hasRecruitmentAccess, isSuperAdmin } from '@/lib/roles';

describe('EXTRA A9 roles.ts founder_patron helpers', () => {
  it('hasRecruitmentAccess accepts founder_patron (and legacy superadmin via CTO)', () => {
    expect(hasRecruitmentAccess('founder_patron')).toBe(true);
    expect(hasRecruitmentAccess('superadmin')).toBe(true);
    expect(hasRecruitmentAccess('member')).toBe(false);
  });

  it('isSuperAdmin recognises the founder_patron key for a non-founder-uid caller', () => {
    expect(isSuperAdmin('founder_patron', 'some-other-uid')).toBe(true);
    expect(isSuperAdmin('member', 'some-other-uid')).toBe(false);
  });
});
