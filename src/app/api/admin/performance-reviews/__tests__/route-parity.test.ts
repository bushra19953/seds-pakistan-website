/**
 * @jest-environment node
 *
 * D9/D10 parity (Permission-Parity Fix Program, Family D): the write
 * gate of both performance-reviews routes is the holder-scoped
 * canManageUsers check. A caller whose PRIMARY role is plain `member`
 * (the old primary-only check denies) is admitted when the
 * holder-scoped check answers true via a custom grant
 * (additionalRoles: ['custom_verify_design_aide'], definition
 * permissions: ['canManageUsers'] — modelled at the permissions
 * boundary). Denial keeps the original 403 body byte-identical.
 *
 * The READ gate is a different arm by design: entitled offices via
 * resolveActorOffices (custom roles carry no office). That arm is
 * pinned unchanged here: the same grant holder with no office is
 * still refused on GET.
 */

const mockVerify = jest.fn();
const mockForUser = jest.fn();
const mockPrimary = jest.fn();
const mockOffices = jest.fn();
const mockDb = {
  collection: (_name: string) => ({
    doc: (_id: string) => ({
      get: async () => ({ exists: true, data: () => ({ chapterId: 'ch-1' }) }),
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  ensureAdminInitialized: () => true,
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: unknown[]) => mockVerify(...args),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: (...args: unknown[]) => mockPrimary(...args),
  hasServerPermissionForUser: (...args: unknown[]) => mockForUser(...args),
}));
jest.mock('@/lib/server/discipline/adapters', () => ({
  isFounderUid: (uid: string) => uid === 'founder-uid',
  resolveActorOffices: (...args: unknown[]) => mockOffices(...args),
}));
jest.mock('@/lib/server/discipline/settings', () => ({
  getDisciplineSettings: async () => ({ warningRegistryVariant: 'internal' }),
}));
jest.mock('@/lib/server/compliance/report-aggregator', () => ({
  quarterKeyOf: () => 'FY27-Q1',
}));
jest.mock('@/lib/server/reviews/generator', () => ({
  applyReviewUpdate: jest.fn(async () => ({
    ok: true,
    review: { subjectUid: 'member-1', term: 'FY27-Q1', messages: 'Solid quarter' },
  })),
  generatePerformanceReview: jest.fn(async () => ({
    subjectUid: 'member-1',
    term: 'FY27-Q1',
  })),
  getPerformanceReview: jest.fn(async () => null),
  isValidReviewTermKey: (k: string) => /^FY\d{2}-Q[1-4]$/.test(k),
  listPerformanceReviews: jest.fn(async () => []),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from '../route';
import { PATCH } from '../[reviewId]/route';

const HOLDER = 'holder-uid';

function jsonReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockVerify.mockReset().mockResolvedValue({
    authenticated: true,
    // Real AuthContext shape: userId, NOT uid.
    user: {
      user: { uid: HOLDER },
      userId: HOLDER,
      email: 'holder@example.com',
      displayName: 'Holder',
      emailVerified: true,
      role: 'member',
    },
  });
  // Primary-only answer for plain `member`: denied.
  mockPrimary.mockReset().mockResolvedValue(false);
  // Holder-scoped answer via the custom grant: admitted.
  mockForUser.mockReset().mockResolvedValue(true);
  mockOffices.mockReset().mockResolvedValue({
    uid: HOLDER,
    offices: [],
    chapterId: null,
  });
});

describe('D9 — POST /api/admin/performance-reviews', () => {
  it('admits a custom canManageUsers grant holder whose primary is member', async () => {
    const res = await POST(
      jsonReq('http://localhost/api/admin/performance-reviews', 'POST', {
        subjectUid: 'member-1',
        term: 'FY27-Q1',
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockForUser).toHaveBeenCalledWith(
      expect.anything(),
      HOLDER,
      'canManageUsers',
    );
  });

  it('denies unchanged (original 403 body) when the holder-scoped check denies', async () => {
    mockForUser.mockResolvedValue(false);
    const res = await POST(
      jsonReq('http://localhost/api/admin/performance-reviews', 'POST', {
        subjectUid: 'member-1',
        term: 'FY27-Q1',
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to manage performance reviews',
    });
  });
});

describe('D10 — PATCH /api/admin/performance-reviews/[reviewId]', () => {
  it('admits a custom canManageUsers grant holder whose primary is member', async () => {
    const res = await PATCH(
      jsonReq(
        'http://localhost/api/admin/performance-reviews/member-1_FY27-Q1',
        'PATCH',
        { messages: 'Solid quarter' },
      ),
      { params: { reviewId: 'member-1_FY27-Q1' } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockForUser).toHaveBeenCalledWith(
      expect.anything(),
      HOLDER,
      'canManageUsers',
    );
  });

  it('denies unchanged (original 403 body) when the holder-scoped check denies', async () => {
    mockForUser.mockResolvedValue(false);
    const res = await PATCH(
      jsonReq(
        'http://localhost/api/admin/performance-reviews/member-1_FY27-Q1',
        'PATCH',
        { messages: 'Solid quarter' },
      ),
      { params: { reviewId: 'member-1_FY27-Q1' } },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden: Insufficient permissions to manage performance reviews',
    });
  });
});

describe('office arm unchanged (by design)', () => {
  it('GET still refuses the grant holder who holds no entitled office', async () => {
    const res = await GET(
      jsonReq('http://localhost/api/admin/performance-reviews', 'GET'),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });
});
