/**
 * @jest-environment node
 *
 * PARITY AUDIT E4 (independent test author; NOT the implementer).
 * Branch feat/supa-events-4, commits 901597e (seam + public route) and
 * 23a1417 (client wiring). Zero live reads: the adapter is injected
 * through the seam's own test point (setPublicEventsAdapterForTests).
 *
 * What is pinned, against VERIFICATION_SPEC.md and the contracts on
 * test/supa-events-contracts:
 *  - the public route's three views issue the exact query shapes of
 *    the Firestore originals (E-LST-01: list = orderBy createdAt desc
 *    + limit 12 + NO where; workshops = wheres type/status + limit 3;
 *    feed = where status + limit 10), all on collection 'events';
 *  - flag OFF / adapter-unconfigured / adapter-error all answer
 *    503 { error: 'supa_unavailable' } and never throw (spec section 7
 *    checklist item 1: fallback fires, nothing surfaces);
 *  - the local flag parser reproduces the S-FLAG-01 semantics
 *    (default OFF; 'events' or '*' enables; case/space tolerant);
 *  - adapter row order is preserved end to end (no re-sort);
 *  - the S-TS timestamp-shape matrix through the seam's normalized
 *    consumers: the same instant stored as an ISO string, as
 *    { _seconds, _nanoseconds }, and as { seconds, nanoseconds }
 *    leaves the route as the IDENTICAL ISO string, renders through
 *    the datetime oracle identically to the Firestore Timestamp
 *    rendering, including the PKT-midnight boundary instant;
 *  - normalizeSupaData widens only genuine timestamp shapes: plain
 *    strings, numbers, and objects with extra keys pass through.
 */

import { GET } from '@/app/api/events/public/route';
import {
  listPublicEvents,
  normalizeSupaData,
  publicEventsSupaEnabled,
  setPublicEventsAdapterForTests,
  supaSurfaceEnabled,
  toPublicJson,
  type PublicEventsSupaAdapter,
} from '@/lib/supa-events/public-events';
import { formatEventInstantInPkt } from '@/lib/events/datetime';

const req = (qs: string) =>
  ({ nextUrl: new URL(`http://localhost/api/events/public${qs}`) }) as any;

/** 2026-11-01T05:00:00.000Z — a Sunday, 10:00 PKT. */
const INSTANT_MS = Date.UTC(2026, 10, 1, 5, 0, 0);
const INSTANT_ISO = '2026-11-01T05:00:00.000Z';
const INSTANT_SECONDS = Math.floor(INSTANT_MS / 1000);
/** 2026-10-31T19:00:00.000Z = 2026-11-01 00:00 PKT exactly (midnight boundary). */
const BOUNDARY_ISO = '2026-10-31T19:00:00.000Z';
const BOUNDARY_SECONDS = Math.floor(Date.parse(BOUNDARY_ISO) / 1000);

function firestoreTimestamp(seconds: number, nanoseconds = 0) {
  return {
    seconds,
    nanoseconds,
    toDate: () => new Date(seconds * 1000 + nanoseconds / 1e6),
    toMillis: () => seconds * 1000 + nanoseconds / 1e6,
  };
}

function recordingAdapter(rows: Record<string, unknown>[]) {
  const calls: Array<{ path: string; options: unknown }> = [];
  const adapter = {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async (path: string, options?: unknown) => {
      calls.push({ path, options });
      return rows;
    }),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_p: string, _id: string, d: Record<string, unknown>) => d),
    updateDoc: jest.fn(async (_p: string, _id: string, d: Record<string, unknown>) => d),
    deleteDoc: jest.fn(async () => undefined),
  } as unknown as PublicEventsSupaAdapter;
  return { adapter, calls };
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  setPublicEventsAdapterForTests(undefined);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  setPublicEventsAdapterForTests(undefined);
  jest.restoreAllMocks();
});

