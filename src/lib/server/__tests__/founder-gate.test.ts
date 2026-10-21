/**
 * @jest-environment node
 *
 * Tests for src/lib/server/founder-gate.ts.
 *
 * Pins the Phase 2 rule: the Founder test is UID equality against
 * FOUNDER_UID, never a role check. Holders of powerful roles
 * (superadmin, president_national, chief_technology_officer) who are not
 * the Founder UID must fail. verifySession is mocked; its SessionError
 * must propagate unchanged for unauthenticated requests.
 */

jest.mock('@/lib/auth/verifySession', () => {
  class SessionError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: 401 | 403 | 500) {
      super(message);
      this.name = 'SessionError';
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError,
    verifySession: jest.fn(),
  };
});

import { FOUNDER_UID } from '@/lib/roles';
import { verifySession, SessionError } from '@/lib/auth/verifySession';
import { assertFounder, isFounderUid, FounderGateError } from '../founder-gate';

const mockVerifySession = verifySession as jest.Mock;

function fakeReq(): any {
  return { headers: { get: () => 'Bearer token' } };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isFounderUid', () => {
  it('is true only for the exact Founder UID', () => {
    expect(isFounderUid(FOUNDER_UID)).toBe(true);
    expect(isFounderUid('some-other-uid')).toBe(false);
    expect(isFounderUid(null)).toBe(false);
    expect(isFounderUid(undefined)).toBe(false);
    expect(isFounderUid('')).toBe(false);
  });
});

describe('assertFounder', () => {
  it('passes for the Founder and returns the decoded token', async () => {
    mockVerifySession.mockResolvedValue({ uid: FOUNDER_UID, email: 'founder@example.com' });

    const decoded = await assertFounder(fakeReq());

    expect(decoded.uid).toBe(FOUNDER_UID);
  });

  it('throws FounderGateError for a chief_technology_officer holder uid', async () => {
    // A CTO (or superadmin / president_national) uid is not the Founder UID.
    mockVerifySession.mockResolvedValue({ uid: 'cto-uid-123', role: 'chief_technology_officer' });

    await expect(assertFounder(fakeReq())).rejects.toBeInstanceOf(FounderGateError);
  });

  it('throws FounderGateError for a superadmin / president_national uid', async () => {
    mockVerifySession.mockResolvedValue({ uid: 'president-uid-456', role: 'president_national' });

    await expect(assertFounder(fakeReq())).rejects.toBeInstanceOf(FounderGateError);

    mockVerifySession.mockResolvedValue({ uid: 'superadmin-uid-789', role: 'superadmin' });

    await expect(assertFounder(fakeReq())).rejects.toBeInstanceOf(FounderGateError);
  });

  it('throws FounderGateError for a random authenticated uid', async () => {
    mockVerifySession.mockResolvedValue({ uid: 'random-uid' });

    await expect(assertFounder(fakeReq())).rejects.toBeInstanceOf(FounderGateError);
  });

  it('propagates SessionError when unauthenticated', async () => {
    const sessionError = new SessionError('Unauthorized: missing Bearer token', 401);
    mockVerifySession.mockRejectedValue(sessionError);

    await expect(assertFounder(fakeReq())).rejects.toBe(sessionError);
    await expect(assertFounder(fakeReq())).rejects.toBeInstanceOf(SessionError);
  });
});
