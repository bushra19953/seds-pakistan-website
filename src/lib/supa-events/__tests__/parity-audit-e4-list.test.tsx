/**
 * PARITY AUDIT E4 — rendered list parity (independent test author;
 * NOT the implementer). Branch feat/supa-events-4 @ 23a1417.
 *
 * The real public list page (src/app/events/page.tsx) is rendered in
 * both modes over the SAME logical fixture set (the contract fixtures
 * of supa-events-list-detail-contracts, titles/order preserved):
 *  - flag OFF (no NEXT_PUBLIC hint): the Firestore hook rows, whose
 *    startAt values are Firestore Timestamp shapes;
 *  - flag ON (hint set): the hook returns a sentinel row that must
 *    NOT render; fetch serves the wire rows (ISO strings, exactly as
 *    the public route emits them) and the SAME titles must render in
 *    the SAME order, with the SAME rendered date strings — including
 *    a PKT-midnight-boundary startAt (E-LST-02/03, S-TS).
 *  - flag ON but the route answers 503: the Firestore rows render
 *    (fallback is byte-identical to flag OFF).
 *
 * Also pins census sites #10/#11: the exported eventDateToIso of both
 * homepage components returns, for a genuine Timestamp, exactly the
 * ISO the old bare .toDate().toISOString() produced, and widens
 * (never throws) for the seam shapes.
 */

import React from 'react';
(globalThis as any).React = React;

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

/* ------------------------------------------------------------ fixtures */

/** 2026-10-31T19:00:00.000Z = 2026-11-01 00:00 PKT (midnight boundary). */
const BOUNDARY_SECONDS = Math.floor(Date.parse('2026-10-31T19:00:00.000Z') / 1000);
const BOUNDARY_ISO = '2026-10-31T19:00:00.000Z';

function firestoreTimestamp(seconds: number, nanoseconds = 0) {
  return {
    seconds,
    nanoseconds,
    toDate: () => new Date(seconds * 1000 + nanoseconds / 1e6),
    toMillis: () => seconds * 1000 + nanoseconds / 1e6,
  };
}

const TITLES_IN_ORDER = [
  'Members Only Briefing',
  'Newest Public Event',
  'Legacy Flag Webinar',
  'Rocketry Workshop',
];
const HIDDEN_TITLES = ['Draft Secret Session', 'Archived Old Talk', 'Deleted Published Event'];

const baseRows: Array<Record<string, unknown>> = [
  { id: 'ev-members', slug: 'ev-members', title: 'Members Only Briefing', type: 'event', status: 'published', visibility: 'members', createdAt: 700, location: 'IST Auditorium', description: 'members briefing' },
  { id: 'ev-new', slug: 'ev-new', title: 'Newest Public Event', type: 'event', status: 'published', visibility: 'public', createdAt: 600, location: 'IST Auditorium', description: 'newest' },
  { id: 'ev-legacy', slug: 'ev-legacy', title: 'Legacy Flag Webinar', type: 'webinar', published: true, createdAt: 500, location: 'Online', description: 'legacy' },
  { id: 'ev-ws', slug: 'ev-ws', title: 'Rocketry Workshop', type: 'workshop', status: 'published', createdAt: 400, location: 'BIC Room 131', description: 'workshop' },
  { id: 'ev-draft', slug: 'ev-draft', title: 'Draft Secret Session', type: 'event', status: 'draft', createdAt: 300, location: 'IST', description: 'draft' },
  { id: 'ev-archived', slug: 'ev-archived', title: 'Archived Old Talk', type: 'event', status: 'archived', createdAt: 200, location: 'IST', description: 'archived' },
  { id: 'ev-deleted', slug: 'ev-deleted', title: 'Deleted Published Event', type: 'event', status: 'published', deleted: true, createdAt: 100, location: 'IST', description: 'deleted' },
];

/** Firestore mode: startAt is a Timestamp shape (boundary instant on ev-new). */
const firestoreRows = baseRows.map((r) => ({
  ...r,
  startAt: firestoreTimestamp(BOUNDARY_SECONDS + (r.createdAt as number)),
}));
/** Supa wire mode: the route's ISO serialization of the same instants. */
const wireRows = baseRows.map((r) => ({
  ...r,
  startAt: new Date((BOUNDARY_SECONDS + (r.createdAt as number)) * 1000).toISOString(),
  createdAt: new Date((BOUNDARY_SECONDS + (r.createdAt as number)) * 1000).toISOString(),
}));

const SENTINEL = [
  { id: 'fs-sentinel', slug: 'fs-sentinel', title: 'Firestore Sentinel Row', type: 'event', status: 'published', createdAt: 999, location: 'Nowhere', description: 'sentinel', startAt: firestoreTimestamp(BOUNDARY_SECONDS) },
];

/* --------------------------------------------------------------- mocks */

const hookState: { rows: any[] } = { rows: firestoreRows };

jest.mock('firebase/firestore', () => ({
  collection: (_db: any, name: string) => ({ _collection: name }),
  query: (ref: any, ...constraints: any[]) => ({ ref, constraints }),
  where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }),
  orderBy: (field: string, dir: string) => ({ kind: 'orderBy', field, dir }),
  limit: (n: number) => ({ kind: 'limit', n }),
  getDocs: jest.fn(async () => ({ docs: [] })),
  doc: (_db: any, ...parts: string[]) => ({ _path: parts.join('/') }),
}));

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null, role: null, isLoading: false }),
  useFirestore: () => ({}),
  useCollection: () => ({ data: hookState.rows, loading: false }),
  useDoc: () => ({ data: null, loading: false }),
}));