/* ================================================================== */
describe('flag semantics (S-FLAG-01 stand-in: the seam local parser)', () => {
  it('defaults OFF with the env unset or empty', () => {
    expect(publicEventsSupaEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(publicEventsSupaEnabled({ SUPA_SURFACES: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(supaSurfaceEnabled('events', { SUPA_SURFACES: '  ' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("enables on 'events', '*', lists, and case/space variants; not on lookalikes", () => {
    for (const v of ['events', '*', 'foo, events', ' Events ', 'EVENTS']) {
      expect(publicEventsSupaEnabled({ SUPA_SURFACES: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const v of ['event', 'events2', 'blog']) {
      expect(publicEventsSupaEnabled({ SUPA_SURFACES: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

/* ================================================================== */
describe('route fallback arms (flag off / unavailable / adapter error)', () => {
  it('flag OFF: all three views and the default view answer 503 supa_unavailable, adapter never consulted', async () => {
    const { adapter, calls } = recordingAdapter([{ id: 'x' }]);
    setPublicEventsAdapterForTests(adapter);
    for (const qs of ['?view=list', '?view=workshops', '?view=feed', '']) {
      const res = await GET(req(qs));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'supa_unavailable' });
    }
    expect(calls).toHaveLength(0);
  });

  it('flag ON but adapter resolves to null (unconfigured): 503, no throw', async () => {
    process.env[ENV_KEY] = 'events';
    setPublicEventsAdapterForTests(null);
    const res = await GET(req('?view=list'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'supa_unavailable' });
  });

  it('flag ON, no injection, adapter module absent from this tree: 503, no throw', async () => {
    process.env[ENV_KEY] = 'events';
    const res = await GET(req('?view=feed'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'supa_unavailable' });
  });

  it('flag ON and the adapter throws: 503 (fallback), the error does not surface', async () => {
    process.env[ENV_KEY] = 'events';
    const { adapter } = recordingAdapter([]);
    (adapter.listDocs as jest.Mock).mockRejectedValue(new Error('postgrest down'));
    setPublicEventsAdapterForTests(adapter);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req('?view=workshops'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'supa_unavailable' });
  });

  it('FINDING (current behavior): prototype-chain view names bypass the view check — view=toString answers 200 even with the flag OFF, view=__proto__ throws instead of 400', async () => {
    // route.ts resolves the loader with a plain-object index
    // (VIEWS[view]) and only checks truthiness, so inherited
    // Object.prototype members pass as "loaders". Expected per the
    // route's own contract: anything but list|workshops|feed is
    // 400 { error: 'Unknown view' }, and with the flag OFF every
    // view is 503. Pinned as-is, contracts-branch FINDING style:
    // a fix (own-property check) flips these assertions.
    delete process.env[ENV_KEY]; // flag OFF
    const res = await GET(req('?view=toString'));
    expect(res.status).toBe(200); // NOT 503, NOT 400
    await expect(GET(req('?view=__proto__'))).rejects.toThrow(TypeError);
    await expect(GET(req('?view=hasOwnProperty'))).rejects.toThrow(TypeError);
    const ctor = await GET(req('?view=constructor'));
    expect(ctor.status).toBe(200); // NOT 503, NOT 400
  });

  it('unknown view is a 400 with the pinned body, before any adapter read', async () => {
    process.env[ENV_KEY] = 'events';
    const { adapter, calls } = recordingAdapter([]);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=bogus'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown view' });
    expect(calls).toHaveLength(0);
  });
});

/* ================================================================== */
describe('query shapes against the mocked adapter (E-LST-01 + section 1.2)', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'events';
  });

  it("list: collection 'events', orderBy createdAt desc, limit 12, and NO where key", async () => {
    const { adapter, calls } = recordingAdapter([]);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=list'));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('events');
    expect(calls[0].options).toEqual({
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 12,
    });
    expect(Object.prototype.hasOwnProperty.call(calls[0].options, 'where')).toBe(false);
  });

  it('the default view (no ?view) is the list query', async () => {
    const { adapter, calls } = recordingAdapter([]);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req(''));
    expect(res.status).toBe(200);
    expect(calls[0].options).toEqual({
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 12,
    });
  });

  it("workshops: where type=='workshop' AND status=='published', limit 3, no orderBy added", async () => {
    const { adapter, calls } = recordingAdapter([]);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=workshops'));
    expect(res.status).toBe(200);
    expect(calls[0].path).toBe('events');
    expect(calls[0].options).toEqual({
      where: [
        ['type', '==', 'workshop'],
        ['status', '==', 'published'],
      ],
      limit: 3,
    });
  });

  it("feed: where status=='published', limit 10, no orderBy added", async () => {
    const { adapter, calls } = recordingAdapter([]);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=feed'));
    expect(res.status).toBe(200);
    expect(calls[0].path).toBe('events');
    expect(calls[0].options).toEqual({
      where: [['status', '==', 'published']],
      limit: 10,
    });
  });

  it('listPublicEvents returns null (not []) when the flag is off', async () => {
    delete process.env[ENV_KEY];
    await expect(listPublicEvents()).resolves.toBeNull();
  });
});

/* ================================================================== */
describe('wire parity: order, shapes, timestamps (S-TS through the route)', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'events';
  });

  it('adapter row order is preserved exactly (no re-sort by createdAt)', async () => {
    const rows = [
      { id: 'ev-old', title: 'Old', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'ev-new', title: 'New', createdAt: '2026-12-01T00:00:00.000Z' },
      { id: 'ev-mid', title: 'Mid', createdAt: '2026-06-01T00:00:00.000Z' },
    ];
    const { adapter } = recordingAdapter(rows);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=list'));
    const body = await res.json();
    expect(body.map((r: any) => r.id)).toEqual(['ev-old', 'ev-new', 'ev-mid']);
  });

  it('the same instant in ISO / { _seconds } / { seconds } storage leaves as the identical ISO string', async () => {
    const rows = [
      { id: 'a', createdAt: INSTANT_ISO, startAt: INSTANT_ISO },
      { id: 'b', createdAt: { _seconds: INSTANT_SECONDS, _nanoseconds: 0 }, startAt: { _seconds: INSTANT_SECONDS, _nanoseconds: 0 } },
      { id: 'c', createdAt: { seconds: INSTANT_SECONDS, nanoseconds: 0 }, startAt: { seconds: INSTANT_SECONDS, nanoseconds: 0 } },
    ];
    const { adapter } = recordingAdapter(rows as any);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=list'));
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const row of body) {
      expect(row.createdAt).toBe(INSTANT_ISO);
      expect(row.startAt).toBe(INSTANT_ISO);
    }
    // The full wire body is byte-identical to the plain-JSON expectation.
    expect(JSON.stringify(body)).toBe(
      JSON.stringify([
        { id: 'a', createdAt: INSTANT_ISO, startAt: INSTANT_ISO },
        { id: 'b', createdAt: INSTANT_ISO, startAt: INSTANT_ISO },
        { id: 'c', createdAt: INSTANT_ISO, startAt: INSTANT_ISO },
      ]),
    );
  });

  it('PKT-midnight boundary: every storage shape renders the PKT calendar date, identical to the Firestore rendering', async () => {
    const shapes: Record<string, unknown>[] = [
      { id: 'iso', startAt: BOUNDARY_ISO },
      { id: 'admin', startAt: { _seconds: BOUNDARY_SECONDS, _nanoseconds: 0 } },
      { id: 'plain', startAt: { seconds: BOUNDARY_SECONDS, nanoseconds: 0 } },
    ];
    const { adapter } = recordingAdapter(shapes);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=list'));
    const body = await res.json();
    const firestoreRendering = formatEventInstantInPkt(
      firestoreTimestamp(BOUNDARY_SECONDS) as any,
      'date',
    );
    // 'date' style is the short form; the point of the boundary case is
    // that the rendered day is the PKT day (Nov 1), not the UTC day
    // (Oct 31) of the same instant.
    expect(firestoreRendering).toContain('Nov 1, 2026');
    expect(firestoreRendering).not.toContain('Oct 31');
    for (const row of body) {
      expect(row.startAt).toBe(BOUNDARY_ISO);
      expect(formatEventInstantInPkt(row.startAt, 'date')).toBe(firestoreRendering);
      expect(formatEventInstantInPkt(row.startAt, 'dateTime24')).toBe(
        formatEventInstantInPkt(firestoreTimestamp(BOUNDARY_SECONDS) as any, 'dateTime24'),
      );
    }
  });

  it('sub-second precision survives the seam at millisecond resolution (nanoseconds folded, not dropped whole)', async () => {
    const rows = [
      { id: 'n', createdAt: { _seconds: INSTANT_SECONDS, _nanoseconds: 123456789 } },
    ];
    const { adapter } = recordingAdapter(rows as any);
    setPublicEventsAdapterForTests(adapter);
    const res = await GET(req('?view=list'));
    const body = await res.json();
    expect(body[0].createdAt).toBe('2026-11-01T05:00:00.123Z');
    expect(formatEventInstantInPkt(body[0].createdAt, 'dateTime24')).toBe(
      formatEventInstantInPkt(firestoreTimestamp(INSTANT_SECONDS, 123456789) as any, 'dateTime24'),
    );
  });
});

/* ================================================================== */
describe('normalizeSupaData / toPublicJson shape discipline', () => {
  it('converts nested fields and array elements, not just top-level fields', () => {
    const out: any = normalizeSupaData({
      title: 'Gala',
      profitSettlement: { updatedAt: INSTANT_ISO, status: 'draft' },
      attended: [{ attendedAt: { _seconds: INSTANT_SECONDS, _nanoseconds: 0 } }],
    });
    expect(out.profitSettlement.updatedAt.toMillis()).toBe(INSTANT_MS);
    expect(out.attended[0].attendedAt.toMillis()).toBe(INSTANT_MS);
    expect(toPublicJson(out).profitSettlement.updatedAt).toBe(INSTANT_ISO);
    expect(toPublicJson(out).attended[0].attendedAt).toBe(INSTANT_ISO);
  });

  it('leaves non-timestamp values untouched: plain strings, date-only strings, numbers, null, extra-key objects', () => {
    const input = {
      title: '2026-11-01', // date-only: not an instant, must stay a string
      slug: 'space-talk',
      capacity: 120,
      epochMs: INSTANT_MS, // numbers pass through as numbers
      missing: null,
      duration: { seconds: 30, nanoseconds: 0, unit: 's' }, // extra key: NOT a timestamp shape
      partial: { seconds: 30 }, // missing nanoseconds: NOT converted
    };
    const out: any = normalizeSupaData(input);
    expect(out).toEqual(input);
    expect(typeof out.epochMs).toBe('number');
  });

  it('a genuine Timestamp-like produced by normalization renders through the oracle exactly as the Firestore original', () => {
    const out: any = normalizeSupaData({ startAt: INSTANT_ISO });
    for (const style of ['date', 'datePadded', 'dateTime24', 'weekdayLong'] as const) {
      expect(formatEventInstantInPkt(out.startAt, style)).toBe(
        formatEventInstantInPkt(firestoreTimestamp(INSTANT_SECONDS) as any, style),
      );
    }
  });
});
