/**
 * @jest-environment node
 *
 * POST /api/admin/hierarchy/user - shell-create role validation
 * (side-door item, plan section 3.3 / T-S, SEC-02). The stored role is
 * always the RESOLVED key, never the verbatim request value.
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(),
}));

jest.mock('@/config/permissions.config', () => ({
  hasPermissionForRole: jest.fn(),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(),
}));

jest.mock('@/lib/server/hierarchy', () => ({
  syncDirectRelationship: jest.fn().mockResolvedValue(undefined),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/hierarchy/user/route';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { syncDirectRelationship } from '@/lib/server/hierarchy';

const mockAuth = verifyAuthentication as jest.Mock;
const mockPerm = hasServerPermissionForUser as jest.Mock;
const mockSync = syncDirectRelationship as jest.Mock;

interface FakeState {
  emailExists?: boolean;
  definitions?: Record<string, Record<string, unknown>>;
}

function makeDb(state: FakeState) {
  const writes: Array<{ col: string; id: string; data: Record<string, unknown> }> = [];
  const db = {
    __writes: writes,
    collection: (name: string) => {
      if (name === 'users') {
        return {
          where: () => ({
            limit: () => ({
              get: async () => ({ empty: !state.emailExists, docs: [] }),
            }),
          }),
          doc: (id?: string) => {
            const refId = id ?? 'shell-new';
            return {
              id: refId,
              set: async (data: Record<string, unknown>) => {
                writes.push({ col: 'users', id: refId, data });
              },
            };
          },
        };
      }
      return {
        doc: (id: string) => ({
          get: async () => {
            const data = state.definitions?.[id];
            return { exists: data !== undefined, id, data: () => data };
          },
        }),
      };
    },
  };
  return db;
}

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/hierarchy/user', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function storedUser() {
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  return db.__writes.find((w) => w.col === 'users')?.data;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin' },
  });
  mockPerm.mockResolvedValue(true);
  mockDbHolder.db = makeDb({});
});

it('T-S1: no role in body stores member in both fields', async () => {
  const res = await POST(req({ email: 'new@example.com', displayName: 'New Person' }));
  expect(res.status).toBe(200);
  expect(storedUser()).toMatchObject({ role: 'member', displayRole: 'member' });
});

it('T-S2: a catalog key stores verbatim-canonical in both fields', async () => {
  const res = await POST(
    req({ email: 'a@example.com', role: 'chapter_design_chair', chapterId: 'seds-ist-chapter' }),
  );
  expect(res.status).toBe(200);
  expect(storedUser()).toMatchObject({
    role: 'chapter_design_chair',
    displayRole: 'chapter_design_chair',
  });
});

it('T-S3: a legacy token stores its CANONICAL key, never the sent token', async () => {
  const res = await POST(req({ email: 'b@example.com', role: 'chair_events' }));
  expect(res.status).toBe(200);
  expect(storedUser()).toMatchObject({
    role: 'chapter_events_chair',
    displayRole: 'chapter_events_chair',
  });
});

it('T-S4: an invented slug is a 400 with zero writes', async () => {
  const res = await POST(req({ email: 'c@example.com', role: 'media_lead' }));
  expect(res.status).toBe(400);
  expect(storedUser()).toBeUndefined();
});

it('T-S5: superadmin and the pakistan-president junk token are 400s with zero writes', async () => {
  const res1 = await POST(req({ email: 'd@example.com', role: 'superadmin' }));
  expect(res1.status).toBe(400);
  const res2 = await POST(req({ email: 'e@example.com', role: 'pakistan-president' }));
  expect(res2.status).toBe(400);
  expect(storedUser()).toBeUndefined();
});

it('T-S6 (contracts 3.3 OVERRIDES plan T-S6): a custom slug is NEVER stored on a shell, even with a real definition in the same chapter', async () => {
  mockDbHolder.db = makeDb({
    definitions: {
      custom_poster_team_lead: {
        isCustom: true,
        parentRoleKey: 'chapter_design_chair',
        chapterId: 'seds-ist-chapter',
      },
    },
  });
  const res = await POST(
    req({
      email: 'f@example.com',
      role: 'custom_poster_team_lead',
      chapterId: 'seds-ist-chapter',
    }),
  );
  // Contracts section 3.3: the shell users doc's role/displayRole must
  // be a catalog key or omitted - it may NEVER set a custom_ slug,
  // because a shell person has no grant record for the resolver or
  // the expiry sweep to honour. (The plan's T-S6 allowed the store
  // under a four-part definition test; contracts win, per the
  // program gate. The committed shell-create currently follows the
  // plan and stores it, so this case is red until the parent rules
  // or the route is conformed to contracts.)
  expect(res.status).toBe(400);
  expect(storedUser()).toBeUndefined();
});

it('T-S7: a custom slug whose definition is in a DIFFERENT chapter is a 400', async () => {
  mockDbHolder.db = makeDb({
    definitions: {
      custom_poster_team_lead: {
        isCustom: true,
        parentRoleKey: 'chapter_design_chair',
        chapterId: 'other-chapter',
      },
    },
  });
  const res = await POST(
    req({
      email: 'g@example.com',
      role: 'custom_poster_team_lead',
      chapterId: 'seds-ist-chapter',
    }),
  );
  expect(res.status).toBe(400);
  expect(storedUser()).toBeUndefined();
});

it('T-S8: a custom slug with no definition is a 400', async () => {
  const res = await POST(
    req({
      email: 'h@example.com',
      role: 'custom_poster_team_lead',
      chapterId: 'seds-ist-chapter',
    }),
  );
  expect(res.status).toBe(400);
  expect(storedUser()).toBeUndefined();
});

it('T-S9: a custom slug with a null chapter is a 400', async () => {
  mockDbHolder.db = makeDb({
    definitions: {
      custom_poster_team_lead: {
        isCustom: true,
        parentRoleKey: 'chapter_design_chair',
        chapterId: 'seds-ist-chapter',
      },
    },
  });
  const res = await POST(
    req({ email: 'i@example.com', role: 'custom_poster_team_lead', chapterId: null }),
  );
  expect(res.status).toBe(400);
  expect(storedUser()).toBeUndefined();
});

it('T-S10a: unauthenticated gets 401', async () => {
  mockAuth.mockResolvedValue({ authenticated: false });
  const res = await POST(req({ email: 'j@example.com' }));
  expect(res.status).toBe(401);
});

it('T-S10b: a caller without canManageUsers gets 403', async () => {
  mockPerm.mockResolvedValue(false);
  const res = await POST(req({ email: 'k@example.com' }));
  expect(res.status).toBe(403);
});

it('T-S10c: a duplicate email gets 409', async () => {
  mockDbHolder.db = makeDb({ emailExists: true });
  const res = await POST(req({ email: 'dupe@example.com' }));
  expect(res.status).toBe(409);
});

it('T-S10d: managerId still mirrors via syncDirectRelationship', async () => {
  const res = await POST(
    req({ email: 'l@example.com', role: 'member', managerId: 'mgr-1' }),
  );
  expect(res.status).toBe(200);
  expect(mockSync).toHaveBeenCalledWith('shell-new', 'mgr-1', 'admin-1');
});