jest.mock('@/firebase/provider', () => ({
  useFirestore: () => ({}),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@/app/actions/store', () => ({
  getPublicProducts: jest.fn(async () => ({ success: true, data: [] })),
}));

jest.mock('@/components/layout/footer', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/starry-background', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/page-hero', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/media-embed', () => ({ MediaEmbed: () => null }));

import EventsPage from '@/app/events/page';
import { eventDateToIso as workshopsEventDateToIso } from '@/components/home/events-workshops-section';
import { eventDateToIso as feedEventDateToIso } from '@/components/home/homepage-event-feed';

const HINT = 'NEXT_PUBLIC_SUPA_SURFACES';
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  hookState.rows = firestoreRows;
  delete process.env[HINT];
  (globalThis as any).fetch = fetchMock;
  fetchMock.mockReset();
});

afterEach(() => {
  delete process.env[HINT];
});

function expectVisibleSet(container: HTMLElement) {
  const text = container.textContent || '';
  for (const t of TITLES_IN_ORDER) expect(text).toContain(t);
  for (const t of HIDDEN_TITLES) expect(text).not.toContain(t);
  const order = TITLES_IN_ORDER.map((t) => text.indexOf(t));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
}

/* ================================================================== */
describe('public list page: flag OFF vs flag ON rendered parity', () => {
  it('flag OFF: Firestore rows render, the public route is never fetched', async () => {
    render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag OFF: visible set, order, and boundary date rendering', async () => {
    const { container } = render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    expectVisibleSet(container);
    // ev-new starts 600s after the PKT-midnight boundary: still the
    // PKT calendar day Nov 1 in PKT rendering.
    expect(container.textContent).toContain('Nov 1, 2026');
    expect(container.textContent).not.toContain('Oct 31, 2026');
  });

  it('flag ON: wire rows replace the Firestore rows entirely — same visible set, order, and dates; sentinel never renders', async () => {
    process.env[HINT] = 'events';
    hookState.rows = SENTINEL;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => wireRows,
    });
    const { container } = render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/events/public?view=list');
    expect(screen.queryByText('Firestore Sentinel Row')).toBeNull();
    expectVisibleSet(container);
    expect(container.textContent).toContain('Nov 1, 2026');
    expect(container.textContent).not.toContain('Oct 31, 2026');
  });

  it('flag ON but route 503: the Firestore rows render (fallback identical to flag OFF)', async () => {
    process.env[HINT] = 'events';
    hookState.rows = firestoreRows;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'supa_unavailable' }),
    });
    const { container } = render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    expectVisibleSet(container);
  });

  it('flag ON but fetch throws: the Firestore rows render', async () => {
    process.env[HINT] = 'events';
    hookState.rows = firestoreRows;
    fetchMock.mockRejectedValue(new Error('network down'));
    const { container } = render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    expectVisibleSet(container);
  });
});

/* ================================================================== */
describe('census sites #10/#11: eventDateToIso in both homepage components', () => {
  const ts = firestoreTimestamp(BOUNDARY_SECONDS, 250000000);
  const expectedIso = ts.toDate().toISOString();

  it('a genuine Firestore Timestamp yields exactly the old .toDate().toISOString() output', () => {
    expect(workshopsEventDateToIso(ts)).toBe(expectedIso);
    expect(feedEventDateToIso(ts)).toBe(expectedIso);
  });

  it('seam shapes of the same instant widen to the same ISO (the old bare .toDate() threw here)', () => {
    for (const shape of [
      expectedIso,
      { seconds: BOUNDARY_SECONDS, nanoseconds: 250000000 },
      BOUNDARY_SECONDS * 1000 + 250,
    ]) {
      expect(workshopsEventDateToIso(shape)).toBe(expectedIso);
      expect(feedEventDateToIso(shape)).toBe(expectedIso);
    }
  });

  it('BOUNDARY PIN: the { _seconds, _nanoseconds } Admin shape has NO arm in the datetime oracle, so it yields undefined/null here', () => {
    // eventInstantToMs (src/lib/events/datetime.ts) handles toMillis /
    // toDate / { seconds, nanoseconds } / ISO / ms — not _seconds. That
    // shape therefore cannot reach these consumers through E4's own
    // pipeline: the seam's normalizeSupaData converts it to a
    // TimestampLike and the route serializes it to ISO (proven in
    // parity-audit-e4.test.ts). Pinned so a future oracle change that
    // adds a _seconds arm shows up here as a deliberate flip.
    const adminShape = { _seconds: BOUNDARY_SECONDS, _nanoseconds: 250000000 };
    expect(workshopsEventDateToIso(adminShape)).toBeUndefined();
    expect(feedEventDateToIso(adminShape)).toBeNull();
  });

  it('no valid instant: workshops yields undefined, feed yields null, neither throws', () => {
    for (const bad of [undefined, null, 'not-a-date', {}, Number.NaN]) {
      expect(workshopsEventDateToIso(bad)).toBeUndefined();
      expect(feedEventDateToIso(bad)).toBeNull();
    }
  });
});
