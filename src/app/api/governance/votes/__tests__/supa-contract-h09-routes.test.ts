/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Area 6 (route layer): governance votes routes, H-09 pins at HTTP level.
 *
 * H-09: behavior pinned faithfully for migration; the missing gate is a
 * known hole, NOT a spec.
 *
 * The existing routes.test.ts pins the happy path for an electorate
 * member. These tests pin what it does not: the ONLY route gate is
 * authentication (401 when signed out). There is NO permission check on
 * open, cast beyond electorate membership, or close - so any signed-in
 * user can open a vote over a self-supplied electorate and any signed-in
 * user can close/certify anyone's vote.
 */
import { NextRequest } from 'next/server';

const mockAuthState: { userId: string | null } = { userId: 'gov-1' };
const fakeHolder: { db: any } = { db: null };

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeHolder.db,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () =>
    mockAuthState.userId
      ? { authenticated: true, user: { userId: mockAuthState.userId } }
      : { authenticated: false, user: null },
  ),
}));

import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST as openPOST } from '@/app/api/governance/votes/route';
import { POST as castPOST } from '@/app/api/governance/votes/[voteId]/cast/route';
import { POST as closePOST } from '@/app/api/governance/votes/[voteId]/close/route';

function jsonReq(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const ELECTORATE = [1, 2, 3].map((i) => ({
  seatKey: `seat-${i}`, roleKey: 'governor', uid: `gov-${i}`, vacant: false,
}));

beforeEach(() => {
  fakeHolder.db = createFakeDb();
  mockAuthState.userId = 'gov-1';
});

describe('H-09 route pins: authentication is the only gate', () => {
  it('a plain signed-in user who is in NO electorate can OPEN a vote naming themselves the sole elector', async () => {
    mockAuthState.userId = 'plain_member';
    const open = await openPOST(jsonReq('http://x/api/governance/votes', {
      subjectType: 'board_generic',
      electorate: [{ seatKey: 'seat-1', roleKey: 'governor', uid: 'plain_member', vacant: false }],
    }));
    expect(open.status).toBe(201);
    const { voteId } = await open.json();
    const cast = await castPOST(jsonReq(`http://x/api/governance/votes/${voteId}/cast`, { choice: 'for' }), {
      params: Promise.resolve({ voteId }),
    });
    expect(cast.status).toBe(200);
    const close = await closePOST(jsonReq(`http://x/api/governance/votes/${voteId}/close`), {
      params: Promise.resolve({ voteId }),
    });
    expect(close.status).toBe(200);
    const { result } = await close.json();
    expect(result.passed).toBe(true);
    expect(result.votesFor).toBe(1);
  });

  it('a complete outsider can CLOSE and certify a vote opened by someone else', async () => {
    const open = await openPOST(jsonReq('http://x/api/governance/votes', {
      subjectType: 'chapter_suspend', electorate: ELECTORATE,
    }));
    const { voteId } = await open.json();
    mockAuthState.userId = 'gov-2';
    await castPOST(jsonReq(`http://x/api/governance/votes/${voteId}/cast`, { choice: 'for' }), {
      params: Promise.resolve({ voteId }),
    });
    mockAuthState.userId = 'total_outsider';
    const close = await closePOST(jsonReq(`http://x/api/governance/votes/${voteId}/close`), {
      params: Promise.resolve({ voteId }),
    });
    expect(close.status).toBe(200);
    const { result } = await close.json();
    expect(result.votesFor).toBe(1);
  });

  it('a second close by yet another outsider returns the SAME certified result (idempotent, still ungated)', async () => {
    const open = await openPOST(jsonReq('http://x/api/governance/votes', {
      subjectType: 'chapter_suspend', electorate: ELECTORATE,
    }));
    const { voteId } = await open.json();
    mockAuthState.userId = 'outsider_a';
    const first = await closePOST(jsonReq(`http://x/api/governance/votes/${voteId}/close`), {
      params: Promise.resolve({ voteId }),
    });
    mockAuthState.userId = 'outsider_b';
    const second = await closePOST(jsonReq(`http://x/api/governance/votes/${voteId}/close`), {
      params: Promise.resolve({ voteId }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });
});
