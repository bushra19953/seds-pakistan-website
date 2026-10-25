/**
 * VERDICT suite for the announcements Supabase migration — committed
 * copy of the external verdict suite preserved at
 * ~/workspace/supabase-migration/announcements-verdict/
 * announcements-supa-verdict.test.ts (written against the
 * feat/supa-announcements draft snapshot, 2026-10-25 ~06:17 UTC),
 * adopted unchanged in its assertions by the routes build
 * (feat/supa-ann-routes). It now runs against the adapter-backed seam
 * on the merged tree; the pure seam functions it exercises
 * (selectVisibleAnnouncements, announcementDocFromSupaRow,
 * supaTimestampToIso, serializeAnnouncementForSupa) are the same code
 * the new routes serve through the adapter bridge.
 *
 * Runs the contracts from announcements-contracts.test.ts against the
 * migrated seam (src/lib/announcements-supa.ts):
 *  - selectVisibleAnnouncements over fs_announcements-shaped rows,
 *    fixtures in BOTH jsonb timestamp representations: the Admin-SDK
 *    dump shape { _seconds, _nanoseconds } (migrate_db.js) and the
 *    mirror-write ISO-string shape (serializeAnnouncementForSupa).
 *  - fetchVisibleAnnouncements with NEXT_PUBLIC_SUPA_SURFACES=
 *    announcements and a mocked global fetch standing in for
 *    GET /api/announcements/visible (the mock serves the seam's own
 *    selectVisibleAnnouncements output; the REAL route is covered by
 *    src/app/api/announcements/visible/__tests__/route.test.ts).
 *  - the fallback property: flag ON + route failure == flag OFF.
 *
 * Tests are written against the CONTRACT expectations; a failing test
 * here is a filed drift verdict, not a test bug.
 */

jest.mock('firebase/firestore', () => {
  class FakeTimestamp {
    private ms: number;
    constructor(ms: number) {
      this.ms = ms;
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(ms);
    }
    static fromDate(d: Date) {
      return new FakeTimestamp(d.getTime());
    }
    static now() {
      return new FakeTimestamp(Date.now());
    }
    toDate() {
      return new Date(this.ms);
    }
    toMillis() {
      return this.ms;
    }
    get seconds() {
      return Math.floor(this.ms / 1000);
    }
    get nanoseconds() {
      return (this.ms % 1000) * 1e6;
    }
  }
  return {
    Timestamp: FakeTimestamp,
    collection: jest.fn((_db: any, name: string) => ({
      _name: name,
      withConverter: (converter: any) => ({ _name: name, _converter: converter }),
    })),
    query: jest.fn((ref: any, ...constraints: any[]) => ({ _ref: ref, _constraints: constraints })),
    where: jest.fn((field: string, op: string, value: any) => ({ _kind: 'where', field, op, value })),
    orderBy: jest.fn((field: string, dir: string) => ({ _kind: 'orderBy', field, dir })),
    limit: jest.fn((n: number) => ({ _kind: 'limit', n })),
    // The verdict suite never reads through the Firestore fake except
    // in the fallback test, where an empty result is the assertion.
    getDocs: jest.fn(async () => ({ docs: [] })),
    getFirestore: jest.fn(() => ({})),
  };
});

jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({
    currentUser: { getIdToken: async () => 'verdict-token' },
  })),
}));

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: jest.fn(() => ({})),
}));

jest.mock('@/lib/roles', () => {
  const actual = jest.requireActual('@/lib/roles');
  return { ...actual, isSuperAdmin: () => false };
});

