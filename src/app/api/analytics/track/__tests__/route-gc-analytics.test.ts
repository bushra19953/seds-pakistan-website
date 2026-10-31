/**
 * @jest-environment node
 *
 * GC: analytics vocabulary and mirrors for POST /api/analytics/track.
 * Firestore is faked at the firebase-admin boundary, auth is faked,
 * and the mirror seam is mocked at the module boundary. Zero
 * production reads; the running Firestore read total is 0.
 */
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
        set: async (data: any) => {
          setMerges.push({ path: `${name}/${id}`, data });
        },
      }),
      add: async (data: any) => {
        adds.push({ col: name, data });
        return { id: 'e1' };
      },
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ST__',
    increment: (n: number) => `__INC_${n}__`,
  },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'user-1' },
  })),
}));
jest.mock('@/lib/server/admin-analytics-supa', () => ({
  mirrorAnalyticsEvent: jest.fn(async () => true),
  mirrorPageVisitIncrement: jest.fn(async () => true),
  SITE_TOTAL_VISITS_ID: 'site_total_visits',
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  mirrorAnalyticsEvent,
  mirrorPageVisitIncrement,
} from '@/lib/server/admin-analytics-supa';

const mockVerify = verifyAuthentication as jest.Mock;
const mockMirrorEvent = mirrorAnalyticsEvent as jest.Mock;
const mockMirrorVisit = mirrorPageVisitIncrement as jest.Mock;

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

const COMMERCE_TYPES: string[] = [
  'product_view',
  'buy_click',
  'checkout_start',
  'order_created',
];

const INVALID_PRODUCT_ID_CASES: Array<{ label: string; value?: unknown }> = [
  { label: 'missing' },
  { label: 'null', value: null },
  { label: 'number', value: 42 },
  { label: 'empty string', value: '' },
  { label: 'whitespace only', value: '   ' },
  { label: '129 characters', value: 'p'.repeat(129) },
];

const REJECT_ROWS = COMMERCE_TYPES.flatMap((type) =>
  INVALID_PRODUCT_ID_CASES.map((c) => ({ type, label: c.label, value: c.value })),
);

beforeEach(() => {
  updates.length = 0;
  setMerges.length = 0;
  adds.length = 0;
  missing.clear();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({
    authenticated: true,
    user: { userId: 'user-1' },
  });
  mockMirrorEvent.mockReset();
  mockMirrorEvent.mockResolvedValue(true);
  mockMirrorVisit.mockReset();
  mockMirrorVisit.mockResolvedValue(true);
});

describe('GC POST /api/analytics/track commerce vocabulary', () => {
  it.each(COMMERCE_TYPES)(
    'accepts %s and stores a per-event doc with productId, token userId, capped path and server timestamp',
    async (type) => {
      const longPath = `/store/${'x'.repeat(600)}`;
      const res = await POST(
        req({
          kind: 'analyticsEvent',
          event: { type, path: longPath, productId: 'p1' },
        }),
      );
      expect(res.status).toBe(200);
      expect(adds).toHaveLength(1);
      expect(adds[0].col).toBe('analyticsEvents');
      expect(Object.keys(adds[0].data)).toEqual([
        'type',
        'path',
        'userId',
        'productId',
        'timestamp',
      ]);
      expect(adds[0].data.type).toBe(type);
      expect(adds[0].data.productId).toBe('p1');
      expect(adds[0].data.userId).toBe('user-1');
      expect(adds[0].data.path).toBe(longPath.slice(0, 512));
      expect(adds[0].data.timestamp).toBe('__ST__');
    },
  );

  it.each(COMMERCE_TYPES)(
    'mirrors %s to fs_analyticsEvents under the Firestore doc id',
    async (type) => {
      const res = await POST(
        req({
          kind: 'analyticsEvent',
          event: { type, path: '/store/p1', productId: 'p1' },
        }),
      );
      expect(res.status).toBe(200);
      expect(mockMirrorEvent).toHaveBeenCalledTimes(1);
      const [id, payload] = mockMirrorEvent.mock.calls[0];
      expect(id).toBe('e1');
      expect(Object.keys(payload)).toEqual(Object.keys(adds[0].data));
      expect(payload.type).toBe(type);
      expect(payload.path).toBe('/store/p1');
      expect(payload.userId).toBe('user-1');
      expect(payload.productId).toBe('p1');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(payload.timestamp).not.toBe('__ST__');
    },
  );

  it.each(REJECT_ROWS)(
    'rejects $type with invalid productId ($label) with 400 and writes nothing',
    async (row) => {
      const event: Record<string, any> = {
        type: row.type,
        path: '/store/p1',
      };
      if (row.label !== 'missing') event.productId = row.value;
      const res = await POST(req({ kind: 'analyticsEvent', event }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'productId is required' });
      expect(adds).toHaveLength(0);
      expect(mockMirrorEvent).not.toHaveBeenCalled();
    },
  );

  it('stores the trimmed productId', async () => {
    const res = await POST(
      req({
        kind: 'analyticsEvent',
        event: { type: 'product_view', path: '/store/p1', productId: '  p1  ' },
      }),
    );
    expect(res.status).toBe(200);
    expect(adds[0].data.productId).toBe('p1');
  });

  it('still rejects purchase, add_to_cart and search event types with 400 Invalid event type', async () => {
    for (const type of ['purchase', 'add_to_cart', 'search']) {
      adds.length = 0;
      mockMirrorEvent.mockClear();
      const res = await POST(
        req({
          kind: 'analyticsEvent',
          event: { type, path: '/store/p1', productId: 'p1' },
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid event type' });
      expect(adds).toHaveLength(0);
      expect(mockMirrorEvent).not.toHaveBeenCalled();
    }
  });

  it('page_view and click do not require productId and never store a sent productId', async () => {
    const pageViewRes = await POST(
      req({
        kind: 'analyticsEvent',
        event: {
          type: 'page_view',
          path: '/x',
          referrer: 'r',
          ua: 'agent',
          productId: 'p1',
        },
      }),
    );
    expect(pageViewRes.status).toBe(200);
    expect(Object.keys(adds[0].data)).toEqual([
      'type',
      'path',
      'userId',
      'referrer',
      'ua',
      'timestamp',
    ]);
    expect(adds[0].data).not.toHaveProperty('productId');

    adds.length = 0;
    const clickRes = await POST(
      req({
        kind: 'analyticsEvent',
        event: {
          type: 'click',
          path: '/x',
          targetId: 'b1',
          label: 'Go',
          href: 'https://x',
          productId: 'p1',
        },
      }),
    );
    expect(clickRes.status).toBe(200);
    expect(Object.keys(adds[0].data)).toEqual([
      'type',
      'path',
      'userId',
      'targetId',
      'label',
      'href',
      'timestamp',
    ]);
    expect(adds[0].data).not.toHaveProperty('productId');
  });

  it('commerce events ignore a spoofed userId and a client timestamp in the payload', async () => {
    const res = await POST(
      req({
        kind: 'analyticsEvent',
        event: {
          type: 'buy_click',
          path: '/store/p1',
          productId: 'p1',
          userId: 'spoof',
          timestamp: '2000-01-01T00:00:00.000Z',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(adds[0].data.userId).toBe('user-1');
    expect(adds[0].data.timestamp).toBe('__ST__');
  });

  it('mirrors page_view and click events as well as commerce events', async () => {
    await POST(
      req({
        kind: 'analyticsEvent',
        event: { type: 'page_view', path: '/x', referrer: 'r', ua: 'agent' },
      }),
    );
    expect(mockMirrorEvent).toHaveBeenCalledTimes(1);
    expect(mockMirrorEvent.mock.calls[0][0]).toBe('e1');
    expect(Object.keys(mockMirrorEvent.mock.calls[0][1])).toEqual(
      Object.keys(adds[0].data),
    );
    expect(mockMirrorEvent.mock.calls[0][1].timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    adds.length = 0;
    mockMirrorEvent.mockClear();
    await POST(
      req({
        kind: 'analyticsEvent',
        event: {
          type: 'click',
          path: '/x',
          targetId: 'b1',
          label: 'Go',
          href: 'https://x',
        },
      }),
    );
    expect(mockMirrorEvent).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockMirrorEvent.mock.calls[0][1])).toEqual(
      Object.keys(adds[0].data),
    );
  });

  it('returns 200 when the mirror reports false', async () => {
    mockMirrorEvent.mockResolvedValue(false);
    mockMirrorVisit.mockResolvedValue(false);
    const eventRes = await POST(
      req({
        kind: 'analyticsEvent',
        event: { type: 'product_view', path: '/store/p1', productId: 'p1' },
      }),
    );
    expect(eventRes.status).toBe(200);
    expect(await eventRes.json()).toEqual({ ok: true });

    const visitRes = await POST(req({ kind: 'pageVisit', path: '/store' }));
    expect(visitRes.status).toBe(200);
    expect(await visitRes.json()).toEqual({ ok: true });
  });

  it('returns 401 and writes nothing when unauthenticated', async () => {
    mockVerify.mockResolvedValue({ authenticated: false, user: null });
    const res = await POST(
      req({
        kind: 'analyticsEvent',
        event: { type: 'product_view', path: '/store/p1', productId: 'p1' },
      }),
    );
    expect(res.status).toBe(401);
    expect(adds).toHaveLength(0);
    expect(mockMirrorEvent).not.toHaveBeenCalled();
  });
});

describe('GC POST /api/analytics/track pageVisit mirror', () => {
  it('mirrors both counter docs after the Firestore bump, page doc first with its path, total doc with a null path', async () => {
    const res = await POST(req({ kind: 'pageVisit', path: '/store' }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([
      {
        path: 'pageVisits/_store',
        data: { path: '/store', visits: '__INC_1__', lastVisit: '__ST__' },
      },
      {
        path: 'pageVisits/site_total_visits',
        data: { visits: '__INC_1__', lastVisit: '__ST__' },
      },
    ]);
    expect(mockMirrorVisit.mock.calls).toEqual([
      ['_store', '/store'],
      ['site_total_visits', null],
    ]);
  });

  it('does not mirror when the pageVisit write is rejected', async () => {
    const res = await POST(req({ kind: 'pageVisit' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'path is required' });
    expect(mockMirrorVisit).not.toHaveBeenCalled();
  });
});
