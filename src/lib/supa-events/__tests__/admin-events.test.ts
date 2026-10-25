/**
 * @jest-environment node
 *
 * E5 admin-events seam contracts (mocked adapter; zero live reads):
 *  - Flag OFF for a surface -> every helper reports "unavailable" (null /
 *    no-op) and the adapter is never touched, so callers behave exactly
 *    as they do on Firestore today.
 *  - Flag ON -> reads come from the adapter, registrations are scoped to
 *    exactly one event (the fs_registrations parent qualification:
 *    parent_path='events/<eventId>', applied via the doc's eventId), and
 *    timestamps are normalized at the seam into Timestamp-like objects
 *    (the attendees CSV export reads `.seconds` off the rows).
 *  - Adapter errors fall back (null) instead of throwing into a caller.
 *  - Mirrors never throw and serialize Firestore sentinels/Dates to ISO.
 */

import {
  adminEventsSupaEnabled,
  settlementSupaEnabled,
  supaSurfaceEnabled,
  setAdminEventsAdapterForTests,
  getEventFromSupa,
  listRegistrationsFromSupa,
  mirrorRegistrationUpdate,
  normalizeSupaData,
  toSupaSerializable,
  type AdminEventsSupaAdapter,
  type TimestampLike,
} from '../admin-events';

const ENV_KEY = 'SUPA_SURFACES';
const savedEnv = process.env[ENV_KEY];

