/**
 * Behavior contracts for the events LIST and DETAIL surfaces, recorded
 * from the CURRENT Firestore implementation (feat/integration-wave3 @
 * 4d5a1e16) ahead of the Supabase migration (implementer branches
 * feat/supa-events-1 server events core, feat/supa-events-4 public
 * pages, feat/supa-events-5 admin).
 *
 * Purpose: the migration swaps the store behind these surfaces
 * (Firestore documents -> fs_events jsonb rows via src/lib/supa) behind
 * a default-OFF flag with Firestore fallback. Every contract below is
 * stated at the boundary consumers actually depend on, so the SAME
 * suite must pass against the migrated implementation with the flag ON
 * (adapter mocked) and OFF. The list pages are rendered for real with
 * the Firestore hooks mocked: the captured query descriptor is the
 * query the page emits, and the rendered rows are the page's own
 * client-side filtering of the rows that query returns.
 *
 * Contract inventory:
 *   E-LST-01  Public list query shape: collection 'events',
 *             orderBy('createdAt','desc'), limit(12), and NO where
 *             clause (visibility/status filtering is client-side and
 *             relies on Firestore rules returning only readable docs).
 *             A migrated listDocs call must reproduce exactly this:
 *             newest-first, capped at 12 BEFORE client filtering.
 *   E-LST-02  Public list visibility filter (client): a row renders iff
 *             (status === 'published' || published === true) and
 *             deleted !== true. Draft, archived, and soft-deleted rows
 *             never render, in query order (the page does NOT re-sort).
 *   E-LST-03  FINDING (current behavior): the public list filter does
 *             NOT consult `visibility`. A published members-only event
 *             renders its title/date/location on the anonymous public
 *             list even though its detail page hides it (E-DET-03).
 *             Pinned as-is; events-4 must not silently change it
 *             without a product decision.
 *   E-LST-04  Public list type filter: 'all' shows every visible row;
 *             'event' | 'workshop' | 'webinar' show only exact
 *             event.type matches.
 *   E-LST-05  Admin list query shape: collection 'events',
 *             orderBy('createdAt','desc'), limit(200). (Originally NO
 *             limit — the uncapped registry shape; superseded by
 *             read-bleed train 2 / census 10: the page is seam-first
 *             via GET /api/admin/events and this pins its flag-off
 *             Firestore fallback, now bounded at 200 where the public
 *             list is capped at 12.)
 *   E-LST-06  Admin list filter: every non-deleted row renders under
 *             the default 'all' status filter, drafts and archived
 *             included; deleted rows never render. Search matches
 *             title OR location, case-insensitively.
 *   E-LST-07  Admin status-filter semantics (source-pinned): filter
 *             'published' = status 'published' OR legacy published
 *             flag; 'draft' = NOT published by either test (so an
 *             archived event passes the 'draft' filter); 'archived' =
 *             status exactly 'archived'.
 *   E-DET-01  Detail lookup is by DOCUMENT ID: the slug segment is used
 *             as doc(events, slug) / doc(slug).get() on both the client
 *             page and the OG-metadata path. There is no query on a
 *             `slug` FIELD: an event whose stored slug field differs
 *             from its document id is NOT found at /events/<slug-field>.
 *   E-DET-02  Detail found shape (OG path): a publicly exposable event
 *             yields title "<title> | SEDS Pakistan", a canonical URL
 *             of <site>/events/<slug>, the event image (or the OG
 *             fallback image), and a tag-stripped description.
 *   E-DET-03  Detail not-found shapes (OG path): a missing doc yields
 *             title 'Event Not Found | SEDS Pakistan' with description
 *             'This event does not exist or has been removed.' A doc
 *             that exists but is not publicly exposable (draft,
 *             deleted, members-only, private) yields the GENERIC shape
 *             (title 'SEDS Pakistan — Events') with no title, image, or
 *             description leakage. A db failure yields the catch shape
 *             (title 'Event | SEDS Pakistan').
 *   E-DET-04  The rendered detail page collapses missing and
 *             non-viewable events into the same Not Found treatment
 *             (source-pinned in _event-client.tsx: `if (!event ||
 *             !viewerCanView)` -> 'Event Not Found' card); the
 *             visibility matrix itself is pinned by the pre-existing
 *             src/lib/__tests__/event-public-exposure.test.ts suite and
 *             is not duplicated here.
 *
 * Zero live reads: Firestore hooks, the admin-db accessor, and the
 * store action are all mocked. The OG-metadata tests run the real
 * generateMetadata against the repo's in-memory FakeFirestore.
 */

