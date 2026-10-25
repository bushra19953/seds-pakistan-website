/**
 * @jest-environment node
 *
 * E4 public-events seam + route contracts (mocked adapter; zero live
 * reads):
 *  - Flag OFF -> every helper reports "unavailable" (null) and the
 *    adapter is never touched; the route answers 503 so clients keep
 *    their Firestore path byte-identically.
 *  - Flag ON -> reads come from the adapter with the exact query
 *    shapes of the current Firestore surfaces: list = createdAt desc,
 *    limit 12, NO where (E-LST-01, cap before client filtering);
 *    workshops = type/status where, limit 3; feed = status where,
 *    limit 10.
 *  - Timestamps are normalized at the seam into Timestamp-like
 *    objects, and serialized to ISO strings for the route's wire
 *    response (toPublicJson).
 *  - Adapter errors fall back (null / 503) instead of throwing.
 */

import {
  publicEventsSupaEnabled,
  publicEventsSupaClientEnabled,
  supaSurfaceEnabled,
  setPublicEventsAdapterForTests,
  listPublicEvents,
  listWorkshops,
  listHomepageFeed,
  normalizeSupaData,
  toPublicJson,
  type PublicEventsSupaAdapter,
  type TimestampLike,
} from '../public-events';
import { GET } from '@/app/api/events/public/route';

const savedSurfaces = process.env.SUPA_SURFACES;
const savedHint = process.env.NEXT_PUBLIC_SUPA_SURFACES;

function setSurfaces(raw: string | undefined) {
  if (raw === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = raw;
}
function setHint(raw: string | undefined) {
  if (raw === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  else process.env.NEXT_PUBLIC_SUPA_SURFACES = raw;
}

function makeAdapter(overrides: Partial<PublicEventsSupaAdapter> = {}): PublicEventsSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

function fakeRequest(url: string) {
  return { nextUrl: new URL(url) } as any;
}

beforeEach(() => {
  setPublicEventsAdapterForTests(undefined);
  setSurfaces(undefined);
  setHint(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setPublicEventsAdapterForTests(undefined);
  setSurfaces(savedSurfaces);
  setHint(savedHint);
  jest.restoreAllMocks();
});

describe('flag parsing', () => {
  it("defaults OFF when SUPA_SURFACES is unset; '*' and case/space variants enable 'events'", () => {
    expect(publicEventsSupaEnabled()).toBe(false);
    setSurfaces('tasks,users');
    expect(publicEventsSupaEnabled()).toBe(false);
    setSurfaces(' Events , other');
    expect(publicEventsSupaEnabled()).toBe(true);
    setSurfaces('*');
    expect(supaSurfaceEnabled('events')).toBe(true);
  });

  it('client hint reads NEXT_PUBLIC_SUPA_SURFACES only', () => {
    expect(publicEventsSupaClientEnabled()).toBe(false);
    setSurfaces('events');
    expect(publicEventsSupaClientEnabled()).toBe(false);
    setHint('events');
    expect(publicEventsSupaClientEnabled()).toBe(true);
  });
});

describe('seam read helpers', () => {
  it('flag OFF: all helpers return null and never touch the adapter', async () => {
    const adapter = makeAdapter();
    setPublicEventsAdapterForTests(adapter);
    await expect(listPublicEvents()).resolves.toBeNull();
    await expect(listWorkshops()).resolves.toBeNull();
    await expect(listHomepageFeed()).resolves.toBeNull();
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('E-LST-01: listPublicEvents queries events with orderBy createdAt desc, limit 12, and NO where', async () => {
    setSurfaces('events');
    const adapter = makeAdapter();
    setPublicEventsAdapterForTests(adapter);
    await listPublicEvents();
    expect(adapter.listDocs).toHaveBeenCalledTimes(1);
    const [path, options] = (adapter.listDocs as jest.Mock).mock.calls[0];
    expect(path).toBe('events');
    expect(options).toEqual({ orderBy: { field: 'createdAt', direction: 'desc' }, limit: 12 });
    expect(options).not.toHaveProperty('where');
  });

  it('listWorkshops reproduces the section query: type+status where, limit 3', async () => {
    setSurfaces('events');
    const adapter = makeAdapter();
    setPublicEventsAdapterForTests(adapter);
    await listWorkshops();
    expect(adapter.listDocs).toHaveBeenCalledWith('events', {
      where: [
        ['type', '==', 'workshop'],
        ['status', '==', 'published'],
      ],
      limit: 3,
    });
  });

  it('listHomepageFeed reproduces the feed query: status where, limit 10', async () => {
    setSurfaces('events');
    const adapter = makeAdapter();
    setPublicEventsAdapterForTests(adapter);
    await listHomepageFeed();
    expect(adapter.listDocs).toHaveBeenCalledWith('events', {
      where: [['status', '==', 'published']],
      limit: 10,
    });
  });

  it('flag ON: rows are returned with timestamps normalized to Timestamp-like', async () => {
    setSurfaces('events');
    setPublicEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => [
          {
            id: 'ev1',
            title: 'Space Talk',
            createdAt: '2026-10-01T10:00:00.250Z',
            startAt: { _seconds: 1760000000, _nanoseconds: 500000000 },
          },
        ]),
      }),
    );
    const rows = await listPublicEvents();
    expect(rows).toHaveLength(1);
    const createdAt = rows?.[0].createdAt as TimestampLike;
    expect(createdAt.toMillis()).toBe(Date.parse('2026-10-01T10:00:00.250Z'));
    const startAt = rows?.[0].startAt as TimestampLike;
    expect(startAt.seconds).toBe(1760000000);
    expect(startAt.toDate().getTime()).toBe(1760000000500);
  });

  it('adapter error: returns null (Firestore fallback), never throws', async () => {
    setSurfaces('events');
    setPublicEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => {
          throw new Error('supa down');
        }),
      }),
    );
    await expect(listPublicEvents()).resolves.toBeNull();
    await expect(listWorkshops()).resolves.toBeNull();
    await expect(listHomepageFeed()).resolves.toBeNull();
  });
});

