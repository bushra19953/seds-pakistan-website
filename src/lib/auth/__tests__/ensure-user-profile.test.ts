/**
 * ensure-user-profile.test.ts
 *
 * Unit tests for the self-healing user profile module
 * (src/lib/auth/ensure-user-profile.ts).
 *
 * Contract under test:
 * - ensureUserProfile: getDoc(users/{uid}); exists WITH a recorded role
 *   (role or displayRole) -> 'exists' and setDoc is NOT called. Exists
 *   with NEITHER -> one backfill setDoc of { role: 'member' } with
 *   { merge: true }, still returns 'exists'; a backfill failure is
 *   swallowed and the result stays 'exists'. Missing -> setDoc with the
 *   built profile and { merge: true }, returns 'created'. getDoc or the
 *   create setDoc throws -> returns 'failed' and never throws itself.
 *   setDoc is called at most once per invocation (no retry loop).
 * - buildNewUserProfileData: every key belongs to the firestore.rules
 *   allow-list, role is 'member', chapterId is 'seds-ist-chapter', all
 *   counters are 0, uid matches the user, and the email key is ABSENT
 *   when user.email is null.
 *
 * Mocking style follows the repo's existing tests (for example
 * src/app/admin/submissions/__tests__/leave-inbox-mapping.test.tsx):
 * jest.mock('firebase/firestore') with jest.fn() getDoc / setDoc / doc,
 * and serverTimestamp mocked to a deterministic sentinel.
 */

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: any, ...parts: any[]) => ({
    path: parts.join('/'),
    id: parts[parts.length - 1],
  })),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  serverTimestamp: jest.fn(() => 'SERVER_TS'),
}));

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import {
  buildNewUserProfileData,
  ensureUserProfile,
} from '../ensure-user-profile';

const mockDoc = doc as jest.MockedFunction<any>;
const mockGetDoc = getDoc as jest.MockedFunction<any>;
const mockSetDoc = setDoc as jest.MockedFunction<any>;
const mockServerTimestamp = serverTimestamp as jest.MockedFunction<any>;

const SERVER_TS = 'SERVER_TS';

/** The exact allow-list from the task spec / firestore.rules hasOnly(). */
const ALLOW_LIST = [
  'uid',
  'email',
  'photoURL',
  'displayName',
  'role',
  'chapterId',
  'points',
  'upvotes',
  'downvotes',
  'tasksAssignedCount',
  'tasksCompletedOnTimeCount',
  'createdAt',
  'updatedAt',
  'lastSeenAt',
  'agreedToTermsAt',
  'termsAgreementTimestamp',
] as const;

const fakeDb = {} as unknown as Firestore;

function makeUser(overrides: Record<string, any> = {}): User {
  return {
    uid: 'user-123',
    email: 'test@example.com',
    photoURL: 'https://example.com/avatar.png',
    displayName: 'Test User',
    ...overrides,
  } as unknown as User;
}

function existingSnap() {
  return { exists: () => true, data: () => ({ uid: 'user-123', role: 'member' }) };
}

function rolelessSnap() {
  return { exists: () => true, data: () => ({ uid: 'user-123' }) };
}

function missingSnap() {
  return { exists: () => false, data: () => undefined };
}