function setSurfaces(raw: string | undefined) {
  if (raw === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = raw;
}

function makeAdapter(overrides: Partial<AdminEventsSupaAdapter> = {}): AdminEventsSupaAdapter {
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

beforeEach(() => {
  setAdminEventsAdapterForTests(undefined);
  setSurfaces(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setAdminEventsAdapterForTests(undefined);
  setSurfaces(savedEnv);
  jest.restoreAllMocks();
});

describe('flag parsing', () => {
  it('defaults OFF for both surfaces when SUPA_SURFACES is unset', () => {
    expect(adminEventsSupaEnabled()).toBe(false);
    expect(settlementSupaEnabled()).toBe(false);
  });

  it('enables only the named surface', () => {
    setSurfaces('events-admin');
    expect(adminEventsSupaEnabled()).toBe(true);
    expect(settlementSupaEnabled()).toBe(false);
    setSurfaces('settlement');
    expect(adminEventsSupaEnabled()).toBe(false);
    expect(settlementSupaEnabled()).toBe(true);
  });

  it("'*' enables every surface; matching is case/space tolerant", () => {
    setSurfaces(' * ');
    expect(supaSurfaceEnabled('events-admin')).toBe(true);
    expect(supaSurfaceEnabled('settlement')).toBe(true);
    setSurfaces(' Events-Admin , other');
    expect(adminEventsSupaEnabled()).toBe(true);
  });
});

describe('getEventFromSupa', () => {
  it('flag OFF: returns null and never touches the adapter', async () => {
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    await expect(getEventFromSupa('ev1', 'settlement')).resolves.toBeNull();
    expect(adapter.getDoc).not.toHaveBeenCalled();
  });

  it('surfaces are independent: events-admin ON does not serve settlement', async () => {
    setSurfaces('events-admin');
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    await expect(getEventFromSupa('ev1', 'settlement')).resolves.toBeNull();
    expect(adapter.getDoc).not.toHaveBeenCalled();
    await expect(getEventFromSupa('ev1', 'events-admin')).resolves.toEqual({ found: false });
    expect(adapter.getDoc).toHaveBeenCalledWith('events', 'ev1');
  });

  it('flag ON + missing doc: authoritative not-found', async () => {
    setSurfaces('settlement');
    setAdminEventsAdapterForTests(makeAdapter({ getDoc: jest.fn(async () => null) }));
    await expect(getEventFromSupa('nope', 'settlement')).resolves.toEqual({ found: false });
  });

  it('flag ON + doc: data returned with timestamps normalized, id stripped from data', async () => {
    setSurfaces('settlement');
    setAdminEventsAdapterForTests(
      makeAdapter({
        getDoc: jest.fn(async () => ({
          id: 'ev1',
          title: 'Space Talk',
          profitSettlement: {
            status: 'draft',
            updatedAt: { _seconds: 1760000000, _nanoseconds: 250000000 },
          },
          createdAt: '2026-10-01T10:00:00.000Z',
        })),
      }),
    );
    const read = await getEventFromSupa('ev1', 'settlement');
    expect(read?.found).toBe(true);
    if (!read?.found) throw new Error('expected found');
    expect(read.data.title).toBe('Space Talk');
    expect('id' in read.data).toBe(false);
    const updatedAt = (read.data.profitSettlement as Record<string, unknown>).updatedAt as TimestampLike;
    expect(updatedAt.seconds).toBe(1760000000);
    expect(updatedAt.nanoseconds).toBe(250000000);
    expect(updatedAt.toDate().getTime()).toBe(1760000000250);
    const createdAt = read.data.createdAt as TimestampLike;
    expect(createdAt.toMillis()).toBe(Date.parse('2026-10-01T10:00:00.000Z'));
  });

  it('adapter error: returns null so the caller falls back to Firestore', async () => {
    setSurfaces('settlement');
    setAdminEventsAdapterForTests(
      makeAdapter({
        getDoc: jest.fn(async () => {
          throw new Error('supa down');
        }),
      }),
    );
    await expect(getEventFromSupa('ev1', 'settlement')).resolves.toBeNull();
  });
});

describe('listRegistrationsFromSupa (parent qualification)', () => {
  it('flag OFF: returns null and never touches the adapter', async () => {
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    await expect(listRegistrationsFromSupa('ev1')).resolves.toBeNull();
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('queries fs_registrations by eventId, newest first', async () => {
    setSurfaces('events-admin');
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    await listRegistrationsFromSupa('ev1');
    expect(adapter.listDocs).toHaveBeenCalledWith('registrations', {
      where: [['eventId', '==', 'ev1']],
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
  });

  it("returns only the requested event's rows even if the store over-returns", async () => {
    setSurfaces('events-admin');
    setAdminEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => [
          { id: 'uid-a', eventId: 'ev1', status: 'confirmed' },
          { id: 'uid-a', eventId: 'ev2', status: 'pending' },
          { id: 'uid-b', eventId: 'ev1', status: 'pending' },
        ]),
      }),
    );
    const rows = await listRegistrationsFromSupa('ev1');
    expect(rows).toHaveLength(2);
    expect(rows?.every((r) => r.eventId === 'ev1')).toBe(true);
    expect(rows?.map((r) => r.id)).toEqual(['uid-a', 'uid-b']);
  });

  it('normalizes createdAt/updatedAt so .seconds consumers (CSV export) work', async () => {
    setSurfaces('events-admin');
    setAdminEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => [
          {
            id: 'uid-a',
            eventId: 'ev1',
            createdAt: { _seconds: 1759000000, _nanoseconds: 0 },
            updatedAt: '2026-10-02T12:30:00.000Z',
          },
        ]),
      }),
    );
    const rows = await listRegistrationsFromSupa('ev1');
    const createdAt = rows?.[0].createdAt as TimestampLike;
    expect(createdAt.seconds).toBe(1759000000);
    expect(new Date(createdAt.seconds * 1000).toISOString()).toBe(
      new Date(1759000000 * 1000).toISOString(),
    );
    const updatedAt = rows?.[0].updatedAt as TimestampLike;
    expect(updatedAt.seconds).toBe(Math.floor(Date.parse('2026-10-02T12:30:00.000Z') / 1000));
  });

  it('adapter error: returns null (Firestore fallback), never throws', async () => {
    setSurfaces('events-admin');
    setAdminEventsAdapterForTests(
      makeAdapter({
        listDocs: jest.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    await expect(listRegistrationsFromSupa('ev1')).resolves.toBeNull();
  });
});

describe('mirrorRegistrationUpdate', () => {
  it('flag OFF: no adapter call', async () => {
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    await mirrorRegistrationUpdate('ev1', 'reg1', { status: 'confirmed' });
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });

  it('flag ON: mirrors the update with sentinels/Dates serialized to ISO', async () => {
    setSurfaces('events-admin');
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    const now = new Date('2026-10-25T05:00:00.000Z');
    await mirrorRegistrationUpdate('ev1', 'reg1', {
      status: 'confirmed',
      updatedAt: { _methodName: 'serverTimestamp' } as unknown,
      seenAt: now,
      dropped: undefined,
    });
    expect(adapter.updateDoc).toHaveBeenCalledWith('registrations', 'reg1', {
      status: 'confirmed',
      updatedAt: expect.any(String),
      seenAt: '2026-10-25T05:00:00.000Z',
    });
    const payload = (adapter.updateDoc as jest.Mock).mock.calls[0][2] as Record<string, unknown>;
    expect('dropped' in payload).toBe(false);
    expect(Number.isNaN(Date.parse(payload.updatedAt as string))).toBe(false);
  });

  it('adapter failure is swallowed (Firestore write already succeeded)', async () => {
    setSurfaces('events-admin');
    setAdminEventsAdapterForTests(
      makeAdapter({
        updateDoc: jest.fn(async () => {
          throw new Error('mirror down');
        }),
      }),
    );
    await expect(
      mirrorRegistrationUpdate('ev1', 'reg1', { status: 'cancelled' }),
    ).resolves.toBeUndefined();
  });
});

describe('normalizeSupaData / toSupaSerializable', () => {
  it('leaves non-instant strings and {seconds}-only objects untouched', () => {
    expect(normalizeSupaData('Space Talk')).toBe('Space Talk');
    expect(normalizeSupaData({ seconds: 5 })).toEqual({ seconds: 5 });
    expect(normalizeSupaData(42)).toBe(42);
    expect(normalizeSupaData(null)).toBeNull();
  });

  it('converts {seconds,nanoseconds} serialized timestamps, recursively', () => {
    const out = normalizeSupaData({
      nested: [{ at: { seconds: 10, nanoseconds: 500000000 } }],
    }) as { nested: Array<{ at: TimestampLike }> };
    expect(out.nested[0].at.seconds).toBe(10);
    expect(out.nested[0].at.toMillis()).toBe(10500);
  });

  it('toSupaSerializable drops undefined and converts Timestamp-likes via toDate()', () => {
    const out = toSupaSerializable({
      a: undefined,
      b: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
      c: [new Date('2026-01-02T00:00:00.000Z')],
    }) as Record<string, unknown>;
    expect(out).toEqual({ b: '2026-01-01T00:00:00.000Z', c: ['2026-01-02T00:00:00.000Z'] });
  });
});