import React from 'react';
// The repo Jest config uses the classic JSX runtime; components that
// rely on the Next.js automatic runtime resolve `React` as a free
// variable at render time (same note as the delete-flow suite).
(globalThis as any).React = React;

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync } from 'fs';
import { join } from 'path';

/* ------------------------------------------------------------------ *
 * Shared fixture rows, in the order the Firestore query returns them
 * (createdAt desc). The hooks below hand these to the real pages.
 * ------------------------------------------------------------------ */
const PUBLIC_FIXTURE: any[] = [
  { id: 'ev-members', title: 'Members Only Briefing', type: 'event', status: 'published', visibility: 'members', createdAt: 700, location: 'IST Auditorium', description: 'members briefing' },
  { id: 'ev-new', title: 'Newest Public Event', type: 'event', status: 'published', visibility: 'public', createdAt: 600, location: 'IST Auditorium', description: 'newest' },
  { id: 'ev-legacy', title: 'Legacy Flag Webinar', type: 'webinar', published: true, createdAt: 500, location: 'Online', description: 'legacy' },
  { id: 'ev-ws', title: 'Rocketry Workshop', type: 'workshop', status: 'published', createdAt: 400, location: 'BIC Room 131', description: 'workshop' },
  { id: 'ev-draft', title: 'Draft Secret Session', type: 'event', status: 'draft', createdAt: 300, location: 'IST', description: 'draft' },
  { id: 'ev-archived', title: 'Archived Old Talk', type: 'event', status: 'archived', createdAt: 200, location: 'IST', description: 'archived' },
  { id: 'ev-deleted', title: 'Deleted Published Event', type: 'event', status: 'published', deleted: true, createdAt: 100, location: 'IST', description: 'deleted' },
];

const ADMIN_FIXTURE: any[] = [
  { id: 'ev-a-new', title: 'Alpha Launch Night', status: 'published', createdAt: 400, location: 'IST Auditorium', startAt: null },
  { id: 'ev-a-draft', title: 'Beta Draft Workshop', status: 'draft', createdAt: 300, location: 'Online', startAt: null },
  { id: 'ev-a-arch', title: 'Gamma Archived Talk', status: 'archived', createdAt: 200, location: 'BIC Room 131', startAt: null },
  { id: 'ev-a-del', title: 'Delta Deleted Event', status: 'published', deleted: true, createdAt: 100, location: 'IST', startAt: null },
];

const captured: { publicQuery: any; adminQuery: any } = { publicQuery: null, adminQuery: null };
const hookState: { surface: 'public' | 'admin' } = { surface: 'public' };

jest.mock('firebase/firestore', () => ({
  collection: (_db: any, name: string) => ({ _collection: name }),
  query: (ref: any, ...constraints: any[]) => ({ ref, constraints }),
  where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }),
  orderBy: (field: string, dir: string) => ({ kind: 'orderBy', field, dir }),
  limit: (n: number) => ({ kind: 'limit', n }),
}));

jest.mock('@/firebase', () => ({
  useUser: () =>
    hookState.surface === 'admin'
      ? { user: { uid: 'admin-1' }, role: 'founder_patron', isLoading: false }
      : { user: null, role: null, isLoading: false },
  useFirestore: () => ({}),
  useCollection: (q: any) => {
    if (hookState.surface === 'admin') {
      captured.adminQuery = q;
      return { data: ADMIN_FIXTURE, loading: false };
    }
    captured.publicQuery = q;
    return { data: PUBLIC_FIXTURE, loading: false };
  },
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
jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, loading: false }),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import EventsPage from '@/app/events/page';
import AdminEventsPage from '@/app/admin/events/page';
import { generateMetadata } from '@/app/events/[slug]/page';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';

const repoRoot = process.cwd();
const readSrc = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  captured.publicQuery = null;
  captured.adminQuery = null;
  mockDbHolder.db = createFakeDb();
});

