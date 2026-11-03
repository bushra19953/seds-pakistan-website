/**
 * @jest-environment node
 *
 * MSG30 — notification bell read-state (founder report: the bell
 * "always stays filled even when marked all done").
 *
 * Root cause, proven by tracing (see src/lib/notification-read-state.ts):
 * two read-state spellings coexist in users/{uid}/notifications —
 * `isRead` (service/tasks family) and `read` (notification-helper +
 * webhooks task-complete family, which carry NO `isRead` field) — and
 * every mark-read write and every count/list reader spoke only
 * `isRead`. Mark-all-read therefore never touched a `read:` doc, and
 * its unread marker survived every "mark all done".
 *
 * The tests below pin the invariant, not the old formula: after
 * mark-all-read, NO notification in the store may be unread under the
 * single normalized predicate (either field exactly true = read).
 * Written reproduce-first: on the pre-fix route the `read:` fixture
 * survives PATCH { all: true } and the reproduce test FAILS with a
 * normalized count of 1; after the fix it passes.
 *
 * The "reload" step in the live proof is a fresh GET against the SAME
 * fake store through the real route + seam code — exactly what a
 * production reload does (new mount, same backend). The only mock is
 * the store boundary itself (fake Firestore / injected adapter), which
 * IS the persistence layer in tests; nothing re-renders in-memory
 * state and calls it a reload.
 *
 * Mocks mirror src/app/api/notifications/__tests__/route.test.ts:
 * verifySession is mocked, Firestore is a hand-rolled double with
 * orderBy-drops-missing-field semantics, Supabase is an injected
 * adapter. No live reads, no prod data.
 */

jest.mock('@/lib/auth/verifySession', () => {
  class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: 401 | 403 | 500) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return { SessionError, verifySession: jest.fn() };
});

const dbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => dbHolder.db,
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';
import { GET, PATCH } from '@/app/api/notifications/route';
import { verifySession } from '@/lib/auth/verifySession';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';
import {
  isNotificationRead,
  isNotificationUnread,
  notificationUnreadCount,
  MARK_NOTIFICATION_READ_UPDATE,
} from '@/lib/notification-read-state';

const UID = 'user-1';
const verifyMock = verifySession as jest.Mock;

function ts(iso: string) {
  const d = new Date(iso);
  return { toDate: () => d, seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 };
}

function fieldMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'string') return Date.parse(v);
  if (typeof v === 'number') return v;
  return null;
}

function makeDb(seed: Record<string, any>) {
  const store = new Map<string, any>(Object.entries(seed));
  const updates: Array<{ id: string; data: any }> = [];
  const col = {
    orderBy(field: string) {
      return {
        limit(n: number) {
          return {
            get: async () => {
              const rows = [...store.entries()]
                .filter(([, data]) => fieldMs(data[field]) !== null)
                .sort((a, b) => (fieldMs(b[1][field]) as number) - (fieldMs(a[1][field]) as number))
                .slice(0, n)
                .map(([id, data]) => ({ id, data: () => data }));
              return { docs: rows, empty: rows.length === 0 };
            },
          };
        },
      };
    },
    doc(id: string) {
      return {
        id,
        update: async (data: any) => {
          if (!store.has(id)) throw new Error('No document to update');
          store.set(id, { ...store.get(id), ...data });
          updates.push({ id, data });
        },
      };
    },
  };
  const db = {
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (uid: string) => {
          if (uid !== UID) throw new Error(`unexpected uid ${uid}`);
          return { collection: (sub: string) => (sub === 'notifications' ? col : (() => { throw new Error('bad sub'); })()) };
        },
      };
    },
  };
  return { db, store, updates };
}

function makeAdapter(overrides: Partial<NotificationsSupaAdapter> = {}) {
  const calls = {
    setDoc: [] as any[],
    updateDoc: [] as any[],
    deleteDoc: [] as any[],
    listDocs: [] as any[],
  };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => { calls.setDoc.push(args); },
    updateDoc: async (...args: any[]) => { calls.updateDoc.push(args); },
    deleteDoc: async (...args: any[]) => { calls.deleteDoc.push(args); },
    listDocs: async (...args: any[]) => { calls.listDocs.push(args); return []; },
    ...overrides,
  };
  return { adapter, calls };
}

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Badge count exactly as the bell computes it: over a GET payload. */
async function badgeCount(): Promise<number> {
  const res = await GET(req('GET', 'http://x/api/notifications'));
  expect(res.status).toBe(200);
  const body = await res.json();
  return notificationUnreadCount(body.notifications);
}

// Both writer families, as they exist in production: the service/tasks
// family spells isRead, the shared-helper/webhooks family spells read
// and carries no isRead field at all.
const MIXED_SEED = {
  'svc-1': { title: 'Task assigned', isRead: false, createdAt: ts('2026-10-24T10:00:00.000Z') },
  'hlp-1': { title: 'Task Completed!', read: false, createdAt: ts('2026-10-25T09:00:00.000Z') },
  'old-1': { title: 'Already read', isRead: true, createdAt: ts('2026-10-23T08:00:00.000Z') },
};

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  verifyMock.mockReset();
  verifyMock.mockResolvedValue({ uid: UID });
  dbHolder.db = null;
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
});

/* ------------------------------------------------------- predicate truth table */

