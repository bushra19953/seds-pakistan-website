/**
 * @jest-environment node
 *
 * Read-bleed train 2 (census 05 §2.1 / leg L3): validateUserStatus is
 * seam-first. A healthy seam hit must cost ZERO Firestore reads, a
 * transient seam failure is fail-SOFT into exactly one caught
 * Firestore get, and the per-request cache dedupes repeat userIds
 * within one write flow. resolveUserDisplayName follows the same
 * shape and never throws.
 */

const mockSupaGetDoc = jest.fn();
let fsGetCount = 0;
let fsData: any = null;
let fsError: Error | null = null;

jest.mock('@/lib/server/supa-roles-seam', () => ({
  supaGetDoc: (...args: any[]) => mockSupaGetDoc(...args),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => {
          fsGetCount += 1;
          if (fsError) throw fsError;
          return {
            exists: fsData !== null,
            data: () => (fsData === null ? undefined : fsData),
          };
        },
      }),
    }),
  }),
  admin: { firestore: { Timestamp: class {} } },
}));

import {
  resolveUserDisplayName,
  validateUserStatus,
  type UserStatusCache,
} from '../user-status';

beforeEach(() => {
  jest.clearAllMocks();
  fsGetCount = 0;
  fsData = null;
  fsError = null;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('validateUserStatus seam-first', () => {
  it('healthy seam hit: banned user resolved with zero Firestore reads', async () => {
    mockSupaGetDoc.mockResolvedValue({
      exists: true,
      data: { isBanned: true, displayName: 'Bad Actor' },
    });
    const res = await validateUserStatus('u1');
    expect(res.isValid).toBe(false);
    expect(res.isBanned).toBe(true);
    expect(res.error).toBe('User is banned');
    expect(fsGetCount).toBe(0);
  });

  it('seam miss (row genuinely absent): zero Firestore reads, not-found answer', async () => {
    mockSupaGetDoc.mockResolvedValue({ exists: false, data: null });
    const res = await validateUserStatus('ghost');
    expect(res.isValid).toBe(false);
    expect(res.error).toBe('User does not exist');
    expect(fsGetCount).toBe(0);
  });

  it('transient seam failure: fail-soft into exactly one caught Firestore get', async () => {
    mockSupaGetDoc.mockResolvedValue(null);
    fsData = { isBanned: false };
    const res = await validateUserStatus('u2');
    expect(res.isValid).toBe(true);
    expect(fsGetCount).toBe(1);
  });

  it('seam failure AND Firestore failure: caught, returns the error answer (never throws)', async () => {
    mockSupaGetDoc.mockResolvedValue(null);
    fsError = new Error('RESOURCE_EXHAUSTED');
    const res = await validateUserStatus('u3');
    expect(res.isValid).toBe(false);
    expect(res.error).toBe('RESOURCE_EXHAUSTED');
    expect(fsGetCount).toBe(1);
  });

  it('per-request cache dedupes repeat userIds (census 05 L1)', async () => {
    mockSupaGetDoc.mockResolvedValue({ exists: true, data: { isBanned: false } });
    const cache: UserStatusCache = new Map();
    await validateUserStatus('u4', cache);
    await validateUserStatus('u4', cache);
    await validateUserStatus('u4', cache);
    expect(mockSupaGetDoc.mock.calls.length).toBe(1);
    expect(fsGetCount).toBe(0);
  });

  it('vacation projection matches the Firestore path (vacation fields)', async () => {
    mockSupaGetDoc.mockResolvedValue({
      exists: true,
      data: {
        isOnVacation: true,
        vacationStartDate: '2026-10-01',
        vacationEndDate: '2026-11-01',
        coveringOfficerId: 'officer-1',
        leaveRequestId: 'lr-1',
      },
    });
    const res = await validateUserStatus('u5');
    expect(res.isValid).toBe(false);
    expect(res.isOnVacation).toBe(true);
    expect(res.error).toBe('User is currently on vacation');
    expect(res.coveringOfficerId).toBe('officer-1');
    expect(res.vacationStartDate).toBe('2026-10-01');
    expect(res.vacationEndDate).toBe('2026-11-01');
    expect(res.leaveRequestId).toBe('lr-1');
    expect(fsGetCount).toBe(0);
  });
});

describe('resolveUserDisplayName', () => {
  it('seam-first: returns displayName with zero Firestore reads', async () => {
    mockSupaGetDoc.mockResolvedValue({ exists: true, data: { displayName: 'Seam Name' } });
    await expect(resolveUserDisplayName('u6')).resolves.toBe('Seam Name');
    expect(fsGetCount).toBe(0);
  });

  it('falls back to the caught Firestore get, then null on failure', async () => {
    mockSupaGetDoc.mockResolvedValue(null);
    fsData = { displayName: 'Fs Name' };
    await expect(resolveUserDisplayName('u7')).resolves.toBe('Fs Name');
    fsError = new Error('down');
    await expect(resolveUserDisplayName('u8')).resolves.toBeNull();
  });
});