import {
  announcementAudienceValuesForViewer,
  fetchVisibleAnnouncements,
  invalidateVisibleAnnouncementsCache,
  isAnnouncementVisibleTo,
  isAnnouncementDue,
  resolveAnnouncementViewer,
  type AnnouncementDoc,
} from '@/lib/announcements';
import {
  announcementDocFromSupaRow,
  selectVisibleAnnouncements,
  serializeAnnouncementForSupa,
  supaTimestampToIso,
} from '@/lib/announcements-supa';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const anon = resolveAnnouncementViewer();
const member = resolveAnnouncementViewer({ uid: 'm1', role: 'Member' });
const officer = resolveAnnouncementViewer({ uid: 'o1', role: 'chapter_president' });

const dumpShape = (ms: number) => ({
  _seconds: Math.floor(ms / 1000),
  _nanoseconds: (ms % 1000) * 1e6,
});
const isoShape = (ms: number) => new Date(ms).toISOString();

type Enc = (ms: number) => unknown;
function logicalDocs(enc: Enc): Array<{ id: string; data: Record<string, any> }> {
  const base = (o: Record<string, any>) => ({
    content: 'body',
    status: 'published',
    isFeatured: false,
    priority: 1,
    ctaText: '',
    ctaLink: '',
    ctaExpiredText: '',
    expiresAt: null,
    publish_date: enc(NOW - DAY),
    ...o,
  });
  return [
    { id: 'pub-a', data: base({ title: 'Pub A', audience: 'public', updated_at: enc(NOW - 500) }) },
    { id: 'pub-b', data: base({ title: 'Pub B', audience: 'public', updated_at: enc(NOW - 100) }) },
    { id: 'due-exact', data: base({ title: 'Due', audience: 'public', publish_date: enc(NOW), updated_at: enc(NOW - 200) }) },
    { id: 'future-1', data: base({ title: 'Future', audience: 'public', publish_date: enc(NOW + HOUR), updated_at: enc(NOW - 50) }) },
    { id: 'draft-1', data: base({ title: 'Draft', audience: 'public', status: 'draft', updated_at: enc(NOW - 10) }) },
    { id: 'expired-1', data: base({ title: 'Old', audience: 'public', expiresAt: enc(NOW - HOUR), updated_at: enc(NOW - 300) }) },
    { id: 'featured-pub', data: base({ title: 'FP', audience: 'public', isFeatured: true, updated_at: enc(NOW - 400) }) },
    { id: 'no-updated', data: base({ title: 'NoUpd', audience: 'public', updated_at: undefined }) },
    {
      id: 'rogue-id',
      data: base({ title: 'Rogue', audience: 'public', id: 'impostor', updated_at: enc(NOW - 600), slug: 'rogue', created_by: 'admin1', showInTicker: true }),
    },
    { id: 'legacy-all', data: base({ title: 'Legacy', audience: 'all', updated_at: enc(NOW - 1) }) },
    { id: 'mem-1', data: base({ title: 'Mem', audience: 'members', updated_at: enc(NOW - 100) }) },
    { id: 'featured-mem', data: base({ title: 'FM', audience: 'members', isFeatured: true, updated_at: enc(NOW - 100) }) },
    { id: 'off-1', data: base({ title: 'Off', audience: 'officers', updated_at: enc(NOW - 100) }) },
    { id: 'legacy-tl', data: base({ title: 'TL', audience: 'team_leaders', updated_at: enc(NOW - 100) }) },
  ].map((r) => {
    const data = { ...r.data };
    if (data.updated_at === undefined) delete data.updated_at;
    return { id: r.id, data };
  });
}

const ids = (docs: AnnouncementDoc[]) => docs.map((d) => d.id);
const CONTRACT_ANON = ['pub-b', 'due-exact', 'expired-1', 'featured-pub', 'pub-a', 'rogue-id', 'legacy-all'];

