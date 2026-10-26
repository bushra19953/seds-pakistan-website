/**
 * @jest-environment node
 *
 * WS10 — votes pins.
 *  - Static: profile/unified page and leaderboard no longer run
 *    client transactions.
 *  - POST /api/users/vote: transaction sets the vote doc (with
 *    targetUserName when sent) + increments the right counter;
 *    an existing vote → 409 already_voted with zero writes.
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 votes static pins', () => {
  it('no client runTransaction remains in either caller', () => {
    for (const rel of ['app/profile/unified/[uid]/page.tsx', 'components/community/leaderboard.tsx']) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/runTransaction/);
      expect(src).toContain('/api/users/vote');
    }
  });
});

const txSets: Array<{ ref: any; data: any }> = [];
const txUpdates: Array<{ ref: any; data: any }> = [];
let voteExists = false;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({
      doc: (id: string) => ({
        __id: id,
        collection: () => ({ doc: (vid: string) => ({ __id: `${id}/votes/${vid}` }) }),
      }),
    }),
    runTransaction: async (fn: any) => {
      const tx = {
        get: async () => ({ exists: voteExists }),
        set: (ref: any, data: any) => { txSets.push({ ref: ref.__id, data }); },
        update: (ref: any, data: any) => { txUpdates.push({ ref: ref.__id, data }); },
      };
      return fn(tx);
    },
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__', increment: (n: number) => `__INC_${n}__` },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'voter-1' } }),
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/users/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/users/vote', () => {
  beforeEach(() => { txSets.length = 0; txUpdates.length = 0; voteExists = false; });

  it('casts an upvote: vote doc + upvotes increment', async () => {
    const res = await POST(req({ targetUid: 'target-1', type: 'up' }));
    expect(res.status).toBe(200);
    expect(txSets).toEqual([{
      ref: 'target-1/votes/voter-1',
      data: { type: 'up', voterUid: 'voter-1', createdAt: '__ST__' },
    }]);
    expect(txUpdates).toEqual([{ ref: 'target-1', data: { upvotes: '__INC_1__' } }]);
  });

  it('leaderboard shape: targetUserName carried; downvote counter', async () => {
    const res = await POST(req({ targetUid: 't2', type: 'down', targetUserName: 'Target Two' }));
    expect(res.status).toBe(200);
    expect(txSets[0].data).toMatchObject({ type: 'down', targetUserName: 'Target Two' });
    expect(txUpdates[0].data).toEqual({ downvotes: '__INC_1__' });
  });

  it('already voted: 409, zero writes', async () => {
    voteExists = true;
    const res = await POST(req({ targetUid: 't3', type: 'up' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_voted');
    expect(txSets).toHaveLength(0);
    expect(txUpdates).toHaveLength(0);
  });
});
