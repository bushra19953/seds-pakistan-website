/**
 * @jest-environment node
 *
 * Adoption wave, pack 29 / GOV-08 verification pin for the
 * circular-resolutions SIGN path.
 *
 * GOV-08 described this route as trusting `currentUserRole` from the
 * request body. Verification against build 0349367 found that claim
 * DOES NOT match the tree: the route's body schema is exactly
 * { choice } and the signer identity (uid + displayName) is derived
 * server-side from the session token via requireSessionUser — there
 * is no role input to trust and no role is recorded from the body.
 * Per the pack instruction for mismatched routes, the route is left
 * unchanged; this test pins the verified behaviour so a future change
 * cannot silently reintroduce a body-supplied role.
 */

const mockState: { uid: string } = { uid: 'signer-1' };
const mockSignCalls: Array<Record<string, unknown>> = [];
const mockVoteCalls: Array<Record<string, unknown>> = [];

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async () => ({
    uid: mockState.uid,
    name: 'Signer One',
    email: 'signer@tester.test',
  })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({ __fakeDb: true }),
  admin: {},
}));

jest.mock('@/lib/server/governance/settings', () => ({
  requireGovernanceEnabled: jest.fn(async () => undefined),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({
    circularStore: {},
    bodies: {},
    classes: {},
    consents: {},
    decisions: {},
    filingTasks: {},
  })),
}));

jest.mock('@/lib/server/governance/circular', () => ({
  noopCircularNotifier: {},
  signCircular: jest.fn(async (_deps: unknown, input: Record<string, unknown>) => {
    mockSignCalls.push(input);
    return { signedCount: 1, majorityNeeded: 2, status: 'circulating' };
  }),
  voteCircular: jest.fn(async (_deps: unknown, input: Record<string, unknown>) => {
    mockVoteCalls.push(input);
    return { signedCount: 0, majorityNeeded: 2, status: 'circulating' };
  }),
}));

import { NextRequest } from 'next/server';
import { POST } from '../[resolutionId]/sign/route';

const ctx = { params: Promise.resolve({ resolutionId: 'res-1' }) };
const URL = 'http://localhost/api/governance/circular-resolutions/res-1/sign';

function req(body: unknown, token?: string) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignCalls.length = 0;
  mockVoteCalls.length = 0;
  mockState.uid = 'signer-1';
});

describe('circular-resolutions sign: signer identity is server-derived', () => {
  it('a "for" signature uses the TOKEN uid/displayName; a body-supplied currentUserRole is ignored entirely', async () => {
    const res = await POST(
      req({ choice: 'for', currentUserRole: 'founder_patron', uid: 'victim-1', displayName: 'Forged' }, 'tok'),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockSignCalls).toHaveLength(1);
    expect(mockSignCalls[0].uid).toBe('signer-1');
    expect(mockSignCalls[0].displayName).toBe('Signer One');
    expect(mockSignCalls[0]).not.toHaveProperty('currentUserRole');
    expect(mockSignCalls[0]).not.toHaveProperty('role');
  });

  it('an "against" vote also carries only the token-derived identity', async () => {
    const res = await POST(req({ choice: 'against', currentUserRole: 'president_national' }, 'tok'), ctx);
    expect(res.status).toBe(200);
    expect(mockVoteCalls).toHaveLength(1);
    expect(mockVoteCalls[0].uid).toBe('signer-1');
    expect(mockVoteCalls[0]).not.toHaveProperty('currentUserRole');
  });

  it('unauthenticated gets 401 and no signature is recorded', async () => {
    const res = await POST(req({ choice: 'for' }), ctx);
    expect(res.status).toBe(401);
    expect(mockSignCalls).toHaveLength(0);
  });
});
