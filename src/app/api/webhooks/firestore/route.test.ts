/**
 * @jest-environment node
 *
 * Heap-guard tests for src/app/api/webhooks/firestore/route.ts
 * (fix/heap-root-hunt): badge definitions were read whole on every user
 * points-increase event. They are now cached 5 minutes with a
 * single-flight guard. These tests drive the POST webhook: two events
 * must share one badges read, and two concurrent events on a cold cache
 * must also share one read. Each test re-imports the route module so it
 * starts with a cold cache.
 */
const mockBadgesGet = jest.fn();
const mockUserUpdate = jest.fn();
const mockCacheSet = jest.fn();

const mockDb: any = {
  collection: () => ({
    get: mockBadgesGet,
    doc: () => ({
      update: mockUserUpdate,
      set: mockCacheSet,
      get: async () => ({ exists: false, data: () => undefined }),
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {},
}));
jest.mock('@/lib/server/webhooks/supa-handle', () => ({
  getWebhooksDb: () => mockDb,
}));
jest.mock('@/lib/server/supa-identity-primary', () => ({
  flushPendingUsersPrimaryOps: jest.fn(),
  identityPrimaryFlagOn: async () => false,
  primaryIdentitySet: jest.fn(),
  primaryIdentityUpdateIfExists: jest.fn(),
}));
jest.mock('@/lib/server/notifications-supa-seam', () => ({
  mirrorNotificationCreate: jest.fn(),
  userNotificationsPath: jest.fn(),
}));
jest.mock('@/lib/supa/flags', () => ({
  isSupaPrimary: () => false,
}));
jest.mock('@/lib/supa/gamification', () => ({
  applyPointsAwardViaSupa: jest.fn(),
}));

function badgeDoc(slug: string, pointsRequired: number, isActive: boolean) {
  return { id: slug, data: () => ({ slug, pointsRequired, isActive }) };
}

function userEvent(userId: string, beforePoints: number, afterPoints: number) {
  return new Request('http://localhost/api/webhooks/firestore', {
    method: 'POST',
    headers: {
      'x-webhook-secret': 'test-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      collection: 'users',
      docId: userId,
      eventType: 'update',
      before: { points: beforePoints, badges: [], chapterId: 'ch1', displayName: 'A' },
      after: { points: afterPoints, badges: [], chapterId: 'ch1', displayName: 'A' },
    }),
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.FIRESTORE_WEBHOOK_SECRET = 'test-secret';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  mockBadgesGet.mockResolvedValue({
    docs: [
      badgeDoc('bronze', 10, true),
      badgeDoc('silver', 100, true),
      badgeDoc('inactive', 1, false),
    ],
  });
  mockUserUpdate.mockResolvedValue(undefined);
  mockCacheSet.mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('webhooks badge definitions cache', () => {
  it('shares one badges read across two sequential events', async () => {
    const { POST } = require('./route');
    const r1 = await POST(userEvent('u1', 0, 50));
    expect((await r1.json()).success).toBe(true);
    const r2 = await POST(userEvent('u2', 0, 50));
    expect((await r2.json()).success).toBe(true);
    // One badges read served both events; each user still got the award write.
    expect(mockBadgesGet).toHaveBeenCalledTimes(1);
    expect(mockUserUpdate).toHaveBeenCalledTimes(2);
  });

  it('shares one badges read across two concurrent events on a cold cache', async () => {
    const { POST } = require('./route');
    const [r1, r2] = await Promise.all([
      POST(userEvent('u1', 0, 50)),
      POST(userEvent('u2', 0, 50)),
    ]);
    expect((await r1.json()).success).toBe(true);
    expect((await r2.json()).success).toBe(true);
    expect(mockBadgesGet).toHaveBeenCalledTimes(1);
    expect(mockUserUpdate).toHaveBeenCalledTimes(2);
  });
});
