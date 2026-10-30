/**
 * @jest-environment node
 *
 * GET/PATCH/DELETE /api/notifications (notifications cluster G2).
 *
 * Auth is the shared verifySession helper (mocked); the Firestore side
 * is a hand-rolled double implementing the exact surface the route
 * uses, including Firestore's orderBy-drops-missing-field semantics so
 * the createdAt/timestamp union is genuinely exercised. The Supabase
 * side is a mocked adapter injected through the seam — no live reads.
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

import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/notifications/route';
import { verifySession, SessionError } from '@/lib/auth/verifySession';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

const UID = 'user-1';
const verifyMock = verifySession as jest.Mock;

/* ---------------------------------------------------------- firestore fake */

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
  const deletes: string[] = [];

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
        delete: async () => {
          store.delete(id);
          deletes.push(id);
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
  return { db, store, updates, deletes };
}

/* ------------------------------------------------------------- fake adapter */

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

const SEED = {
  'a-created': { title: 'Created family', isRead: false, createdAt: ts('2026-10-24T10:00:00.000Z') },
  'b-timestamp': { title: 'Timestamp family', isRead: false, timestamp: ts('2026-10-25T09:00:00.000Z') },
  'c-read': { title: 'Already read', isRead: true, createdAt: ts('2026-10-23T08:00:00.000Z') },
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

/* ---------------------------------------------------------------------- GET */

describe('GET /api/notifications', () => {
  it('401s when the session is missing/invalid', async () => {
    verifyMock.mockRejectedValue(new SessionError('Unauthorized: missing Bearer token', 401));
    const res = await GET(req('GET', 'http://x/api/notifications'));
    expect(res.status).toBe(401);
  });

  it('flag OFF: Firestore union read, listener shape, ISO timestamps, newest first', async () => {
    const { db } = makeDb(SEED);
    dbHolder.db = db;
    const res = await GET(req('GET', 'http://x/api/notifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Both timestamp families survive (a single-field orderBy would drop one).
    expect(body.notifications.map((n: any) => n.id)).toEqual(['b-timestamp', 'a-created', 'c-read']);
    expect(body.notifications[0]).toMatchObject({ id: 'b-timestamp', title: 'Timestamp family' });
    expect(body.notifications[0].timestamp).toBe('2026-10-25T09:00:00.000Z');
    expect(body.notifications[1].createdAt).toBe('2026-10-24T10:00:00.000Z');
  });

  it('flag OFF: ?limit caps the result', async () => {
    const { db } = makeDb(SEED);
    dbHolder.db = db;
    const res = await GET(req('GET', 'http://x/api/notifications?limit=2'));
    const body = await res.json();
    expect(body.notifications).toHaveLength(2);
  });

  it('flag ON: reads through the seam adapter, scoped to the caller path, Firestore untouched', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    adapter.listDocs = async (...args: any[]) => {
      calls.listDocs.push(args);
      return [{ id: 's1', title: 'From Supa', isRead: false, createdAt: '2026-10-25T11:00:00.000Z', timestamp: '2026-10-25T11:00:00.000Z' }];
    };
    setNotificationsSupaAdapterForTests(adapter);
    dbHolder.db = null; // would 500 if the route fell back to Firestore
    const res = await GET(req('GET', 'http://x/api/notifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toEqual([
      { id: 's1', title: 'From Supa', isRead: false, createdAt: '2026-10-25T11:00:00.000Z', timestamp: '2026-10-25T11:00:00.000Z' },
    ]);
    expect(calls.listDocs[0][0]).toBe('users/user-1/notifications');
  });

  it('flag ON but adapter errors: falls back to Firestore exactly', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter } = makeAdapter({
      listDocs: async () => { throw new Error('supa down'); },
    });
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = makeDb(SEED);
    dbHolder.db = db;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await GET(req('GET', 'http://x/api/notifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toHaveLength(3);
    (console.warn as jest.Mock).mockRestore();
  });

  it('500s when neither Supabase nor Firestore is available', async () => {
    const res = await GET(req('GET', 'http://x/api/notifications'));
    expect(res.status).toBe(500);
  });
});

/* -------------------------------------------------------------------- PATCH */

describe('PATCH /api/notifications', () => {
  it('marks one read in Firestore and mirrors the update when the flag is ON', async () => {
    process.env.SUPA_SURFACES = '*';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, store } = makeDb(SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { id: 'a-created' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, updated: 1 });
    expect(store.get('a-created').isRead).toBe(true);
    expect(calls.updateDoc).toEqual([
      ['users/user-1/notifications', 'a-created', { isRead: true }],
    ]);
  });

  it('flag OFF: marks one read with no adapter call', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, store } = makeDb(SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { id: 'b-timestamp' }));
    expect(res.status).toBe(200);
    expect(store.get('b-timestamp').isRead).toBe(true);
    expect(calls.updateDoc).toHaveLength(0);
  });

  it('404s when the notification does not exist', async () => {
    const { db } = makeDb(SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { id: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('mark-all mirrors NotificationCenter semantics: only isRead === false docs update', async () => {
    const { db, updates } = makeDb(SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { all: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, updated: 2 });
    expect(updates.map((u) => u.id).sort()).toEqual(['a-created', 'b-timestamp']);
  });

  it('mark-all with a healthy seam lists via the seam, not the Firestore list', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const seed = {
      's-unread': { title: 'Seam unread', isRead: false, createdAt: ts('2026-10-24T10:00:00.000Z') },
      's-read': { title: 'Seam read', isRead: true, createdAt: ts('2026-10-24T09:00:00.000Z') },
      // Present in Firestore but NOT in the seam's loaded window: if the
      // arm listed Firestore (the pre-fix behavior) this doc would be
      // marked and the count would be 2.
      'fs-only': { title: 'Firestore only', isRead: false, timestamp: ts('2026-10-25T09:00:00.000Z') },
    };
    const { adapter, calls } = makeAdapter();
    adapter.listDocs = async (...args: any[]) => {
      calls.listDocs.push(args);
      return [
        { id: 's-unread', title: 'Seam unread', isRead: false, createdAt: '2026-10-24T10:00:00.000Z' },
        { id: 's-read', title: 'Seam read', isRead: true, createdAt: '2026-10-24T09:00:00.000Z' },
      ];
    };
    setNotificationsSupaAdapterForTests(adapter);
    const { db, store, updates } = makeDb(seed);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { all: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, updated: 1 });
    expect(updates.map((u) => u.id)).toEqual(['s-unread']);
    expect(store.get('fs-only').isRead).toBe(false);
    expect(calls.listDocs.length).toBeGreaterThan(0);
    expect(calls.listDocs[0][0]).toBe('users/user-1/notifications');
  });

  it('400s on a body with neither id nor all', async () => {
    const { db } = makeDb(SEED);
    dbHolder.db = db;
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', {}));
    expect(res.status).toBe(400);
  });

  it('mirror failure never fails the request', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter } = makeAdapter({
      updateDoc: async () => { throw new Error('mirror down'); },
    });
    setNotificationsSupaAdapterForTests(adapter);
    const { db, store } = makeDb(SEED);
    dbHolder.db = db;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await PATCH(req('PATCH', 'http://x/api/notifications', { id: 'a-created' }));
    expect(res.status).toBe(200);
    expect(store.get('a-created').isRead).toBe(true);
    (console.warn as jest.Mock).mockRestore();
  });
});

/* ------------------------------------------------------------------- DELETE */

describe('DELETE /api/notifications', () => {
  it('deletes one doc from the caller subcollection and mirrors when ON', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, store, deletes } = makeDb(SEED);
    dbHolder.db = db;
    const res = await DELETE(req('DELETE', 'http://x/api/notifications?id=c-read'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, deleted: 'c-read' });
    expect(store.has('c-read')).toBe(false);
    expect(deletes).toEqual(['c-read']);
    expect(calls.deleteDoc).toEqual([['users/user-1/notifications', 'c-read']]);
  });

  it('accepts the id from a JSON body', async () => {
    const { db, store } = makeDb(SEED);
    dbHolder.db = db;
    const res = await DELETE(req('DELETE', 'http://x/api/notifications', { id: 'a-created' }));
    expect(res.status).toBe(200);
    expect(store.has('a-created')).toBe(false);
  });

  it('400s without an id', async () => {
    const { db } = makeDb(SEED);
    dbHolder.db = db;
    const res = await DELETE(req('DELETE', 'http://x/api/notifications'));
    expect(res.status).toBe(400);
  });
});