describe.each([
  ['admin-dump {_seconds,_nanoseconds}', dumpShape as Enc],
  ['mirror-write ISO strings', isoShape as Enc],
])('selectVisibleAnnouncements, %s representation', (_label, enc) => {
  const rows = logicalDocs(enc);

  it('C-AUD-01 tier sets: no leakage across tiers (set equality)', () => {
    const anonIds = new Set(ids(selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW)));
    for (const expected of CONTRACT_ANON) expect(anonIds.has(expected)).toBe(true);
    for (const forbidden of ['mem-1', 'featured-mem', 'off-1', 'legacy-tl', 'future-1', 'draft-1']) {
      expect(anonIds.has(forbidden)).toBe(false);
    }
    const officerIds = new Set(ids(selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(officer), {}, NOW)));
    for (const expected of [...CONTRACT_ANON, 'mem-1', 'featured-mem', 'off-1', 'legacy-tl']) {
      expect(officerIds.has(expected)).toBe(true);
    }
  });

  it('C-ORD-01/C-AUD-04 merged sequence matches the Firestore contract exactly', () => {
    const docs = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW);
    expect(ids(docs)).toEqual(CONTRACT_ANON);
  });

  it('C-ORD-02 per-split limit and featured selection hold', () => {
    const limited = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), { limitCount: 2 }, NOW);
    expect(ids(limited)).toEqual(['pub-b', 'due-exact', 'legacy-all']);
    const featured = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(officer), { isFeatured: true, limitCount: 8 }, NOW);
    expect(ids(featured)).toEqual(['featured-pub', 'featured-mem']);
  });

  it('C-AUD-05 expired doc is selected (predicate layer removes it, unchanged)', () => {
    const docs = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW);
    const expired = docs.find((d) => d.id === 'expired-1');
    expect(expired).toBeDefined();
    expect(isAnnouncementVisibleTo(expired!, anon, NOW)).toBe(false);
  });

  it('C-SHP-01 projection: exactly the 13 converter keys reach the consumer', () => {
    const docs = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW);
    const rogue = docs.find((d) => d.id === 'rogue-id') as any;
    expect(Object.keys(rogue).sort()).toEqual(
      [
        'id', 'title', 'content', 'audience', 'status', 'isFeatured',
        'priority', 'ctaText', 'ctaLink', 'ctaExpiredText', 'expiresAt',
        'publish_date', 'updated_at',
      ].sort()
    );
  });

  it('C-SHP-02/C-SHP-03 defaults and id precedence', () => {
    const docs = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW);
    const due = docs.find((d) => d.id === 'due-exact') as any;
    expect(due.priority).toBe(1); // stored priority survives
    const rogue = docs.find((d) => d.id === 'rogue-id') as any;
    expect(rogue.id).toBe('rogue-id'); // row id wins over the stored field
  });

  it('C-TS-01 timestamps arrive as ISO strings carrying the stored instant', () => {
    const docs = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW);
    const pubB = docs.find((d) => d.id === 'pub-b') as any;
    expect(typeof pubB.publish_date).toBe('string');
    expect(Date.parse(pubB.publish_date)).toBe(NOW - DAY);
    expect(typeof pubB.updated_at).toBe('string');
    expect(Date.parse(pubB.updated_at)).toBe(NOW - 100);
  });

  it('C-TS-03 poison shape is neutralized: scheduled stays scheduled, expired stays expired', () => {
    const docs = selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW);
    expect(ids(docs)).not.toContain('future-1');
    const expired = docs.find((d) => d.id === 'expired-1')!;
    expect(isAnnouncementVisibleTo(expired, anon, NOW)).toBe(false);
    const due = docs.find((d) => d.id === 'due-exact')!;
    expect(isAnnouncementDue(due, NOW)).toBe(true);
  });
});

