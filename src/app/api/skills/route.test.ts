/**
 * @jest-environment node
 *
 * Heap-guard tests for src/app/api/skills/route.ts (fix/heap-root-hunt):
 * the per-skill holder/grant fan-out (2 reads per skill) ran on every
 * admin skills load. Counts for the same skill set are now coalesced
 * (single-flight) and reused for 60s. These tests drive the Firestore
 * path (seam forced off) and count only the users/events reads, not the
 * skills list read itself. Each test re-imports the route module so it
 * starts with a cold cache.
 */
import { NextRequest } from 'next/server';

const mockSkillsGet = jest.fn();
const mockUsersGet = jest.fn();
const mockEventsGet = jest.fn();

function doc(id: string, data: any) {
  return { id, data: () => data };
}

const mockDb: any = {
  collection: (name: string) => {
    if (name === 'skills') {
      return {
        where: () => ({ get: mockSkillsGet }),
        get: mockSkillsGet,
      };
    }
    if (name === 'users') return { where: () => ({ get: mockUsersGet }) };
    if (name === 'events') return { where: () => ({ get: mockEventsGet }) };
    return { where: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }) };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => {},
  getDb: () => mockDb,
  admin: {
    auth: () => ({
      verifyIdToken: async () => ({ uid: 'admin-1', manageSkills: true }),
    }),
    firestore: { FieldPath: { documentId: () => '__name__' } },
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: async () => true,
}));
jest.mock('@/lib/server/skills-supa', () => ({
  mirrorSkillCreate: jest.fn(),
  mirrorSkillDelete: jest.fn(),
  mirrorSkillUpdate: jest.fn(),
  mirrorUserSkillRevoke: jest.fn(),
  supaListSkillsAdmin: async () => null,
  supaSkillGrantCounts: jest.fn(),
}));
jest.mock('@/lib/server/supa-identity-primary', () => ({
  flushPendingUsersPrimaryOps: jest.fn(),
  identityPrimaryFlagOn: async () => false,
}));

function skillsRequest() {
  return new NextRequest('http://localhost/api/skills', {
    headers: { authorization: 'Bearer test-token' },
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSkillsGet.mockResolvedValue({
    docs: [
      doc('s1', { name: 'Skill One', slug: 'skill-one' }),
      doc('s2', { name: 'Skill Two', slug: 'skill-two' }),
    ],
  });
  mockUsersGet.mockResolvedValue({ docs: [doc('u1', {}), doc('u2', {})] });
  mockEventsGet.mockResolvedValue({ docs: [doc('e1', {})] });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('skills counts single-flight + cache', () => {
  it('serves the second sequential load from cache', async () => {
    const { GET } = require('./route');
    const r1 = await GET(skillsRequest());
    const b1 = await r1.json();
    expect(b1.items).toHaveLength(2);
    expect(b1.items[0].assignedUserCount).toBe(2);
    expect(b1.items[0].linkedEventCount).toBe(1);
    expect(mockUsersGet).toHaveBeenCalledTimes(2);
    expect(mockEventsGet).toHaveBeenCalledTimes(2);

    await GET(skillsRequest());
    expect(mockUsersGet).toHaveBeenCalledTimes(2);
    expect(mockEventsGet).toHaveBeenCalledTimes(2);
  });

  it('coalesces two concurrent loads on a cold cache', async () => {
    const { GET } = require('./route');
    const [r1, r2] = await Promise.all([GET(skillsRequest()), GET(skillsRequest())]);
    expect((await r1.json()).items).toHaveLength(2);
    expect((await r2.json()).items).toHaveLength(2);
    expect(mockUsersGet).toHaveBeenCalledTimes(2);
    expect(mockEventsGet).toHaveBeenCalledTimes(2);
  });
});