/* ================================================================== */
describe('E-LST: public events list (src/app/events/page.tsx, rendered)', () => {
  beforeEach(() => {
    hookState.surface = 'public';
  });

  it('E-LST-01 the public list query is events ordered by createdAt desc, capped at 12, with no where clause', async () => {
    render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    expect(captured.publicQuery.ref).toEqual({ _collection: 'events' });
    expect(captured.publicQuery.constraints).toEqual([
      { kind: 'orderBy', field: 'createdAt', dir: 'desc' },
      { kind: 'limit', n: 12 },
    ]);
  });

  it('E-LST-02 only published (status or legacy flag) non-deleted events render, in query order with no re-sort', async () => {
    const { container } = render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    for (const hidden of ['Draft Secret Session', 'Archived Old Talk', 'Deleted Published Event']) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    const text = container.textContent || '';
    const order = ['Members Only Briefing', 'Newest Public Event', 'Legacy Flag Webinar', 'Rocketry Workshop'].map(
      (t) => text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('E-LST-03 FINDING: a published members-only event renders on the anonymous public list (list filter ignores visibility)', async () => {
    render(<EventsPage />);
    // The detail page hides this same event from anonymous visitors
    // (E-DET-03); the list does not. Current behavior, pinned as-is.
    expect(await screen.findByText('Members Only Briefing')).toBeTruthy();
  });

  it('E-LST-04 the type filter shows only exact type matches, and All restores the full visible set', async () => {
    render(<EventsPage />);
    await screen.findByText('Newest Public Event');

    fireEvent.click(screen.getByRole('button', { name: 'workshop' }));
    expect(screen.getByText('Rocketry Workshop')).toBeTruthy();
    expect(screen.queryByText('Newest Public Event')).toBeNull();
    expect(screen.queryByText('Legacy Flag Webinar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'webinar' }));
    expect(screen.getByText('Legacy Flag Webinar')).toBeTruthy();
    expect(screen.queryByText('Rocketry Workshop')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Newest Public Event')).toBeTruthy();
    expect(screen.getByText('Rocketry Workshop')).toBeTruthy();
    expect(screen.getByText('Legacy Flag Webinar')).toBeTruthy();
  });

  it('E-LST-02 the public list links each card to /events/<slug field when present, else document id>', async () => {
    render(<EventsPage />);
    await screen.findByText('Newest Public Event');
    const src = readSrc('src/app/events/page.tsx');
    // The href is slug-field-first; combined with E-DET-01 (lookup by
    // document id only) a slug field that differs from the doc id
    // produces a card that links to a Not Found detail page.
    expect(src).toContain('href={`/events/${event.slug || event.id}`}');
  });
});

/* ================================================================== */
describe('E-LST: admin events list (src/app/admin/events/page.tsx, rendered)', () => {
  beforeEach(() => {
    hookState.surface = 'admin';
  });

  it('E-LST-05 the admin list fallback query is events ordered by createdAt desc with limit 200', async () => {
    render(<AdminEventsPage />);
    await screen.findByText('Alpha Launch Night');
    expect(captured.adminQuery.ref).toEqual({ _collection: 'events' });
    expect(captured.adminQuery.constraints).toEqual([
      { kind: 'orderBy', field: 'createdAt', dir: 'desc' },
      { kind: 'limit', n: 200 },
    ]);
  });

  it('E-LST-06 drafts and archived events render for admins; deleted events never render', async () => {
    render(<AdminEventsPage />);
    expect(await screen.findByText('Alpha Launch Night')).toBeTruthy();
    expect(screen.getByText('Beta Draft Workshop')).toBeTruthy();
    expect(screen.getByText('Gamma Archived Talk')).toBeTruthy();
    expect(screen.queryByText('Delta Deleted Event')).toBeNull();
    expect(screen.getByText(/3 Active Records Filtered/)).toBeTruthy();
  });

  it('E-LST-06 admin search matches title or location, case-insensitively, and narrows the registry', async () => {
    render(<AdminEventsPage />);
    await screen.findByText('Alpha Launch Night');
    const input = screen.getByPlaceholderText('Filter events by title or location...');

    fireEvent.change(input, { target: { value: 'bic room' } });
    expect(screen.getByText('Gamma Archived Talk')).toBeTruthy();
    expect(screen.queryByText('Alpha Launch Night')).toBeNull();
    expect(screen.getByText(/1 Active Records Filtered/)).toBeTruthy();

    fireEvent.change(input, { target: { value: 'ALPHA' } });
    expect(screen.getByText('Alpha Launch Night')).toBeTruthy();
    expect(screen.queryByText('Gamma Archived Talk')).toBeNull();
  });

  it('E-LST-07 admin status-filter semantics are the source-pinned predicate (draft filter admits archived)', () => {
    const src = readSrc('src/app/admin/events/page.tsx');
    expect(src).toContain("if (statusFilter === 'published')");
    expect(src).toContain("if (!(event.status === 'published' || event.published === true)) return false;");
    // 'draft' is implemented as NOT-published, so archived rows pass it.
    expect(src).toContain("} else if (statusFilter === 'draft') {");
    expect(src).toContain("if (event.status === 'published' || event.published === true) return false;");
    expect(src).toContain("} else if (statusFilter === 'archived') {");
    expect(src).toContain("if (event.status !== 'archived') return false;");
    // The deleted gate runs before the status filter.
    expect(src).toContain('const activeEvents = (events || []).filter((event: any) => event?.deleted !== true);');
  });
});

/* ================================================================== */
describe('E-DET: event detail by slug (OG metadata path, real generateMetadata)', () => {
  const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
  const parent: any = {};

  function seed(db: FakeDb) {
    db.seed('events', 'space-talk', {
      title: 'Space Talk I',
      status: 'published',
      visibility: 'public',
      description: '<p>A <b>great</b> talk.</p>',
      imageUrl: 'https://example.test/talk.png',
    });
  }

  it('E-DET-02 a publicly exposable event yields its title, canonical URL, image, and stripped description', async () => {
    const db = mockDbHolder.db as FakeDb;
    seed(db);
    const meta: any = await generateMetadata(params('space-talk') as any, parent);
    expect(meta.title).toBe('Space Talk I | SEDS Pakistan');
    expect(meta.alternates?.canonical).toBe('https://sedspakistan.live/events/space-talk');
    expect(meta.openGraph?.url).toBe('https://sedspakistan.live/events/space-talk');
    expect((meta.openGraph as any)?.images?.[0]?.url).toBe('https://example.test/talk.png');
    expect(meta.description).toBe('A great talk.');
  });

  it('E-DET-02 an event without an image falls back to the default OG image', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('events', 'plain-talk', { title: 'Plain Talk', status: 'published', description: 'Plain.' });
    const meta: any = await generateMetadata(params('plain-talk') as any, parent);
    expect((meta.openGraph as any)?.images?.[0]?.url).toBe('https://sedspakistan.live/assets/og-default.png');
  });

  it('E-DET-03 a missing slug yields the Event Not Found metadata shape', async () => {
    const meta: any = await generateMetadata(params('no-such-event') as any, parent);
    expect(meta).toEqual({
      title: 'Event Not Found | SEDS Pakistan',
      description: 'This event does not exist or has been removed.',
    });
  });

  it.each([
    ['draft', { status: 'draft', visibility: 'public' }],
    ['deleted', { status: 'published', deleted: true }],
    ['members-only', { status: 'published', visibility: 'members' }],
    ['private', { status: 'published', visibility: 'private' }],
  ])('E-DET-03 a %s event yields the generic metadata shape with no leakage', async (_label, extra) => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('events', 'hidden-talk', { title: 'Hidden Talk Title', description: 'Hidden description.', imageUrl: 'https://example.test/hidden.png', ...extra });
    const meta: any = await generateMetadata(params('hidden-talk') as any, parent);
    expect(meta).toEqual({ title: 'SEDS Pakistan — Events', description: 'SEDS Pakistan' });
    expect(JSON.stringify(meta)).not.toContain('Hidden Talk Title');
    expect(JSON.stringify(meta)).not.toContain('hidden.png');
  });

  it('E-DET-01 lookup is by document id only: a slug FIELD that differs from the doc id is not found', async () => {
    const db = mockDbHolder.db as FakeDb;
    // Stored slug field 'space-talk' under document id 'evt-9'.
    db.seed('events', 'evt-9', { title: 'Space Talk I', status: 'published', slug: 'space-talk', description: 'x' });
    const bySlugField: any = await generateMetadata(params('space-talk') as any, parent);
    expect(bySlugField.title).toBe('Event Not Found | SEDS Pakistan');
    const byDocId: any = await generateMetadata(params('evt-9') as any, parent);
    expect(byDocId.title).toBe('Space Talk I | SEDS Pakistan');
  });

  it('E-DET-03 a missing database yields the catch fallback shape, not a throw', async () => {
    mockDbHolder.db = null;
    const meta: any = await generateMetadata(params('space-talk') as any, parent);
    expect(meta.title).toBe('Event | SEDS Pakistan');
    expect(meta.description).toBe('Check out this event on SEDS Pakistan.');
  });

  it('E-DET-04 the client detail page collapses missing and non-viewable events into one Not Found treatment (source pin)', () => {
    const client = readSrc('src/app/events/[slug]/_event-client.tsx');
    expect(client).toContain('if (!event || !viewerCanView)');
    expect(client).toContain('Event Not Found');
    expect(client).toContain('This event does not exist or is not published.');
    // The client lookup is the same doc-id lookup as the OG path.
    expect(client).toContain("return doc(firestore, 'events', slug);");
    const server = readSrc('src/app/events/[slug]/page.tsx');
    expect(server).toContain("await db.collection('events').doc(slug).get()");
  });
});
