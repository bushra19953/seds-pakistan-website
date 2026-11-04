/**
 * MSG40 — Authority grant removal, lib layer.
 *
 * Covers the pieces the Directory Authority surface needs but never had:
 * - getCustomGrants: the read of roles/{uid}.additionalRoles restricted
 *   to custom_ slugs, sanitised the way the public chart sanitises them
 *   (strings only, normalised, deduped).
 * - removeCustomRole with several grants held: the removed slug goes,
 *   the primary and every other grant stay in the write body.
 * - removeCustomRole and the expiry pair: removing the grant the pair
 *   points at clears it (otherwise the inspector header would keep
 *   showing an expiry for a grant nobody holds); removing any other
 *   grant leaves the pair untouched.
 *
 * Same mock seams as role-management-custom.test.ts: firebase/firestore
 * reads over an in-memory record map, firebase/auth for authedFetch,
 * global fetch captured. The functions are imported directly with
 * their real types, so this file is also covered by tsc.
 */

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, collectionName: string, id: string) => ({
    _path: `${collectionName}/${id}`,
  })),
  getDoc: jest.fn(),
  collection: jest.fn((_db: unknown, name: string) => ({ _collection: name })),
  query: jest.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: jest.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  getDocs: jest.fn(async () => ({ docs: [] })),
}));

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: async () => 'test-id-token' },
  }),
}));

import { getDoc } from 'firebase/firestore';
import { getCustomGrants, removeCustomRole } from '../role-management';

const TARGET = 'target-user-uid';
const ACTOR = 'admin-actor-uid';
const REASON = 'Founder-ordered deputy strip, November 2026 review';
const CHAPTER = 'seds-ist-chapter';
const FAKE_FS = {} as never;

let records: Record<string, Record<string, unknown> | undefined>;
let fetchMock: jest.Mock;

function snap(path: string) {
  const data = records[path];
  return {
    exists: () => data !== undefined,
    data: () => data,
  };
}

beforeEach(() => {
  records = {};
  (getDoc as jest.Mock).mockReset();
  (getDoc as jest.Mock).mockImplementation(async (ref: { _path: string }) => snap(ref._path));
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

function lastFetchBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('getCustomGrants (MSG40 read surface)', () => {
  it('is exported and returns only custom_ slugs, normalised and deduped', async () => {
    expect(typeof getCustomGrants).toBe('function');
    records[`roles/${TARGET}`] = {
      role: 'member',
      additionalRoles: [
        'custom_deputy_a',
        'chapter_events_chair',
        'CUSTOM_DEPUTY_B',
        'custom_deputy_a',
        42,
        null,
        '  custom_deputy_c  ',
      ],
      chapterId: CHAPTER,
    };
    const grants = await getCustomGrants(FAKE_FS, TARGET);
    expect(grants).toEqual(['custom_deputy_a', 'custom_deputy_b', 'custom_deputy_c']);
  });

  it('returns [] when the target has no roles doc', async () => {
    records[`users/${TARGET}`] = { displayName: 'Roleless User', chapterId: CHAPTER };
    const grants = await getCustomGrants(FAKE_FS, TARGET);
    expect(grants).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] when additionalRoles holds no custom slug', async () => {
    records[`roles/${TARGET}`] = {
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      chapterId: CHAPTER,
    };
    const grants = await getCustomGrants(FAKE_FS, TARGET);
    expect(grants).toEqual([]);
  });
});

describe('removeCustomRole with several grants held (base + others preserved)', () => {
  it('removes one of two custom grants and keeps the primary and the other grant', async () => {
    records[`roles/${TARGET}`] = {
      role: 'chapter_secretary',
      additionalRoles: ['custom_deputy_a', 'custom_deputy_b'],
      chapterId: CHAPTER,
    };
    const ok = await removeCustomRole(FAKE_FS, TARGET, 'custom_deputy_a', ACTOR, REASON);
    expect(ok).toBe(true);
    expect(lastFetchBody()).toEqual({
      action: 'assign',
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['custom_deputy_b'],
      chapterId: CHAPTER,
      reason: REASON,
      consentRequestId: null,
    });
  });

  it('removing the grant the expiry pair points at clears the pair', async () => {
    records[`roles/${TARGET}`] = {
      role: 'member',
      additionalRoles: ['custom_deputy_a', 'custom_deputy_b'],
      chapterId: CHAPTER,
      expiresAt: '2027-01-15T00:00:00.000Z',
      expiresRoleKey: 'custom_deputy_a',
    };
    const ok = await removeCustomRole(FAKE_FS, TARGET, 'custom_deputy_a', ACTOR, REASON);
    expect(ok).toBe(true);
    const body = lastFetchBody();
    expect(body.additionalRoles).toEqual(['custom_deputy_b']);
    expect(body.expiresAt).toBeNull();
    expect(body.expiresRoleKey).toBeNull();
  });

  it('removing any other grant leaves the expiry pair out of the body (preserved)', async () => {
    records[`roles/${TARGET}`] = {
      role: 'member',
      additionalRoles: ['custom_deputy_a', 'custom_deputy_b'],
      chapterId: CHAPTER,
      expiresAt: '2027-01-15T00:00:00.000Z',
      expiresRoleKey: 'custom_deputy_b',
    };
    const ok = await removeCustomRole(FAKE_FS, TARGET, 'custom_deputy_a', ACTOR, REASON);
    expect(ok).toBe(true);
    const body = lastFetchBody();
    expect(body.additionalRoles).toEqual(['custom_deputy_b']);
    expect(body).not.toHaveProperty('expiresAt');
    expect(body).not.toHaveProperty('expiresRoleKey');
  });
});
