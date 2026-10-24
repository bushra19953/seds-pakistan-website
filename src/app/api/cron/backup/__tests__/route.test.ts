/**
 * @jest-environment node
 *
 * Tests for GET/POST /api/cron/backup read-reduction wrapper
 * (Workstream C read-burn fix). All Firestore access is mocked:
 * no test touches a real database. The engine itself is mocked so the
 * tests exercise the exact `db` object the route hands to runBackup.
 */

import { NextRequest } from 'next/server';

type FakeDoc = { id: string; data: Record<string, unknown> };

interface Counters {
  unboundedGets: number;
  countGets: number;
  pages: Array<{ limit: number | null; returned: number }>;
}

function makeSnap(doc: FakeDoc) {
  return { id: doc.id, data: () => doc.data };
}

/** Firestore-like reference: count() + orderBy/limit/startAfter + get(). */
function makeFirestoreLikeRef(docs: FakeDoc[], counters: Counters) {
  const sorted = [...docs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const makeQuery = (cursorId: string | null, limitN: number | null): any => ({
    orderBy: (_field: string) => makeQuery(cursorId, limitN),
    limit: (n: number) => makeQuery(cursorId, n),
    startAfter: (snap: { id: string }) => makeQuery(snap.id, limitN),
    get: async () => {
      const after = cursorId
        ? sorted.filter((d) => d.id > cursorId)
        : sorted;
      const slice = limitN === null ? after : after.slice(0, limitN);
      counters.pages.push({ limit: limitN, returned: slice.length });
      return { docs: slice.map(makeSnap) };
    },
  });
  return {
    get: async () => {
      counters.unboundedGets += 1;
      return { docs: sorted.map(makeSnap) };
    },
    count: () => ({
      get: async () => {
        counters.countGets += 1;
        return { data: () => ({ count: sorted.length }) };
      },
    }),
    orderBy: (_field: string) => makeQuery(null, null),
    limit: (n: number) => makeQuery(null, n),
    startAfter: (snap: { id: string }) => makeQuery(snap.id, null),
  };
}

const mockState: {
  collections: Record<string, { ref: unknown }>;
  counters: Record<string, Counters>;
  runCollections: string[];
  capturedDocs: Record<string, string[]>;
} = {
  collections: {},
  counters: {},
  runCollections: [],
  capturedDocs: {},
};

function freshCounters(): Counters {
  return { unboundedGets: 0, countGets: 0, pages: [] };
}

jest.mock('@/lib/backup/engine', () => ({
  createDefaultBackupDeps: jest.fn(() => ({
    db: {
      collection: (name: string) => mockState.collections[name].ref,
    },
    uploadToDrive: jest.fn(async () => ({ fileId: 'drive-1' })),
    writeRunRecord: jest.fn(async () => undefined),
    writeAudit: jest.fn(async () => undefined),
  })),
  runBackup: jest.fn(async (deps: any) => {
    let documents = 0;
    for (const name of mockState.runCollections) {
      const snap = await deps.db.collection(name).get();
      mockState.capturedDocs[name] = snap.docs.map((d: any) => d.id);
      documents += snap.docs.length;
    }
    return {
      runId: 'backup_test_run',
      status: 'success',
      totals: {
        collections: mockState.runCollections.length,
        documents,
        bytes: 0,
      },
    };
  }),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => false),
}));

import { GET } from '../route';

function cronRequest() {
  return new NextRequest('http://localhost/api/cron/backup', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
}

function docs(n: number, prefix = 'd'): FakeDoc[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(i).padStart(5, '0')}`,
    data: { i },
  }));
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  mockState.collections = {};
  mockState.counters = {};
  mockState.runCollections = [];
  mockState.capturedDocs = {};
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/backup read-reduction wrapper', () => {
  it('skips the document get() entirely for an empty collection', async () => {
    const counters = freshCounters();
    mockState.collections['empty_coll'] = {
      ref: makeFirestoreLikeRef([], counters),
    };
    mockState.counters['empty_coll'] = counters;
    mockState.runCollections = ['empty_coll'];

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      runId: 'backup_test_run',
      status: 'success',
      collections: 1,
      documents: 0,
    });
    expect(counters.countGets).toBe(1);
    expect(counters.unboundedGets).toBe(0);
    expect(counters.pages).toEqual([]);
    expect(mockState.capturedDocs['empty_coll']).toEqual([]);
  });

  it('reads a large collection in bounded pages, never unbounded', async () => {
    const counters = freshCounters();
    const all = docs(1200);
    mockState.collections['big_coll'] = {
      ref: makeFirestoreLikeRef(all, counters),
    };
    mockState.runCollections = ['big_coll'];

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toBe(1200);
    expect(counters.unboundedGets).toBe(0);
    expect(counters.countGets).toBe(1);
    // 500 + 500 + 200, every page bounded at 500.
    expect(counters.pages.map((p) => p.returned)).toEqual([500, 500, 200]);
    expect(counters.pages.every((p) => (p.limit ?? 0) <= 500)).toBe(true);
    // Same document set, in document-id order, as an unbounded get().
    expect(mockState.capturedDocs['big_coll']).toEqual(all.map((d) => d.id));
  });

  it('does not issue an extra empty page at an exact page multiple', async () => {
    const counters = freshCounters();
    mockState.collections['exact_coll'] = {
      ref: makeFirestoreLikeRef(docs(1000), counters),
    };
    mockState.runCollections = ['exact_coll'];

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).documents).toBe(1000);
    expect(counters.pages.map((p) => p.returned)).toEqual([500, 500]);
  });

  it('falls back to a single get() for a plain get()-only reference', async () => {
    let gets = 0;
    const plain = docs(3, 'p');
    mockState.collections['plain_coll'] = {
      ref: {
        get: async () => {
          gets += 1;
          return { docs: plain.map(makeSnap) };
        },
      },
    };
    mockState.runCollections = ['plain_coll'];

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).documents).toBe(3);
    expect(gets).toBe(1);
    expect(mockState.capturedDocs['plain_coll']).toEqual(['p00000', 'p00001', 'p00002']);
  });

  it('falls back to document reads when count() fails', async () => {
    const counters = freshCounters();
    const base = makeFirestoreLikeRef(docs(3, 'c'), counters) as any;
    base.count = () => ({
      get: async () => {
        throw new Error('count unavailable');
      },
    });
    mockState.collections['count_fail_coll'] = { ref: base };
    mockState.runCollections = ['count_fail_coll'];

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).documents).toBe(3);
    expect(mockState.capturedDocs['count_fail_coll']).toEqual([
      'c00000',
      'c00001',
      'c00002',
    ]);
  });

  it('memoises a collection within a run: a second get() re-reads nothing', async () => {
    const counters = freshCounters();
    mockState.collections['users'] = {
      ref: makeFirestoreLikeRef(docs(10, 'u'), counters),
    };
    // Engine asking for the same collection twice in one run.
    mockState.runCollections = ['users', 'users'];

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(counters.countGets).toBe(1);
    expect(counters.unboundedGets).toBe(0);
    expect(counters.pages.map((p) => p.returned)).toEqual([10]);
    expect(mockState.capturedDocs['users']).toHaveLength(10);
  });

  it('keeps the pre-fix auth behaviour: no cron secret, no auth, 401', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/cron/backup', { method: 'GET' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});