describe('supaTimestampToIso representation matrix', () => {
  const ms = NOW - 123_456;
  it('normalizes every stored representation to the same instant', () => {
    const expected = new Date(ms).toISOString();
    expect(supaTimestampToIso(dumpShape(ms))).toBe(expected);
    expect(supaTimestampToIso({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 })).toBe(expected);
    expect(supaTimestampToIso(isoShape(ms))).toBe(expected);
    expect(supaTimestampToIso(ms)).toBe(expected);
    expect(supaTimestampToIso(new Date(ms))).toBe(expected);
    expect(supaTimestampToIso({ toDate: () => new Date(ms) })).toBe(expected);
  });
  it('returns null for null/absent/unparseable', () => {
    expect(supaTimestampToIso(null)).toBeNull();
    expect(supaTimestampToIso(undefined)).toBeNull();
    expect(supaTimestampToIso('not a date')).toBeNull();
    expect(supaTimestampToIso({})).toBeNull();
  });
  it('announcementDocFromSupaRow: publish_date always present (null when absent)', () => {
    const doc = announcementDocFromSupaRow({ id: 'bare', data: { title: 'B', status: 'published', audience: 'public' } });
    expect(doc.publish_date).toBeNull();
    expect(doc.id).toBe('bare');
  });
  it('C-SHP-02 converter defaults: a stored doc without priority reads back priority 0', () => {
    const doc = announcementDocFromSupaRow({ id: 'bare', data: { title: 'B', status: 'published', audience: 'public' } }) as any;
    expect(doc.priority).toBe(0);
  });
});

describe('C-WRT mirror serialization', () => {
  it('serializeAnnouncementForSupa turns Timestamps and serverTimestamp sentinels into ISO strings', () => {
    const out = serializeAnnouncementForSupa({
      publish_date: { toDate: () => new Date(NOW - DAY) },
      updated_at: { _methodName: 'serverTimestamp' },
      expiresAt: null,
      nested: { at: dumpShape(NOW) },
      title: 'T',
    });
    expect(out.publish_date).toBe(new Date(NOW - DAY).toISOString());
    expect(typeof out.updated_at).toBe('string');
    expect(Math.abs(Date.parse(out.updated_at) - Date.now())).toBeLessThan(60_000);
    expect(out.expiresAt).toBeNull();
    expect(out.nested.at).toBe(new Date(NOW).toISOString());
    expect(out.title).toBe('T');
  });
});

describe('flag ON end-to-end (mocked visible route) and fallback', () => {
  const rows = logicalDocs(dumpShape as Enc);
  const realFetch = global.fetch;
  let fetchCalls = 0;

  const routeResponse = (viewer: typeof anon) => ({
    ok: true,
    status: 200,
    json: async () => ({
      announcements: selectVisibleAnnouncements(
        rows,
        announcementAudienceValuesForViewer(viewer),
        {},
        NOW
      ),
      audienceValues: announcementAudienceValuesForViewer(viewer),
    }),
  });

  beforeEach(() => {
    invalidateVisibleAnnouncementsCache();
    fetchCalls = 0;
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'announcements';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
    global.fetch = realFetch;
  });

  it('C-AUD-01 via route: anonymous set matches the seam selection (incl. known drift)', async () => {
    global.fetch = jest.fn(async () => {
      fetchCalls += 1;
      return routeResponse(anon);
    }) as any;
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(ids(docs)).toEqual(ids(selectVisibleAnnouncements(rows, announcementAudienceValuesForViewer(anon), {}, NOW)));
    expect(ids(docs)).not.toContain('mem-1');
    expect(ids(docs)).not.toContain('off-1');
  });

  it('C-MEMO-01 flag ON: the memo still dedupes the route fetch within the TTL', async () => {
    global.fetch = jest.fn(async () => {
      fetchCalls += 1;
      return routeResponse(member);
    }) as any;
    const first = await fetchVisibleAnnouncements({} as any, member, {}, NOW);
    const second = await fetchVisibleAnnouncements({} as any, member, {}, NOW + 60_000);
    expect(second).toBe(first);
    expect(fetchCalls).toBe(1);
  });

  it('fallback: flag ON + route failure behaves exactly as flag OFF (Firestore path)', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(docs).toEqual([]); // the fake Firestore is empty in this suite
  });
});