beforeEach(() => {
  jest.clearAllMocks();
  // jest.clearAllMocks clears calls but the factory implementations for
  // doc / serverTimestamp are re-pinned here so every test is
  // deterministic regardless of mock-clearing semantics.
  mockDoc.mockImplementation((_db: any, ...parts: any[]) => ({
    path: parts.join('/'),
    id: parts[parts.length - 1],
  }));
  mockServerTimestamp.mockReturnValue(SERVER_TS);
  mockSetDoc.mockResolvedValue(undefined);
  // The module logs failures with console.error; silence it in tests.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ensureUserProfile', () => {
  it('doc exists -> resolves "exists" and setDoc is not called', async () => {
    mockGetDoc.mockResolvedValue(existingSnap());

    const result = await ensureUserProfile(fakeDb, makeUser());

    expect(result).toBe('exists');
    expect(mockGetDoc).toHaveBeenCalledTimes(1);
    expect(mockDoc).toHaveBeenCalledWith(fakeDb, 'users', 'user-123');
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('doc exists with neither role nor displayRole -> backfills { role: "member" } once and still resolves "exists"', async () => {
    mockGetDoc.mockResolvedValue(rolelessSnap());

    const result = await ensureUserProfile(fakeDb, makeUser());

    expect(result).toBe('exists');
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    const [ref, data, options] = mockSetDoc.mock.calls[0];
    expect(ref).toEqual({ path: 'users/user-123', id: 'user-123' });
    expect(data).toEqual({ role: 'member' });
    expect(options).toEqual({ merge: true });
  });

  it('role backfill write rejects -> still resolves "exists" and does not throw', async () => {
    mockGetDoc.mockResolvedValue(rolelessSnap());
    mockSetDoc.mockRejectedValue(new Error('permission-denied'));

    await expect(ensureUserProfile(fakeDb, makeUser())).resolves.toBe('exists');
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
  });

  it('doc missing -> resolves "created" and setDoc is called once with ref, profile data and { merge: true }', async () => {
    mockGetDoc.mockResolvedValue(missingSnap());

    const result = await ensureUserProfile(fakeDb, makeUser());

    expect(result).toBe('created');
    expect(mockGetDoc).toHaveBeenCalledTimes(1);
    expect(mockSetDoc).toHaveBeenCalledTimes(1);

    const [ref, data, options] = mockSetDoc.mock.calls[0];
    // Ref targets users/{uid}: both getDoc and setDoc receive the ref
    // built by doc(db, 'users', uid).
    expect(mockDoc).toHaveBeenCalledWith(fakeDb, 'users', 'user-123');
    expect(ref).toEqual({ path: 'users/user-123', id: 'user-123' });
    expect(options).toEqual({ merge: true });

    expect(data).toMatchObject({
      uid: 'user-123',
      email: 'test@example.com',
      photoURL: 'https://example.com/avatar.png',
      displayName: 'Test User',
      role: 'member',
      chapterId: 'seds-ist-chapter',
      points: 0,
      upvotes: 0,
      downvotes: 0,
      tasksAssignedCount: 0,
      tasksCompletedOnTimeCount: 0,
      createdAt: SERVER_TS,
      updatedAt: SERVER_TS,
      lastSeenAt: SERVER_TS,
      agreedToTermsAt: SERVER_TS,
      termsAgreementTimestamp: SERVER_TS,
    });
    // No key outside the allow-list is ever written.
    for (const key of Object.keys(data)) {
      expect(ALLOW_LIST).toContain(key);
    }
  });

  it('setDoc rejects -> resolves "failed", does not throw, and setDoc is called exactly once (no retry loop)', async () => {
    mockGetDoc.mockResolvedValue(missingSnap());
    mockSetDoc.mockRejectedValue(new Error('permission-denied'));

    await expect(
      ensureUserProfile(fakeDb, makeUser())
    ).resolves.toBe('failed');

    expect(mockSetDoc).toHaveBeenCalledTimes(1);
  });

  it('getDoc rejects -> resolves "failed" and setDoc is not called', async () => {
    mockGetDoc.mockRejectedValue(new Error('unavailable'));

    await expect(
      ensureUserProfile(fakeDb, makeUser())
    ).resolves.toBe('failed');

    expect(mockGetDoc).toHaveBeenCalledTimes(1);
    expect(mockSetDoc).not.toHaveBeenCalled();
  });
});

describe('buildNewUserProfileData', () => {
  it('sets role to member, chapterId to seds-ist-chapter, and all counters to 0', () => {
    const data = buildNewUserProfileData(makeUser());

    expect(data.role).toBe('member');
    expect(data.chapterId).toBe('seds-ist-chapter');
    expect(data.points).toBe(0);
    expect(data.upvotes).toBe(0);
    expect(data.downvotes).toBe(0);
    expect(data.tasksAssignedCount).toBe(0);
    expect(data.tasksCompletedOnTimeCount).toBe(0);
  });

  it('copies uid, photoURL and displayName from the user', () => {
    const data = buildNewUserProfileData(makeUser());

    expect(data.uid).toBe('user-123');
    expect(data.photoURL).toBe('https://example.com/avatar.png');
    expect(data.displayName).toBe('Test User');
  });

  it('includes the email key when user.email is provided', () => {
    const data = buildNewUserProfileData(
      makeUser({ email: 'someone@example.com' })
    );

    expect('email' in data).toBe(true);
    expect(data.email).toBe('someone@example.com');
  });

  it('omits the email key entirely when user.email is null', () => {
    const data = buildNewUserProfileData(makeUser({ email: null }));

    expect('email' in data).toBe(false);
    expect(data).not.toHaveProperty('email');
  });

  it('uses the serverTimestamp sentinel for every timestamp field', () => {
    const data = buildNewUserProfileData(makeUser());

    expect(data.createdAt).toBe(SERVER_TS);
    expect(data.updatedAt).toBe(SERVER_TS);
    expect(data.lastSeenAt).toBe(SERVER_TS);
    expect(data.agreedToTermsAt).toBe(SERVER_TS);
    expect(data.termsAgreementTimestamp).toBe(SERVER_TS);
  });

  it('every key belongs to the firestore.rules allow-list (with email)', () => {
    const data = buildNewUserProfileData(makeUser());

    expect(Object.keys(data).length).toBeGreaterThan(0);
    for (const key of Object.keys(data)) {
      expect(ALLOW_LIST).toContain(key);
    }
  });

  it('every key belongs to the firestore.rules allow-list (email null)', () => {
    const data = buildNewUserProfileData(makeUser({ email: null }));

    for (const key of Object.keys(data)) {
      expect(ALLOW_LIST).toContain(key);
    }
  });
});
