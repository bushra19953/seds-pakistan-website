/**
 * @jest-environment node
 *
 * Unit tests for the events Supabase seam (src/lib/supa-events/server-events).
 * The adapter is MOCKED (injected via setEventsSupaAdapterForTests); there
 * are zero live Firestore or Supabase calls in this suite.
 *
 * Covered contract:
 * - Flag OFF (default): reads report "unavailable" (null) and mirrors no-op,
 *   so callers run Firestore byte-identically.
 * - Flag ON + adapter answers: reads come back with timestamps normalized
 *   to Timestamp-like shapes at the seam.
 * - Flag ON + adapter missing/null or throwing: "unavailable" fallback.
 * - Mirrors serialize FieldValue sentinels / Dates / Timestamp-likes to ISO
 *   strings and never throw on adapter failure.
 */

import {
  eventsSupaEnabled,
  getEventByIdFromSupa,
  mirrorDocUpdate,
  mirrorDocWrite,
  normalizeSupaData,
  setEventsSupaAdapterForTests,
  toSupaSerializable,
  type EventsSupaAdapter,
  type TimestampLike,
} from '../server-events';

const ORIGINAL_ENV = process.env.SUPA_SURFACES;

function mockAdapter(overrides: Partial<EventsSupaAdapter> = {}): EventsSupaAdapter {
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
  delete process.env.SUPA_SURFACES;
  setEventsSupaAdapterForTests(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_ENV;
  setEventsSupaAdapterForTests(undefined);
  jest.restoreAllMocks();
});

describe('flag parsing', () => {
  it('is OFF by default and for unrelated surfaces', () => {
    expect(eventsSupaEnabled()).toBe(false);
    process.env.SUPA_SURFACES = 'announcements,directory';
    expect(eventsSupaEnabled()).toBe(false);
  });

  it('is ON for events, case-insensitively, and for *', () => {
    process.env.SUPA_SURFACES = ' Events ';
    expect(eventsSupaEnabled()).toBe(true);
    process.env.SUPA_SURFACES = '*';
    expect(eventsSupaEnabled()).toBe(true);
  });
});

