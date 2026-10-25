/**
 * @jest-environment node
 *
 * (Node environment so the REAL route handler's `next/server`
 * import finds the web Request/Response globals jsdom strips; a
 * JSDOM window is installed below for React Testing Library.)
 *
 * S-E2E-02 [feat/supa-events-4] — implemented for real.
 *
 * With SUPA_SURFACES=events and the adapter mocked (via the seam's
 * test injection), the public list path runs end to end:
 *   EventsPage --fetch--> GET /api/events/public?view=list
 *     --> seam listPublicEvents() --> mocked adapter over fs_events rows
 * and must satisfy:
 *   - E-LST-01: createdAt desc, cap 12 applied BEFORE the page's
 *     client-side published/deleted filtering (the fixture's three
 *     newest rows are unpublishable, so a post-filter cap would
 *     render 12 cards; the correct pre-filter cap renders 9).
 *   - E-LST-02/03/04 remain the page's own behavior (the page code is
 *     unchanged apart from where its rows come from).
 *   - Render parity: the flag-on rendered list (titles, in order,
 *     with S-TS timestamp forms in createdAt/startAt served as
 *     ISO / {_seconds} jsonb shapes) matches the flag-off render of
 *     the same stored events in Firestore Timestamp-like shapes.
 * The detail contracts E-DET-02/03 named in S-E2E-02 pin E1's
 * generateMetadata, which E4 does not change; they are verified by
 * the copied-in supa-events-list-detail-contracts suite on this
 * branch. Zero live reads: hooks, the store action, and fetch are
 * mocked; fetch delegates to the REAL route handler.
 */

import React from 'react';
(globalThis as any).React = React;

import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

/* JSDOM bootstrap (this suite runs in the node environment, above). */
import { JSDOM } from 'jsdom';
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  const g = globalThis as any;
  g.window = w;
  g.self = w;
  g.document = w.document;
  g.navigator = w.navigator;
  g.HTMLElement = w.HTMLElement;
  g.HTMLAnchorElement = w.HTMLAnchorElement;
  g.Element = w.Element;
  g.Node = w.Node;
  g.MutationObserver = w.MutationObserver;
  g.getComputedStyle = w.getComputedStyle.bind(w);
  g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: any) => clearTimeout(id);
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

/* ------------------------------------------------------------------ *
 * Fixtures: 15 stored events, createdAt desc. Rows 01-03 are
 * draft / published+deleted / archived, so the cap-12 candidate set
 * (rows 01-12) yields exactly 9 visible published rows (04-12).
 * ------------------------------------------------------------------ */
const START_MS = Date.UTC(2026, 10, 5, 7, 0, 0); // Nov 5, 2026 12:00 PKT
const BASE_MS = Date.UTC(2026, 9, 20, 0, 0, 0);

function makeRow(i: number) {
  const n = String(i).padStart(2, '0');
  const status = i === 1 ? 'draft' : i === 3 ? 'archived' : 'published';
  return {
    id: `ev-${n}`,
    title: `Event ${n}`,
    type: 'event',
    status,
    deleted: i === 2 ? true : undefined,
    visibility: 'public',
    createdMs: BASE_MS + (16 - i) * 1000,
    location: 'IST Auditorium',
    description: `desc ${n}`,
    startMs: START_MS,
  };
}
const ROWS = Array.from({ length: 15 }, (_, k) => makeRow(k + 1));
const VISIBLE_TITLES = ROWS.slice(0, 12)
  .filter((r) => r.status === 'published' && !r.deleted)
  .map((r) => r.title);
expect(VISIBLE_TITLES).toHaveLength(9);

/** Firestore-shaped rows (Timestamp-like instants), query-emulated:
 * Firestore itself applies orderBy+limit, so the hook hands the page
 * the first 12 rows only. */
function firestoreRows() {
  return ROWS.slice(0, 12).map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    ...(r.deleted ? { deleted: true } : {}),
    visibility: r.visibility,
    location: r.location,
    description: r.description,
    createdAt: {
      seconds: Math.floor(r.createdMs / 1000),
      nanoseconds: 0,
      toMillis: () => r.createdMs,
      toDate: () => new Date(r.createdMs),
    },
    startAt: {
      seconds: Math.floor(r.startMs / 1000),
      nanoseconds: 0,
      toMillis: () => r.startMs,
      toDate: () => new Date(r.startMs),
    },
  }));
}

/** Adapter (jsonb) rows: ISO strings and legacy {_seconds} shapes. */
function adapterRows() {
  return ROWS.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    ...(r.deleted ? { deleted: true } : {}),
    visibility: r.visibility,
    location: r.location,
    description: r.description,
    createdAt: new Date(r.createdMs).toISOString(),
    startAt:
      r.id === 'ev-04'
        ? { _seconds: Math.floor(r.startMs / 1000), _nanoseconds: 0 }
        : new Date(r.startMs).toISOString(),
  }));
}

