/**
 * @jest-environment node
 *
 * WS10 — analytics track pins.
 *  - Static: both tracker components perform no client Firestore
 *    write.
 *  - pageVisit: existing docs increment; missing docs are created
 *    via set-merge with visits 1 (the client's fallback), for the
 *    page doc (with path) and the total doc (without path).
 *  - analyticsEvent: per-type field sets, userId from the token,
 *    ua capped at 128.
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 tracker static pins', () => {
  for (const rel of ['components/PageVisitTracker.tsx', 'components/AnalyticsEventTracker.tsx']) {
    it(`${rel} performs no client Firestore write`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/firestore-wrapper/);
      expect(src).not.toMatch(/from 'firebase\/firestore'/);
      expect(src).toContain('/api/analytics/track');
    });
  }
});

/* ------------------------------------------------------------ route fakes */
const updates: Array<{ path: string; data: any }> = [];
const setMerges: Array<{ path: string; data: any }> = [];
const adds: Array<{ col: string; data: any }> = [];
const missing = new Set<string>();

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        update: async (data: any) => {
          if (missing.has(id)) {
            const err: any = new Error('not found');
            err.code = 'not-found';
            throw err;
          }
          updates.push({ path: `${name}/${id}`, data });
        },
        set: async (data: any) => { setMerges.push({ path: `${name}/${id}`, data }); },
      }),
      add: async (data: any) => { adds.push({ col: name, data }); return { id: 'e1' }; },
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__', increment: (n: number) => `__INC_${n}__` },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'user-1' } }),
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/analytics/track', () => {
  beforeEach(() => { updates.length = 0; setMerges.length = 0; adds.length = 0; missing.clear(); });

  it('pageVisit increments both docs', async () => {
    const res = await POST(req({ kind: 'pageVisit', path: '/events' }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([
      { path: 'pageVisits/_events', data: { path: '/events', visits: '__INC_1__', lastVisit: '__ST__' } },
      { path: 'pageVisits/site_total_visits', data: { visits: '__INC_1__', lastVisit: '__ST__' } },
    ]);
  });

  it('pageVisit creates a missing page doc via set-merge with visits 1', async () => {
    missing.add('_new');
    const res = await POST(req({ kind: 'pageVisit', path: '/new' }));
    expect(res.status).toBe(200);
    expect(setMerges).toEqual([
      { path: 'pageVisits/_new', data: { path: '/new', visits: 1, lastVisit: '__ST__' } },
    ]);
    expect(updates).toHaveLength(1);
  });

  it('analyticsEvent page_view: exact field set, token userId, ua cap', async () => {
    const res = await POST(req({
      kind: 'analyticsEvent',
      event: { type: 'page_view', path: '/x', referrer: 'r', ua: 'u'.repeat(200), userId: 'spoof' },
    }));
    expect(res.status).toBe(200);
    expect(adds[0].col).toBe('analyticsEvents');
    expect(adds[0].data.userId).toBe('user-1');
    expect(adds[0].data.ua).toHaveLength(128);
    expect(Object.keys(adds[0].data)).toEqual(['type', 'path', 'userId', 'referrer', 'ua', 'timestamp']);
  });

  it('analyticsEvent click: click field set', async () => {
    const res = await POST(req({
      kind: 'analyticsEvent',
      event: { type: 'click', path: '/x', targetId: 'b1', label: 'Go', href: 'https://x' },
    }));
    expect(res.status).toBe(200);
    expect(Object.keys(adds[0].data)).toEqual(['type', 'path', 'userId', 'targetId', 'label', 'href', 'timestamp']);
  });
});