describe('normalized read-state predicate', () => {
  it('read iff either spelling is exactly true; missing/false/non-boolean is unread', () => {
    expect(isNotificationRead({ isRead: true })).toBe(true);
    expect(isNotificationRead({ read: true })).toBe(true);
    // Old single-mark residue: isRead true, read still false.
    expect(isNotificationRead({ isRead: true, read: false })).toBe(true);
    expect(isNotificationRead({ read: true, isRead: false })).toBe(true);
    expect(isNotificationRead({ isRead: false })).toBe(false);
    expect(isNotificationRead({ read: false })).toBe(false);
    expect(isNotificationRead({})).toBe(false);
    expect(isNotificationRead({ isRead: 'true' as any })).toBe(false);
    expect(isNotificationRead(null)).toBe(false);
    expect(isNotificationRead(undefined)).toBe(false);
    expect(isNotificationUnread({ read: false })).toBe(true);
    expect(isNotificationUnread({ isRead: true })).toBe(false);
  });

  it('the mark payload sets both spellings', () => {
    expect({ ...MARK_NOTIFICATION_READ_UPDATE }).toEqual({ isRead: true, read: true });
  });

  it('badge count counts both families and neither read doc', () => {
    expect(notificationUnreadCount([
      { isRead: false },
      { read: false },
      { isRead: true },
      { read: true },
      {},
    ])).toBe(3);
    expect(notificationUnreadCount(null)).toBe(0);
  });
});

/* ------------------------------------------- REPRODUCE: mark-all, both spellings */

describe('REPRODUCE (MSG30): mark-all-read across both spellings', () => {
  it('PATCH { all: true } clears the isRead doc AND the read doc', async () => {
    const { db, store } = makeDb(MIXED_SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { all: true }));
    expect(res.status).toBe(200);
    // Pre-fix this was 1: only the isRead doc was selected.
    await expect(res.json()).resolves.toEqual({ ok: true, updated: 2 });
    // Both spellings true on both docs: no reader of either spelling
    // can see a marked doc as unread again.
    expect(store.get('svc-1')).toMatchObject({ isRead: true, read: true });
    expect(store.get('hlp-1')).toMatchObject({ isRead: true, read: true });
    expect(store.get('old-1').isRead).toBe(true);
    expect(notificationUnreadCount([...store.values()])).toBe(0);
  });

  it('single mark on a read-family doc sets both spellings', async () => {
    const { db, store } = makeDb(MIXED_SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { id: 'hlp-1' }));
    expect(res.status).toBe(200);
    expect(store.get('hlp-1')).toMatchObject({ isRead: true, read: true });
    expect(store.get('svc-1').isRead).toBe(false);
  });
});

/* ------------------------------------------- LIVE PROOF: the founder's scenario */

describe('LIVE PROOF (MSG30): mark all -> zero -> reload -> zero -> one new -> exactly 1', () => {
  it('runs the whole scenario against one persistent store', async () => {
    const { db, store } = makeDb(MIXED_SEED);
    dbHolder.db = db;

    // Badge before: two unread (one per spelling family).
    expect(await badgeCount()).toBe(2);

    // Mark all read.
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { all: true }));
    expect(res.status).toBe(200);

    // Badge zero.
    expect(await badgeCount()).toBe(0);

    // Reload: a FRESH GET against the same store (new mount, same
    // backend — the production reload). Still zero: the mark stuck.
    expect(await badgeCount()).toBe(0);

    // One new notification arrives, written in the historically broken
    // spelling (the shared helper's shape: read false, no isRead).
    store.set('hlp-2', {
      title: 'Task Completed!',
      read: false,
      createdAt: ts('2026-11-03T06:00:00.000Z'),
    });

    // Badge exactly 1 — not 0 (a dropped new item) and not 2 (a stale mark).
    expect(await badgeCount()).toBe(1);
  });
});

/* ------------------------------------------- seam path: same filter, same payload */

describe('seam path: mark-all selects both spellings from the seam list', () => {
  it('PATCH { all: true } with the surface ON updates both families + mirrors dual', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    adapter.listDocs = async (...args: any[]) => {
      calls.listDocs.push(args);
      return [
        { id: 'svc-1', title: 'Task assigned', isRead: false, createdAt: '2026-10-24T10:00:00.000Z' },
        { id: 'hlp-1', title: 'Task Completed!', read: false, createdAt: '2026-10-25T09:00:00.000Z' },
        { id: 'old-1', title: 'Already read', isRead: true, createdAt: '2026-10-23T08:00:00.000Z' },
      ];
    };
    setNotificationsSupaAdapterForTests(adapter);
    const { db, store } = makeDb(MIXED_SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { all: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, updated: 2 });
    expect(calls.updateDoc.map((c: any[]) => c[1]).sort()).toEqual(['hlp-1', 'svc-1']);
    for (const call of calls.updateDoc) {
      expect(call[2]).toEqual({ isRead: true, read: true });
    }
    expect(store.get('hlp-1')).toMatchObject({ isRead: true, read: true });
  });
});

/* ------------------------------------------- static pins: no bare isRead-only filter left */

describe('static pins: the bell read path has no isRead-only filter left', () => {
  const src = (rel: string) =>
    readFileSync(join(__dirname, rel), 'utf8');

  it('route, bell, hook, and page never filter on isRead alone', () => {
    for (const rel of [
      '../../../../app/api/notifications/route.ts',
      '../../../../components/notifications/notification-center.tsx',
      '../../../../lib/notifications-supa-client.ts',
      '../../../../app/notifications/page.tsx',
    ]) {
      expect(src(rel)).not.toMatch(/\.isRead === false/);
    }
  });

  it('route, bell, and hook all read through the normalized helper', () => {
    expect(src('../../../../app/api/notifications/route.ts')).toContain('notification-read-state');
    expect(src('../../../../components/notifications/notification-center.tsx')).toContain('notification-read-state');
    expect(src('../../../../lib/notifications-supa-client.ts')).toContain('notification-read-state');
    expect(src('../../../../app/notifications/page.tsx')).toContain('notification-read-state');
  });
});