/** Mock adapter implementing the documented listDocs semantics. */
function makeMockAdapter() {
  const rows = adapterRows();
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async (_path: string, options: any = {}) => {
      let out = [...rows];
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') out = out.filter((d: any) => d[field] === value);
      }
      const order = options.orderBy
        ? Array.isArray(options.orderBy)
          ? options.orderBy[0]
          : options.orderBy
        : null;
      if (order) {
        out.sort((a: any, b: any) => {
          const c = String(a[order.field]) < String(b[order.field]) ? -1 : 1;
          return order.direction === 'desc' ? -c : c;
        });
      }
      if (options.limit !== undefined) out = out.slice(0, options.limit);
      return out;
    }),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: any) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: any) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
  };
}

/* ------------------------------------------------------------- mocks */

// The seam statically binds '@/lib/supa' (E3 form), which does not
// exist on this standalone branch — mock it (E3's mechanism). The
// seam's test injection supplies the adapter itself.
// NOTE: jest.mock still needs the mapped path to RESOLVE, so on
// this standalone branch the suite runs with src/lib/supa
// present (the adapter lands as merge step 0; E3's suite has
// the same property standalone).
jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => {
    const raw = process.env.SUPA_SURFACES;
    if (!raw) return false;
    const list = raw
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    return list.includes('*') || list.includes(surface.toLowerCase());
  },
  getSupaClient: () => ({}),
  getSupaAdapter: () => null,
  parseSupaSurfaces: (raw: string | undefined) =>
    new Set(
      (raw ?? '')
        .split(',')
        .map((s: string) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
}));

jest.mock('firebase/firestore', () => ({
  collection: (_db: any, name: string) => ({ _collection: name }),
  query: (ref: any, ...constraints: any[]) => ({ ref, constraints }),
  where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }),
  orderBy: (field: string, dir: string) => ({ kind: 'orderBy', field, dir }),
  limit: (n: number) => ({ kind: 'limit', n }),
}));

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null, role: null, isLoading: false }),
  useFirestore: () => ({}),
  useCollection: () => ({ data: firestoreRows(), loading: false }),
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

import EventsPage from '@/app/events/page';
import { GET } from '@/app/api/events/public/route';
import { setPublicEventsAdapterForTests } from '@/lib/supa-events/public-events';

const savedSurfaces = process.env.SUPA_SURFACES;
const savedHint = process.env.NEXT_PUBLIC_SUPA_SURFACES;
const realFetch = global.fetch;

function renderedTitles(container: HTMLElement): string[] {
  const text = container.textContent || '';
  return ROWS.map((r) => r.title)
    .filter((t) => text.includes(t))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

afterEach(() => {
  setPublicEventsAdapterForTests(undefined);
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
  if (savedHint === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  else process.env.NEXT_PUBLIC_SUPA_SURFACES = savedHint;
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('S-E2E-02 public list: adapter-served rows through route + page fetch path', () => {
  it('flag OFF render (Firestore shapes) is the parity baseline', async () => {
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
    const { container, findByText } = render(<EventsPage />);
    await findByText('Event 04');
    expect(renderedTitles(container)).toEqual(VISIBLE_TITLES);
    expect(container.textContent).toContain('Nov 5, 2026');
  });

  it('flag ON: E-LST-01 cap-12-before-filtering holds end to end and the render matches flag OFF', async () => {
    process.env.SUPA_SURFACES = 'events';
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'events';
    const adapter = makeMockAdapter();
    setPublicEventsAdapterForTests(adapter as any);
    // The page's fetch goes to the REAL route handler.
    global.fetch = (async (url: string) =>
      GET({ nextUrl: new URL(String(url), 'http://x') } as any)) as any;

    const { container, findByText, queryByText } = render(<EventsPage />);
    await findByText('Event 04');

    // The seam was asked for exactly the E-LST-01 query.
    expect(adapter.listDocs).toHaveBeenCalledWith('events', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 12,
    });
    // Cap before filtering: rows 13-15 are published but never
    // reached the page; rows 01-03 reached it and were filtered out.
    expect(renderedTitles(container)).toEqual(VISIBLE_TITLES);
    for (const hidden of ['Event 01', 'Event 02', 'Event 03', 'Event 13', 'Event 14', 'Event 15']) {
      expect(queryByText(hidden)).toBeNull();
    }
    // S-TS forms (ISO + {_seconds}) rendered the same PKT date.
    expect(container.textContent).toContain('Nov 5, 2026');
  });

  it('flag ON but route unavailable (adapter error -> 503): page falls back to the Firestore rows', async () => {
    process.env.SUPA_SURFACES = 'events';
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'events';
    const adapter = makeMockAdapter();
    (adapter.listDocs as jest.Mock).mockRejectedValue(new Error('supa down'));
    setPublicEventsAdapterForTests(adapter as any);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    global.fetch = (async (url: string) =>
      GET({ nextUrl: new URL(String(url), 'http://x') } as any)) as any;

    const { container, findByText } = render(<EventsPage />);
    await findByText('Event 04');
    expect(renderedTitles(container)).toEqual(VISIBLE_TITLES);
  });
});