describe('normalizeSupaData / toPublicJson', () => {
  it('leaves non-instant strings and {seconds}-only objects untouched', () => {
    expect(normalizeSupaData('Space Talk')).toBe('Space Talk');
    expect(normalizeSupaData({ seconds: 5 })).toEqual({ seconds: 5 });
    expect(normalizeSupaData(42)).toBe(42);
    expect(normalizeSupaData(null)).toBeNull();
  });

  it('toPublicJson serializes Timestamp-likes to ISO strings, recursively', () => {
    const out = toPublicJson({
      createdAt: normalizeSupaData('2026-10-01T10:00:00.250Z'),
      nested: [{ at: normalizeSupaData({ _seconds: 10, _nanoseconds: 500000000 }) }],
      title: 'Talk',
    }) as any;
    expect(out.createdAt).toBe('2026-10-01T10:00:00.250Z');
    expect(out.nested[0].at).toBe('1970-01-01T00:00:10.500Z');
    expect(out.title).toBe('Talk');
    // The wire shape must survive a plain JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe('GET /api/events/public', () => {
  it('flag OFF: 503 supa_unavailable for every view, adapter untouched', async () => {
    const adapter = makeAdapter();
    setPublicEventsAdapterForTests(adapter);
    for (const view of ['list', 'workshops', 'feed']) {
      const res = await GET(fakeRequest(`http://x/api/events/public?view=${view}`));
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ error: 'supa_unavailable' });
    }
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('unknown view: 400', async () => {
    setSurfaces('events');
    const res = await GET(fakeRequest('http://x/api/events/public?view=bogus'));
    expect(res.status).toBe(400);
  });

  it('flag ON: 200 with a plain JSON array (no envelope), timestamps as ISO strings', async () => {
    setSurfaces('events');
    setPublicEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => [
          { id: 'ev1', title: 'Space Talk', status: 'published', createdAt: '2026-10-01T10:00:00.250Z' },
        ]),
      }),
    );
    const res = await GET(fakeRequest('http://x/api/events/public?view=list'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([
      { id: 'ev1', title: 'Space Talk', status: 'published', createdAt: '2026-10-01T10:00:00.250Z' },
    ]);
  });

  it('flag ON + adapter error: 503 (fallback contract), never a 500', async () => {
    setSurfaces('events');
    setPublicEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    const res = await GET(fakeRequest('http://x/api/events/public?view=feed'));
    expect(res.status).toBe(503);
  });

  it('default view is list', async () => {
    setSurfaces('events');
    const adapter = makeAdapter();
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(fakeRequest('http://x/api/events/public'));
    expect(res.status).toBe(200);
    expect(adapter.listDocs).toHaveBeenCalledWith('events', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 12,
    });
  });
});
