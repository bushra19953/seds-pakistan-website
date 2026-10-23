/**
 * ASSIGN-PATH (Custom Roles Fix Program) - client adapter tests for
 * src/lib/role-management.ts (plan section 9, client suite 1).
 *
 * Covers: the custom_ delegation branch (assignRole -> assignCustomRole),
 * the member_basic bootstrap for a roleless target, the already-held
 * no-op, the non-prefixed unknown refusal, removeCustomRole, and the
 * C6 preserveAdditionalRoles opt on catalog picks (with the no-opt body
 * pinned byte-for-byte to today's shape).
 *
 * firebase/firestore reads are mocked over an in-memory record map;
 * firebase/auth is mocked for authedFetch; global fetch is captured.
 * New-surface functions (assignCustomRole / removeCustomRole) are
 * reached through a loose facade so the suite compiles before they
 * exist and runs unchanged after.
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
import { assignRole } from '../role-management';
import * as roleManagement from '../role-management';

const TARGET = 'target-user-uid';
const ACTOR = 'admin-actor-uid';
const REASON = 'Appointed by the National President, October 2026 intake';
const CHAPTER = 'seds-ist-chapter';
const CUSTOM = 'custom_poster_team_lead';
const FAKE_FS = {} as never;

type AnyFn = (...args: never[]) => Promise<boolean>;
const assignCustomRole = (roleManagement as unknown as Record<string, AnyFn>).assignCustomRole;
const removeCustomRole = (roleManagement as unknown as Record<string, AnyFn>).removeCustomRole;

/** In-memory roles/users records keyed by "collection/id". */
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

function fetchUrl(): string {
  return fetchMock.mock.calls[0][0] as string;
}

describe('assignRole with a custom_ slug (delegation to assignCustomRole)', () => {
  it('POSTs the current catalog primary plus the slug appended to current additionalRoles, with chapterId', async () => {
    records[`roles/${TARGET}`] = {
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      chapterId: CHAPTER,
    };
    const ok = await assignRole(FAKE_FS, TARGET, CUSTOM as never, ACTOR, REASON);
    expect(ok).toBe(true);
    expect(fetchUrl()).toBe('/api/admin/roles/write');
    expect(lastFetchBody()).toEqual({
      action: 'assign',
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      chapterId: CHAPTER,
      reason: REASON,
      consentRequestId: null,
    });
  });

  it('a roleless target is bootstrapped to member_basic in the same write', async () => {
    records[`users/${TARGET}`] = { displayName: 'Roleless User', chapterId: CHAPTER };
    const ok = await assignRole(FAKE_FS, TARGET, CUSTOM as never, ACTOR, REASON);
    expect(ok).toBe(true);
    const body = lastFetchBody();
    expect(body.role).toBe('member_basic');
    expect(body.additionalRoles).toEqual([CUSTOM]);
    expect(body.chapterId ?? null).toBe(CHAPTER);
  });

  it('chapterId falls back to the users doc when the roles doc carries none', async () => {
    records[`roles/${TARGET}`] = { role: 'member', additionalRoles: [] };
    records[`users/${TARGET}`] = { displayName: 'Target User', chapterId: CHAPTER };
    const ok = await assignRole(FAKE_FS, TARGET, CUSTOM as never, ACTOR, REASON);
    expect(ok).toBe(true);
    const body = lastFetchBody();
    expect(body.role).toBe('member');
    expect(body.additionalRoles).toEqual([CUSTOM]);
    expect(body.chapterId ?? null).toBe(CHAPTER);
  });

  it('an already-held slug returns true with NO fetch to the write route', async () => {
    records[`roles/${TARGET}`] = {
      role: 'member',
      additionalRoles: [CUSTOM],
      chapterId: CHAPTER,
    };
    const ok = await assignRole(FAKE_FS, TARGET, CUSTOM as never, ACTOR, REASON);
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-prefixed unknown slug returns false with no fetch', async () => {
    const ok = await assignRole(FAKE_FS, TARGET, 'media_lead' as never, ACTOR, REASON);
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('assignCustomRole / removeCustomRole (direct surface)', () => {
  it('assignCustomRole is exported and performs the same translation', async () => {
    expect(typeof assignCustomRole).toBe('function');
    records[`roles/${TARGET}`] = { role: 'member', additionalRoles: [], chapterId: CHAPTER };
    const ok = await assignCustomRole(FAKE_FS, TARGET, CUSTOM, ACTOR, REASON);
    expect(ok).toBe(true);
    const body = lastFetchBody();
    expect(body.role).toBe('member');
    expect(body.additionalRoles).toEqual([CUSTOM]);
  });

  it('removeCustomRole re-assigns the current primary with the slug removed', async () => {
    expect(typeof removeCustomRole).toBe('function');
    records[`roles/${TARGET}`] = {
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      chapterId: CHAPTER,
    };
    const ok = await removeCustomRole(FAKE_FS, TARGET, CUSTOM, ACTOR, REASON);
    expect(ok).toBe(true);
    expect(lastFetchBody()).toEqual({
      action: 'assign',
      uid: TARGET,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      chapterId: CHAPTER,
      reason: REASON,
      consentRequestId: null,
    });
  });

  it('removeCustomRole with no roles doc returns false and does not fetch', async () => {
    records[`users/${TARGET}`] = { displayName: 'Roleless User', chapterId: CHAPTER };
    const ok = await removeCustomRole(FAKE_FS, TARGET, CUSTOM, ACTOR, REASON);
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('preserveAdditionalRoles on catalog picks (plan C6)', () => {
  it('with the opt, current additionalRoles (custom included) and chapterId are forwarded, minus the new primary', async () => {
    records[`roles/${TARGET}`] = {
      role: 'member',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      chapterId: CHAPTER,
    };
    const opts = { preserveAdditionalRoles: true } as never;
    const ok = await assignRole(FAKE_FS, TARGET, 'chapter_treasurer', ACTOR, REASON, opts);
    expect(ok).toBe(true);
    expect(lastFetchBody()).toEqual({
      action: 'assign',
      uid: TARGET,
      role: 'chapter_treasurer',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      chapterId: CHAPTER,
      reason: REASON,
      consentRequestId: null,
    });
  });

  it('without the opt, the POST body matches today\'s shape exactly (regression pin)', async () => {
    records[`roles/${TARGET}`] = {
      role: 'member',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      chapterId: CHAPTER,
    };
    const ok = await assignRole(FAKE_FS, TARGET, 'chapter_treasurer', ACTOR, REASON);
    expect(ok).toBe(true);
    expect(lastFetchBody()).toEqual({
      action: 'assign',
      uid: TARGET,
      role: 'chapter_treasurer',
      reason: REASON,
      consentRequestId: null,
    });
  });
});