describe('getEventByIdFromSupa', () => {
  it('flag OFF: returns null (Firestore fallback) without touching the adapter', async () => {
    const adapter = mockAdapter();
    setEventsSupaAdapterForTests(adapter);
    await expect(getEventByIdFromSupa('ev-1')).resolves.toBeNull();
    expect(adapter.getDoc).not.toHaveBeenCalled();
  });

  it('flag ON + adapter null: returns null (unconfigured fallback)', async () => {
    process.env.SUPA_SURFACES = 'events';
    setEventsSupaAdapterForTests(null);
    await expect(getEventByIdFromSupa('ev-1')).resolves.toBeNull();
  });

  it('flag ON + adapter throws: returns null (error fallback), never rejects', async () => {
    process.env.SUPA_SURFACES = 'events';
    setEventsSupaAdapterForTests(
      mockAdapter({ getDoc: jest.fn(async () => { throw new Error('pg down'); }) }),
    );
    await expect(getEventByIdFromSupa('ev-1')).resolves.toBeNull();
  });

  it('flag ON + doc missing: authoritative not-found', async () => {
    process.env.SUPA_SURFACES = 'events';
    setEventsSupaAdapterForTests(mockAdapter());
    await expect(getEventByIdFromSupa('nope')).resolves.toEqual({ found: false });
  });

  it('flag ON + doc present: data returned with ISO strings normalized to Timestamp-like', async () => {
    process.env.SUPA_SURFACES = 'events';
    const adapter = mockAdapter({
      getDoc: jest.fn(async () => ({
        id: 'ev-1',
        title: 'Launch Night',
        startAt: '2026-11-01T14:00:00.000Z',
        createdAt: { _seconds: 1793431200, _nanoseconds: 500000000 },
        tags: ['a'],
        schedule: [{ at: '2026-11-01T15:30:00Z' }],
        note: '2026-11-01 is the date', // not an instant: untouched
      })),
    });
    setEventsSupaAdapterForTests(adapter);

    const result = await getEventByIdFromSupa('ev-1');
    expect(result?.found).toBe(true);
    if (!result?.found) throw new Error('expected found');
    expect(adapter.getDoc).toHaveBeenCalledWith('events', 'ev-1');
    expect(result.data.title).toBe('Launch Night');
    expect(result.data.id).toBeUndefined(); // adapter's {id, ...data} envelope stripped

    const startAt = result.data.startAt as TimestampLike;
    expect(startAt.seconds).toBe(Date.parse('2026-11-01T14:00:00.000Z') / 1000);
    expect(startAt.nanoseconds).toBe(0);
    expect(startAt.toDate().toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(startAt.toMillis()).toBe(Date.parse('2026-11-01T14:00:00.000Z'));

    const createdAt = result.data.createdAt as TimestampLike;
    expect(createdAt.seconds).toBe(1793431200);
    expect(createdAt.nanoseconds).toBe(500000000);
    expect(createdAt.toMillis()).toBe(1793431200500);

    const schedule = result.data.schedule as Array<{ at: TimestampLike }>;
    expect(schedule[0].at.toDate().toISOString()).toBe('2026-11-01T15:30:00.000Z');
    expect(result.data.note).toBe('2026-11-01 is the date');
  });
});

describe('normalizeSupaData', () => {
  it('converts {seconds,nanoseconds} serialized timestamps and leaves plain data alone', () => {
    const out = normalizeSupaData({
      when: { seconds: 1700000000, nanoseconds: 250000000 },
      count: 3,
      plainSeconds: { seconds: 5 }, // not a serialized timestamp shape
      ok: true,
      nothing: null,
    }) as Record<string, unknown>;
    expect((out.when as TimestampLike).toMillis()).toBe(1700000000250);
    expect(out.plainSeconds).toEqual({ seconds: 5 });
    expect(out.count).toBe(3);
    expect(out.nothing).toBeNull();
  });

  it('feeds src/lib/events/datetime consumers: toDate()/seconds both resolve the instant', () => {
    // eventInstantToMs accepts toMillis/toDate/{seconds}; assert the seam
    // shape satisfies the toDate + seconds paths without importing datetime
    // semantics changes.
    const ts = normalizeSupaData('2026-10-25T07:00:00.000Z') as unknown as TimestampLike;
    expect(ts.toDate().getTime()).toBe(Date.parse('2026-10-25T07:00:00.000Z'));
    expect(ts.seconds * 1000 + ts.nanoseconds / 1e6).toBe(ts.toMillis());
  });
});

describe('mirror writes', () => {
  it('flag OFF: mirrors are no-ops', async () => {
    const adapter = mockAdapter();
    setEventsSupaAdapterForTests(adapter);
    await mirrorDocWrite('events', 'ev-1', { broadcasted: true });
    await mirrorDocUpdate('events', 'ev-1', { broadcasted: true });
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });

  it('flag ON: setDoc mirror serializes sentinels, Dates and Timestamp-likes to ISO', async () => {
    process.env.SUPA_SURFACES = 'events';
    const adapter = mockAdapter();
    setEventsSupaAdapterForTests(adapter);
    const sentinel = { _methodName: 'FieldValue.serverTimestamp' };
    await mirrorDocWrite(
      'announcements',
      'evt_promo_ev-1',
      {
        publish_date: sentinel,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        deadline: { toDate: () => new Date('2026-11-20T00:00:00.000Z') },
        title: 'Hi',
        missing: undefined,
      },
      { merge: true },
    );
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    const [collection, id, data, opts] = (adapter.setDoc as jest.Mock).mock.calls[0];
    expect(collection).toBe('announcements');
    expect(id).toBe('evt_promo_ev-1');
    expect(opts).toEqual({ merge: true });
    expect(typeof data.publish_date).toBe('string');
    expect(Number.isNaN(Date.parse(data.publish_date))).toBe(false);
    expect(data.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(data.deadline).toBe('2026-11-20T00:00:00.000Z');
    expect(data.title).toBe('Hi');
    expect('missing' in data).toBe(false);
  });

  it('flag ON: adapter failure is swallowed (Firestore stays primary)', async () => {
    process.env.SUPA_SURFACES = 'events';
    setEventsSupaAdapterForTests(
      mockAdapter({
        setDoc: jest.fn(async () => { throw new Error('pg down'); }),
        updateDoc: jest.fn(async () => { throw new Error('pg down'); }),
      }),
    );
    await expect(mirrorDocWrite('events', 'ev-1', { a: 1 })).resolves.toBeUndefined();
    await expect(mirrorDocUpdate('events', 'ev-1', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('toSupaSerializable', () => {
  it('uses the supplied instant for every sentinel in one payload', () => {
    const now = new Date('2026-10-25T05:00:00.000Z');
    const out = toSupaSerializable(
      { a: { _methodName: 'x' }, b: [{ _methodName: 'y' }] },
      now,
    ) as Record<string, unknown>;
    expect(out.a).toBe('2026-10-25T05:00:00.000Z');
    expect((out.b as unknown[])[0]).toBe('2026-10-25T05:00:00.000Z');
  });
});
