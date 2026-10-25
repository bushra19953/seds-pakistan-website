/**
 * @jest-environment node
 *
 * SPEC-FAIL suite — SUPABASE MIGRATION, ROLES+PERMISSIONS cluster.
 *
 * Every test in this file is EXPECTED TO FAIL on the current base tree
 * (feat/integration-wave3 @ 4d5a1e16). They pin INTENDED behavior from the
 * founder access map (~/workspace/permissions_audit/FOUNDER_ACCESS_MAP_
 * 2026-10-25.md), not current behavior:
 *
 * - FD-15 (slice 7, D-F1..F3): four role-admin methods have NO isFounderUid
 *   arm — POST + DELETE /api/admin/role-permissions, POST
 *   /api/admin/roles/assign, POST /api/admin/sync-user-role. The founder
 *   passes today only because his primary resolves to the founder_patron
 *   blanket string. Root power is a UID (src/config/founder.ts), so a
 *   founder session whose role string is anything else (here: 'member',
 *   for which the mocked permission check denies) must STILL pass these
 *   gates. Siblings roles/write and roles/[slug] already carry the UID
 *   arm and are the model.
 * - FD-19 (slice 6 F-2 / slice 19 F-5): assertChapterAccess decides global
 *   status from the users-mirror string alone, ignoring the roles doc and
 *   additionalRoles. A founder_patron primary in roles/{uid} with a stale
 *   'member' mirror must be treated as global.
 *
 * These are labeled SPEC-FAIL, not regressions: the green contract suites
 * (supa-roles-routes-contracts, supa-roles-resolution-core) pin today's
 * behavior for non-founder actors, and nothing here contradicts them.
 * When the FD-15/FD-19 fixes land, this file flips green and should be
 * merged into the main contract suites.
 *
 * ZERO live reads: Firestore and the permission/consent/audit layers are
 * mocked exactly as in the green routes suite; hasServerPermission is
 * mocked to DENY so only a UID arm can let the founder through.
 */

jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    assertConsentFor: jest.fn(),
    isCategoryBRole: jest.fn(),
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
jest.mock('@/lib/auth-middleware', () => ({ verifyAuthentication: jest.fn() }));
jest.mock('@/lib/server/permissions', () => {
  const actual = jest.requireActual('@/lib/server/permissions');
  return {
    ...actual,
    hasServerPermission: jest.fn().mockResolvedValue(false),
    hasServerPermissionForUser: jest.fn().mockResolvedValue(false),
  };
});
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
    assignRole: jest.fn().mockResolvedValue({
      newEffectiveRole: 'member',
      alreadyApplied: false,
      roleDoc: { expiresAt: null },
    }),
    removeRole: jest.fn().mockResolvedValue({ previousEffectiveRole: 'member', alreadyApplied: false }),
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
import {
  POST as rpPOST,
  DELETE as rpDELETE,
} from '@/app/api/admin/role-permissions/route';
import { POST as syncPOST } from '@/app/api/admin/sync-user-role/route';
import { POST as assignPOST } from '@/app/api/admin/roles/assign/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor, isCategoryBRole } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { assertChapterAccess } from '@/lib/server/permissions';
import { resetIdentityCache } from '@/lib/server/identity-cache';
import { FOUNDER_UID } from '@/config/founder';

const mockAuth = verifyAuthentication as jest.Mock;

