/**
 * @jest-environment node
 */
// Approvals parity tests (Permission-Parity Fix Program, Family C):
// S-APPR-1 (GET 4-key OR), S-APPR-2 (POST CREATE_PERMISSIONS loop, dynamic
// per-targetType keys), S-APPR-3 (pages_donate AND override).
//
// Canonical holder fixture: primary role `member` (via the
// resolveCanonicalRole fallback) holding a custom role in additionalRoles
// whose definition carries ONLY the named gate key(s). The mock
// hasServerPermissionForUser mirrors the real resolver: primary answer OR
// unexpired custom grant; an expired grant contributes nothing.
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = {};
const rolePerms: Record<string, Set<string>> = {};
const customGrants: Record<string, { perms: Set<string>; expired: boolean }> = {
  // S-APPR-1: exactly ONE of the four queue-visibility keys.
  'holder-store-only': { perms: new Set(['canManageStore']), expired: false },
  // S-APPR-2: finance-only vs sponsors-only holders for two targetTypes.
  'holder-finance-only': { perms: new Set(['canManageFinance']), expired: false },
  'holder-sponsors-only': { perms: new Set(['canManageSponsorsPartners']), expired: false },
  // S-APPR-3: pages-only (denied by the AND) vs pages+finance (allowed).
  'holder-pages-only': { perms: new Set(['canManagePages']), expired: false },
  'holder-pages-finance': { perms: new Set(['canManagePages', 'canManageFinance']), expired: false },
  'expired-holder': { perms: new Set(['canManageFinance', 'canManageStore']), expired: true },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }),
    }),
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }),
    }),
  },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      (rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false) ||
      (!!customGrants[uid] && !customGrants[uid].expired && customGrants[uid].perms.has(perm)),
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import { GET, POST } from '../route';

function req(uid: string, body?: unknown, url = 'http://localhost/api/admin/finance/approvals') {
  return {
    method: 'POST',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

describe('approvals parity (S-APPR-1/2/3)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    db.__seed('finance_budgets', 'bud-1', { status: 'draft', fyLabel: 'fy2026-27', lines: [] });
    db.__seed('sponsors_partners', 'sp-1', { organizationName: 'Partner Co', status: 'Negotiation' });
  });

  describe('S-APPR-1: GET queue visibility is a 4-key OR — one key suffices', () => {
    it('holder with ONLY canManageStore (custom grant, primary member) can see the queue', async () => {
      const res = await GET(req('holder-store-only'));
      expect(res.status).toBe(200);
      expect((await res.json()).approvals).toEqual([]);
    });

    it('primary member with no grant is denied (403)', async () => {
      const res = await GET(req('plain-member'));
      expect(res.status).toBe(403);
    });

    it('expired custom grant falls back to the original denial (403)', async () => {
      const res = await GET(req('expired-holder'));
      expect(res.status).toBe(403);
    });
  });

  describe('S-APPR-2: POST loop converts inside the loop, key set follows targetType', () => {
    it('finance-only holder can create a budget_approve request (canManageFinance)', async () => {
      const res = await POST(req('holder-finance-only', {
        targetType: 'budget_approve', targetId: 'bud-1', changePayload: {},
      }));
      expect(res.status).toBe(201);
    });

    it('finance-only holder cannot create a crm_status_active request (needs canManageSponsorsPartners)', async () => {
      const res = await POST(req('holder-finance-only', {
        targetType: 'crm_status_active', targetId: 'sp-1', changePayload: {},
      }));
      expect(res.status).toBe(403);
    });

    it('sponsors-only holder can create a crm_status_active request', async () => {
      const res = await POST(req('holder-sponsors-only', {
        targetType: 'crm_status_active', targetId: 'sp-1', changePayload: {},
      }));
      expect(res.status).toBe(201);
    });

    it('sponsors-only holder cannot create a budget_approve request', async () => {
      const res = await POST(req('holder-sponsors-only', {
        targetType: 'budget_approve', targetId: 'bud-1', changePayload: {},
      }));
      expect(res.status).toBe(403);
    });
  });

  describe('S-APPR-3: pages_donate override is an AND, applied after the loop', () => {
    const pagesDonateBody = {
      targetType: 'destination_change',
      targetId: 'pages_donate',
      changePayload: { methods: [{ id: 'bank', name: 'Bank', instructions: 'New' }], order: ['bank'], testMode: false },
      reason: 'Correcting donation account instructions',
    };

    it('holder with canManagePages only is denied (loop passes, AND override denies)', async () => {
      const res = await POST(req('holder-pages-only', pagesDonateBody));
      expect(res.status).toBe(403);
    });

    it('holder with BOTH canManagePages and canManageFinance is allowed', async () => {
      const res = await POST(req('holder-pages-finance', pagesDonateBody));
      expect(res.status).toBe(201);
    });
  });
});
