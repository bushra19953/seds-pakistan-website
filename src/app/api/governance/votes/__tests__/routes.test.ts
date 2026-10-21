/**
 * @jest-environment node
 *
 * Route tests for /api/governance/votes (spec Section 0.2): auth gate,
 * open -> cast -> close flow, ballots never exposed by the read API.
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
import { GET as getGET } from '@/app/api/governance/votes/[voteId]/route';
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
  seatKey: `seat-${i}`,
  roleKey: 'governor',
  uid: `gov-${i}`,
  vacant: false,
}));

beforeEach(() => {
  fakeHolder.db = createFakeDb();
  mockAuthState.userId = 'gov-1';
});

describe('governance votes routes', () => {
  it('unauthenticated callers get 401 on every route', async () => {
    mockAuthState.userId = null;
    const open = await openPOST(jsonReq('http://x/api/governance/votes', { subjectType: 'board_generic', electorate: ELECTORATE }));
    expect(open.status).toBe(401);
    const get = await getGET(jsonReq('http://x/api/governance/votes/abc'), { params: Promise.resolve({ voteId: 'abc' }) });
    expect(get.status).toBe(401);
  });

  it('open -> cast -> close flow; GET exposes ballotCount, never ballots', async () => {
    const open = await openPOST(
      jsonReq('http://x/api/governance/votes', { subjectType: 'chapter_suspend', electorate: ELECTORATE }),
    );
    expect(open.status).toBe(201);
    const { voteId } = await open.json();

    for (const uid of ['gov-1', 'gov-2']) {
      mockAuthState.userId = uid;
      const cast = await castPOST(jsonReq(`http://x/api/governance/votes/${voteId}/cast`, { choice: 'for' }), {
        params: Promise.resolve({ voteId }),
      });
      expect(cast.status).toBe(200);
    }
    // A voter outside the electorate is rejected.
    mockAuthState.userId = 'outsider';
    const badCast = await castPOST(jsonReq(`http://x/api/governance/votes/${voteId}/cast`, { choice: 'for' }), {
      params: Promise.resolve({ voteId }),
    });
    expect(badCast.status).toBe(403);

    mockAuthState.userId = 'gov-1';
    const close = await closePOST(jsonReq(`http://x/api/governance/votes/${voteId}/close`), {
      params: Promise.resolve({ voteId }),
    });
    expect(close.status).toBe(200);
    const { result } = await close.json();
    expect(result.passed).toBe(true);
    expect(result.votesFor).toBe(2);

    const get = await getGET(jsonReq(`http://x/api/governance/votes/${voteId}`), {
      params: Promise.resolve({ voteId }),
    });
    const { vote } = await get.json();
    expect(vote.ballotCount).toBe(2);
    expect(vote.ballots).toBeUndefined();
    expect(vote.result.passed).toBe(true);
  });
});