// Store fake (same shape as the green routes suite).
type DocData = Record<string, unknown>;
class StoreDb {
  store = new Map<string, Map<string, DocData>>();
  seed(col: string, id: string, data: DocData) {
    if (!this.store.has(col)) this.store.set(col, new Map());
    this.store.get(col)!.set(id, { ...data });
  }
  read(col: string, id: string): DocData | undefined {
    const d = this.store.get(col)?.get(id);
    return d ? { ...d } : undefined;
  }
  collection(name: string) {
    const self = this;
    const snapOf = (entries: Array<[string, DocData]>) => {
      const docs = entries.map(([id, data]) => ({ id, data: () => ({ ...data }) }));
      return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb) };
    };
    const makeQuery = (filters: Array<[string, string, unknown]>) => ({
      where: (f: string, op: string, v: unknown) => makeQuery([...filters, [f, op, v]]),
      get: async () => {
        let entries = [...(self.store.get(name)?.entries() ?? [])] as Array<[string, DocData]>;
        for (const [f, op, v] of filters) {
          entries = entries.filter(([, d]) =>
            op === 'array-contains' ? Array.isArray(d[f]) && (d[f] as unknown[]).includes(v) : d[f] === v,
          );
        }
        return snapOf(entries);
      },
    });
    return {
      doc: (id: string) => ({
        id,
        get: async () => {
          const data = self.store.get(name)?.get(id);
          return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
        },
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          const prev = opts?.merge ? self.read(name, id) ?? {} : {};
          self.seed(name, id, { ...prev, ...data });
        },
        delete: async () => {
          self.store.get(name)?.delete(id);
        },
      }),
      where: (f: string, op: string, v: unknown) => makeQuery([[f, op, v]]),
      get: async () => snapOf([...(self.store.get(name)?.entries() ?? [])] as Array<[string, DocData]>),
    };
  }
  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> }, data: DocData, opts?: { merge?: boolean }) => {
        ops.push(() => ref.set(data, opts));
      },
      delete: (ref: { delete: () => Promise<void> }) => {
        ops.push(() => ref.delete());
      },
      commit: async () => {
        for (const op of ops) await op();
      },
    };
  }
}

let fake: StoreDb;
function req(url: string, method: string, body: Record<string, unknown>) {
  return new NextRequest(url, { method, body: JSON.stringify(body) });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetIdentityCache();
  fake = new StoreDb();
  mockDbHolder.db = fake;
  // The founder's session, but with a role string that carries NO blanket
  // and NO permission grants: only a UID arm can authorize him.
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: FOUNDER_UID, role: 'member', displayName: 'Founder' },
  });
  (assertConsentFor as jest.Mock).mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  (isCategoryBRole as jest.Mock).mockResolvedValue(false);
  (writeGovernanceAuditOrThrow as jest.Mock).mockResolvedValue('audit-1');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('SPEC-FAIL FD-15: founder UID arm on the four un-armed role-admin methods', () => {
  it('POST /api/admin/role-permissions: founder UID passes even when the role string denies', async () => {
    const res = await rpPOST(
      req('http://localhost/api/admin/role-permissions', 'POST', {
        role: 'treasurer',
        label: 'Media Lead',
        allowedPaths: ['/admin'],
        canAccessAdmin: true,
        consentRequestId: 'cr-1',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, role: 'treasurer' });
  });

  it('DELETE /api/admin/role-permissions: founder UID passes even when the role string denies', async () => {
    fake.seed('roleDefinitions', 'president', { name: 'President (legacy)' });
    const res = await rpDELETE(
      req('http://localhost/api/admin/role-permissions', 'DELETE', { role: 'president', consentRequestId: 'cr-1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: 'president' });
  });

  it('POST /api/admin/roles/assign: founder UID passes even when the role string denies', async () => {
    fake.seed('users', 'u9', { displayName: 'Target' });
    const res = await assignPOST(
      req('http://localhost/api/admin/roles/assign', 'POST', {
        targetUid: 'u9',
        role: 'member',
        reason: 'a justification that is long enough',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'member' });
  });

  it('POST /api/admin/sync-user-role: founder UID passes even when the role string denies', async () => {
    const res = await syncPOST(
      req('http://localhost/api/admin/sync-user-role', 'POST', { uid: 'u9', customTitle: 'Space Cadet' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uid: 'u9' });
  });
});

describe('SPEC-FAIL FD-19: assertChapterAccess must see the roles doc, not only the users mirror', () => {
  it('a founder_patron primary in roles/{uid} is global even with a stale member mirror in another chapter', async () => {
    fake.seed('roles', FOUNDER_UID, { role: 'founder_patron', chapterId: 'seds-ist-chapter' });
    fake.seed('users', FOUNDER_UID, { role: 'member', chapterId: 'seds-ist-chapter' });
    fake.seed('roles', 'target-1', { role: 'member', chapterId: 'other-chapter' });
    fake.seed('users', 'target-1', { role: 'member', chapterId: 'other-chapter' });
    const res = await assertChapterAccess(fake as never, FOUNDER_UID, 'target-1');
    expect(res.allowed).toBe(true);
  });
});
