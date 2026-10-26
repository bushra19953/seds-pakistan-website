/**
 * Behavior contracts for the announcements read/write surface, recorded
 * from the CURRENT Firestore implementation (feat/integration-wave3 @
 * 4d5a1e16) ahead of the Supabase read migration (feat/supa-announcements).
 *
 * Purpose: the migration swaps the store behind these helpers (Firestore
 * documents -> fs_announcements jsonb rows) behind a default-OFF flag
 * with Firestore fallback. Every contract below is stated at the
 * boundary consumers actually depend on, so the SAME suite must pass
 * against the migrated implementation with the flag ON (adapter mocked
 * with these fixtures in jsonb representation) and OFF. Verdicts are
 * filed per contract id.
 *
 * Contract inventory:
 *   C-AUD-01  Audience leakage: the merged fetch for a viewer contains
 *             ONLY the audience tiers that viewer may enumerate
 *             (anon: public+all; member: +members; officer/founder:
 *             +officers+team_leaders). No restricted id leaks downward.
 *   C-AUD-02  Drafts never reach any non-admin fetch (query-layer
 *             status filter, not the consumer predicate).
 *   C-AUD-03  A future-dated (scheduled) announcement is excluded at
 *             the query layer (publish_date <= now); publish_date
 *             exactly == now is included (inclusive bound).
 *   C-AUD-04  A document with no updated_at is excluded entirely
 *             (Firestore orderBy semantics drop documents missing the
 *             ordered field).
 *   C-AUD-05  Expiry is NOT enforced by the fetch: an expired but
 *             published, due, in-tier document IS returned; consumers
 *             filter it via isAnnouncementVisibleTo / local isExpired.
 *   C-ORD-01  Merged order = split emission order (audience values in
 *             announcementAudienceValuesForViewer order), updated_at
 *             DESC within each split. The fetch does NOT sort globally:
 *             /notifications renders this order as-is, so a globally
 *             sorted adapter result is ordering drift.
 *   C-ORD-02  The per-split limit caps each audience split separately,
 *             never the merged total (bell: 10/split; pages: 50/split;
 *             carousel/banner: 8/split + featured).
 *   C-SHP-01  Returned documents carry exactly the converter projection
 *             (13 keys incl. id); stored-only fields (slug, meta_*,
 *             created_at, created_by, showInTicker) never surface.
 *   C-SHP-02  priority defaults to 0 when the stored document omits it;
 *             a stored priority passes through untouched.
 *   C-SHP-03  The document id in the result is the document id, even
 *             when the stored data carries a rogue id field.
 *   C-TS-01   Timestamp fields (publish_date, expiresAt, updated_at)
 *             pass through the fetch untransformed: on the current tree
 *             they are Timestamp instances whose instant is the stored
 *             instant. Migration clause: the adapter may change the
 *             representation ONLY to one the shared normalization
 *             resolves to the same instant (see C-TS-02).
 *   C-TS-02   Representation equivalence at the predicate layer:
 *             Timestamp-like, ISO string, and epoch-millis forms of the
 *             same instant produce IDENTICAL due/expired/visible
 *             decisions and identical consumer sort keys.
 *   C-TS-03   POISON SHAPE: a raw serialized timestamp object
 *             ({seconds,nanoseconds} or {_seconds,_nanoseconds} — what
 *             JSON.stringify of a Firestore Timestamp produces, and
 *             therefore what the fs_announcements jsonb column holds)
 *             is treated as null by the lib normalization: a future
 *             publish_date reads as DUE and a past expiresAt reads as
 *             NOT expired. The page sort comparator yields NaN for it;
 *             the bell normalizer yields null. The adapter MUST
 *             normalize this shape to an ISO string (or Timestamp-like)
 *             on read; emitting it raw is silent schedule/expiry
 *             corruption. Pinned here as current behavior so the hazard
 *             is on record, not as desired behavior.
 *   C-MEMO-01 Memo key = viewer audience-value set + options: a second
 *             fetch for the same shape within the TTL performs no new
 *             reads and returns the same array.
 *   C-MEMO-02 No cross-shape leakage through the memo: fetching as a
 *             member does not serve a later officer fetch (which must
 *             run its own round and include the officers tier), and an
 *             officer fetch never serves a later anonymous fetch.
 *   C-MEMO-03 A rejected fetch evicts itself: the next caller retries
 *             instead of serving a cached failure for the whole window.
 *   C-MEMO-04 After the TTL the next fetch re-reads; an explicit
 *             invalidateVisibleAnnouncementsCache() forces a re-read.
 *   C-QRY-01  Split emission order and constraints per consumer option
 *             set: bell {limit 10}, pages {limit 50 =
 *             ANNOUNCEMENT_LIST_LIMIT_COUNT}, featured surfaces
 *             {isFeatured == true, limit 8}; every split carries
 *             status == published, its audience value, publish_date
 *             <= now (a Timestamp of the fetch instant), and
 *             orderBy updated_at desc.
 *   C-WRT-01  The converter write shape: exactly the 12 stored fields,
 *             defaults isFeatured=false / priority=0 / null dates, and
 *             the audience stored VERBATIM (normalization is the admin
 *             writer's job, not the converter's).
 *   C-WRT-02  The converter read projection defaults: priority 0,
 *             publish_date null when absent.
 *   C-WRT-03  Admin write effects (source-pinned, this repo's
 *             convention for this surface): audience normalized at
 *             write; publish_date is Timestamp.fromDate(picked) or
 *             Timestamp.now() — never null; updated_at is
 *             serverTimestamp() on create AND edit; created_at /
 *             created_by only on create; status toggle flips
 *             published <-> draft; delete is a hard deleteDoc.
 *             Since WS10 the writer is split: the page builds the
 *             payload (dates as ISO strings) and POST
 *             /api/admin/announcements performs the Firestore write,
 *             converting dates back to Timestamps and stamping
 *             serverTimestamp fields; the pins follow the split.
 *   C-WRT-04  Write -> read round trip: a document as the admin writer
 *             stores it (legacy audience input normalized at write,
 *             publish_date = now) is immediately visible to its tier
 *             and invisible below it.
 *
 * The fake Firestore below implements exactly the query semantics the
 * production path relies on (equality splits, publish_date <= with a
 * Timestamp cutoff, orderBy updated_at desc dropping documents that
 * lack the field, per-split limit, converter projection on data()).
 * Fixtures store publish_date/updated_at as Timestamps, which is what
 * the admin writer writes and what live reads return; other timestamp
 * representations are exercised at the predicate layer (C-TS-02/03),
 * where this codebase's own code defines the behavior.
 */

jest.mock('firebase/firestore', () => {
  class FakeTimestamp {
    _millis: number;
    constructor(millis: number) {
      this._millis = millis;
    }
    static fromDate(d: Date) {
      return new FakeTimestamp(d.getTime());
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(ms);
    }
    static now() {
      return new FakeTimestamp(Date.now());
    }
    toDate() {
      return new Date(this._millis);
    }
    toMillis() {
      return this._millis;
    }
    get seconds() {
      return Math.floor(this._millis / 1000);
    }
    get nanoseconds() {
      return (this._millis % 1000) * 1e6;
    }
  }

  const fake: {
    docs: any[];
    calls: any[];
    failNext: boolean;
  } = { docs: [], calls: [], failNext: false };

  function millisOf(v: any): number | null {
    if (!v) return null;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (v instanceof Date) return v.getTime();
    return null;
  }

  function evaluate(q: any) {
    const wheres = q.constraints.filter((c: any) => c.kind === 'where');
    const orderBys = q.constraints.filter((c: any) => c.kind === 'orderBy');
    const limits = q.constraints.filter((c: any) => c.kind === 'limit');
    let rows = [...fake.docs];
    for (const w of wheres) {
      if (w.op === '==') {
        rows = rows.filter((d) => d[w.field] === w.value);
      } else if (w.field === 'publish_date' && w.op === '<=') {
        const cutoff = millisOf(w.value);
        rows = rows.filter((d) => {
          const m = millisOf(d.publish_date);
          return m !== null && cutoff !== null && m <= cutoff;
        });
      }
    }
    for (const o of orderBys) {
      // Firestore orderBy drops documents missing the ordered field.
      rows = rows.filter((d) => millisOf(d[o.field]) !== null);
      rows.sort((a, b) => {
        const diff = (millisOf(a[o.field]) as number) - (millisOf(b[o.field]) as number);
        return o.dir === 'desc' ? -diff : diff;
      });
    }
    if (limits.length) rows = rows.slice(0, limits[0].n);
    const converter = q.ref?.converter;
    return {
      docs: rows.map((d) => {
        const { _id, ...stored } = d;
        return {
          id: _id,
          data: () =>
            converter
              ? converter.fromFirestore({ id: _id, data: () => stored })
              : stored,
        };
      }),
    };
  }

  return {
    Timestamp: FakeTimestamp,
    collection: jest.fn((_db: any, name: string) => ({
      _collection: name,
      withConverter: (converter: any) => ({ _collection: name, converter }),
    })),
    query: jest.fn((ref: any, ...constraints: any[]) => ({ ref, constraints })),
    where: jest.fn((field: string, op: string, value: any) => ({
      kind: 'where',
      field,
      op,
      value,
    })),
    orderBy: jest.fn((field: string, dir: string) => ({ kind: 'orderBy', field, dir })),
    limit: jest.fn((n: number) => ({ kind: 'limit', n })),
    getDocs: jest.fn((q: any) => {
      fake.calls.push(q);
      if (fake.failNext) {
        fake.failNext = false;
        return Promise.reject(new Error('fake firestore failure'));
      }
      return Promise.resolve(evaluate(q));
    }),
    __fake: fake,
  };
});

import { Timestamp } from 'firebase/firestore';
import {
  announcementConverter,
  announcementAudienceValuesForViewer,
  ANNOUNCEMENT_FETCH_MEMO_TTL_MS,
  ANNOUNCEMENT_LIST_LIMIT_COUNT,
  fetchVisibleAnnouncements,
  FOUNDER_UID,
  invalidateVisibleAnnouncementsCache,
  isAnnouncementDue,
  isAnnouncementVisibleTo,
  normalizeAudience,
  resolveAnnouncementViewer,
  visibleAnnouncementQueries,
  announcementsCollection,
} from '@/lib/announcements';

const firestoreMock: any = jest.requireMock('firebase/firestore');
const fake = firestoreMock.__fake;

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ts = (millis: number) => (Timestamp as any).fromMillis(millis);

function fixtureDocs(): any[] {
  const base = {
    status: 'published',
    publish_date: ts(NOW - DAY),
    content: 'body',
    ctaText: '',
    ctaLink: '',
    ctaExpiredText: '',
    expiresAt: null,
    isFeatured: false,
  };
  return [
    { ...base, _id: 'pub-b', title: 'Public newer', audience: 'public', updated_at: ts(NOW - 1000), priority: 5, slug: 'public-newer', meta_title: 'x', created_at: ts(NOW - DAY), created_by: 'admin1', showInTicker: true },
    { ...base, _id: 'due-exact', title: 'Due exactly now', audience: 'public', publish_date: ts(NOW), updated_at: ts(NOW - 2000) },
    { ...base, _id: 'expired-1', title: 'Expired', audience: 'public', expiresAt: ts(NOW - 1000), updated_at: ts(NOW - 3000) },
    { ...base, _id: 'featured-pub', title: 'Featured public', audience: 'public', isFeatured: true, updated_at: ts(NOW - 4000) },
    { ...base, _id: 'pub-a', title: 'Public older', audience: 'public', updated_at: ts(NOW - 5000) },
    { ...base, _id: 'rogue-id', id: 'ROGUE', title: 'Rogue id', audience: 'public', updated_at: ts(NOW - 6000) },
    { ...base, _id: 'legacy-all', title: 'Legacy all', audience: 'all', updated_at: ts(NOW - 500) },
    { ...base, _id: 'mem-1', title: 'Members post', audience: 'members', updated_at: ts(NOW - 100) },
    { ...base, _id: 'featured-mem', title: 'Featured members', audience: 'members', isFeatured: true, updated_at: ts(NOW - 100) },
    { ...base, _id: 'off-1', title: 'Officers post', audience: 'officers', updated_at: ts(NOW - 100) },
    { ...base, _id: 'legacy-tl', title: 'Legacy team leaders', audience: 'team_leaders', updated_at: ts(NOW - 100) },
    { ...base, _id: 'draft-1', title: 'Draft', status: 'draft', audience: 'public', updated_at: ts(NOW - 100) },
    { ...base, _id: 'future-1', title: 'Scheduled', audience: 'public', publish_date: ts(NOW + DAY), updated_at: ts(NOW - 100) },
    { ...base, _id: 'no-updated', title: 'No updated_at', audience: 'public', updated_at: undefined },
  ];
}

const PUBLIC_MERGED = ['pub-b', 'due-exact', 'expired-1', 'featured-pub', 'pub-a', 'rogue-id', 'legacy-all'];

const anon = resolveAnnouncementViewer({ signedIn: false });
const member = resolveAnnouncementViewer({ uid: 'm1', role: 'team_member' });
const officer = resolveAnnouncementViewer({ uid: 'o1', role: 'chapter_president' });
const founder = resolveAnnouncementViewer({ uid: FOUNDER_UID, role: 'member' });

const ids = (docs: any[]) => docs.map((d) => d.id);

beforeEach(() => {
  fake.docs = fixtureDocs();
  fake.calls = [];
  fake.failNext = false;
  invalidateVisibleAnnouncementsCache();
});

describe('fetch contracts: audience tiers and leakage (C-AUD)', () => {
  it('C-AUD-01 anonymous fetch returns only the public tier, in merged split order', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(ids(docs)).toEqual(PUBLIC_MERGED);
    for (const restricted of ['mem-1', 'featured-mem', 'off-1', 'legacy-tl']) {
      expect(ids(docs)).not.toContain(restricted);
    }
  });

  it('C-AUD-01 member fetch adds the members tier and nothing above it', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, member, {}, NOW);
    expect(ids(docs)).toEqual([...PUBLIC_MERGED, 'mem-1', 'featured-mem']);
    expect(ids(docs)).not.toContain('off-1');
    expect(ids(docs)).not.toContain('legacy-tl');
  });

  it('C-AUD-01 officer fetch adds officers and legacy team_leaders tiers', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, officer, {}, NOW);
    expect(ids(docs)).toEqual([...PUBLIC_MERGED, 'mem-1', 'featured-mem', 'off-1', 'legacy-tl']);
  });

  it('C-AUD-01 founder (by UID, non-officer role) receives the officer set', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, founder, {}, NOW);
    expect(ids(docs)).toEqual([...PUBLIC_MERGED, 'mem-1', 'featured-mem', 'off-1', 'legacy-tl']);
  });

  it('C-AUD-01/C-ORD-01 no result ever contains a duplicate id', async () => {
    for (const viewer of [anon, member, officer, founder]) {
      const docs = await fetchVisibleAnnouncements({} as any, viewer, {}, NOW);
      expect(new Set(ids(docs)).size).toBe(docs.length);
    }
  });

  it('C-AUD-02/C-AUD-03/C-AUD-04 drafts, scheduled, and updated_at-less docs are excluded at the query layer', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, officer, {}, NOW);
    for (const excluded of ['draft-1', 'future-1', 'no-updated']) {
      expect(ids(docs)).not.toContain(excluded);
    }
    // publish_date exactly == now is due (inclusive <= bound).
    expect(ids(docs)).toContain('due-exact');
  });

  it('C-AUD-05 the fetch returns expired documents; the predicate is what filters them', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    const expired = docs.find((d) => d.id === 'expired-1');
    expect(expired).toBeDefined();
    expect(isAnnouncementVisibleTo(expired, anon, NOW)).toBe(false);
    const visible = docs.filter((d) => isAnnouncementVisibleTo(d, anon, NOW));
    expect(ids(visible)).not.toContain('expired-1');
  });
});

describe('fetch contracts: ordering and limits (C-ORD)', () => {
  it('C-ORD-01 merged order groups by audience value, updated_at desc inside each split (NOT global order)', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    // legacy-all has the newest updated_at of the public tier yet sorts
    // AFTER every 'public' document, because the 'all' split is emitted
    // second. /notifications renders this order verbatim.
    expect(ids(docs).indexOf('legacy-all')).toBe(PUBLIC_MERGED.length - 1);
    expect(ids(docs).slice(0, 6)).toEqual(['pub-b', 'due-exact', 'expired-1', 'featured-pub', 'pub-a', 'rogue-id']);
  });

  it('C-ORD-02 the limit caps each split separately, never the merged total', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, { limitCount: 2 }, NOW);
    expect(ids(docs)).toEqual(['pub-b', 'due-exact', 'legacy-all']);
  });

  it('C-ORD-02 the featured option filters at the query layer, per viewer tier', async () => {
    const officerFeatured = await fetchVisibleAnnouncements({} as any, officer, { isFeatured: true }, NOW);
    expect(ids(officerFeatured)).toEqual(['featured-pub', 'featured-mem']);
    invalidateVisibleAnnouncementsCache();
    const anonFeatured = await fetchVisibleAnnouncements({} as any, anon, { isFeatured: true }, NOW);
    expect(ids(anonFeatured)).toEqual(['featured-pub']);
  });
});

describe('fetch contracts: document shape (C-SHP)', () => {
  it('C-SHP-01 returned docs carry exactly the converter projection; stored-only fields never surface', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    const pub = docs.find((d) => d.id === 'pub-b') as any;
    expect(Object.keys(pub).sort()).toEqual(
      [
        'audience', 'content', 'ctaExpiredText', 'ctaLink', 'ctaText',
        'expiresAt', 'id', 'isFeatured', 'priority', 'publish_date',
        'status', 'title', 'updated_at',
      ].sort()
    );
    expect(pub.slug).toBeUndefined();
    expect(pub.created_at).toBeUndefined();
    expect(pub.created_by).toBeUndefined();
    expect(pub.showInTicker).toBeUndefined();
  });

  it('C-SHP-02 priority defaults to 0 when stored without one and passes through when stored', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect((docs.find((d) => d.id === 'due-exact') as any).priority).toBe(0);
    expect((docs.find((d) => d.id === 'pub-b') as any).priority).toBe(5);
  });

  it('C-SHP-03 the result id is the document id even when stored data carries a rogue id', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    const rogue = docs.find((d) => d.title === 'Rogue id') as any;
    expect(rogue.id).toBe('rogue-id');
  });

  it('C-TS-01 timestamp fields pass through untransformed with their stored instant', async () => {
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    const pub = docs.find((d) => d.id === 'pub-b') as any;
    expect(typeof pub.publish_date.toDate).toBe('function');
    expect(pub.publish_date.toMillis()).toBe(NOW - DAY);
    expect(pub.updated_at.toMillis()).toBe(NOW - 1000);
    const expired = docs.find((d) => d.id === 'expired-1') as any;
    expect(expired.expiresAt.toMillis()).toBe(NOW - 1000);
  });
});

describe('fetch contracts: memoization (C-MEMO)', () => {
  it('C-MEMO-01 a second fetch for the same viewer shape and options performs no new reads', async () => {
    const first = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(fake.calls).toHaveLength(2); // public + all splits
    const second = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(fake.calls).toHaveLength(2);
    expect(second).toBe(first);
  });

  it('C-MEMO-01 different options are a different cache entry', async () => {
    await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    await fetchVisibleAnnouncements({} as any, anon, { limitCount: 10 }, NOW);
    expect(fake.calls).toHaveLength(4);
  });

  it('C-MEMO-02 no cross-shape leakage: member, officer, and anonymous fetches each run their own round', async () => {
    const memberDocs = await fetchVisibleAnnouncements({} as any, member, {}, NOW);
    expect(fake.calls).toHaveLength(3);
    expect(ids(memberDocs)).not.toContain('off-1');

    const officerDocs = await fetchVisibleAnnouncements({} as any, officer, {}, NOW);
    expect(fake.calls).toHaveLength(3 + 5);
    expect(ids(officerDocs)).toContain('off-1');

    const anonDocs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(fake.calls).toHaveLength(3 + 5 + 2);
    expect(ids(anonDocs)).not.toContain('mem-1');
    expect(ids(anonDocs)).not.toContain('off-1');
  });

  it('C-MEMO-03 a rejected fetch evicts itself so the next caller retries', async () => {
    fake.failNext = true;
    await expect(fetchVisibleAnnouncements({} as any, anon, {}, NOW)).rejects.toThrow(
      'fake firestore failure'
    );
    const callsAfterFailure = fake.calls.length;
    const docs = await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
    expect(fake.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(ids(docs)).toEqual(PUBLIC_MERGED);
  });

  it('C-MEMO-04 the memo expires after the TTL and invalidate forces a re-read', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = 1_700_000_000_000;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
      const calls = fake.calls.length;
      fakeNow += ANNOUNCEMENT_FETCH_MEMO_TTL_MS - 1;
      await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
      expect(fake.calls).toHaveLength(calls);
      fakeNow += 2;
      await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
      expect(fake.calls).toHaveLength(calls + 2);
      invalidateVisibleAnnouncementsCache();
      await fetchVisibleAnnouncements({} as any, anon, {}, NOW);
      expect(fake.calls).toHaveLength(calls + 4);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('query emission contracts per consumer (C-QRY-01)', () => {
  const ref: any = announcementsCollection({} as any);

  function splitsFor(viewer: any, options: any) {
    return visibleAnnouncementQueries(ref, viewer, NOW, options) as any[];
  }
  const audienceSeq = (qs: any[]) =>
    qs.map((q) => q.constraints.find((c: any) => c.kind === 'where' && c.field === 'audience')?.value);

  it('audience values are emitted in tier order per viewer shape', () => {
    expect(audienceSeq(splitsFor(anon, {}))).toEqual(['public', 'all']);
    expect(audienceSeq(splitsFor(member, {}))).toEqual(['public', 'all', 'members']);
    expect(audienceSeq(splitsFor(officer, {}))).toEqual(['public', 'all', 'members', 'officers', 'team_leaders']);
    expect(announcementAudienceValuesForViewer(founder)).toEqual(['public', 'all', 'members', 'officers', 'team_leaders']);
  });

  it('bell options {limit 10}: every split carries the full constraint set', () => {
    for (const q of splitsFor(member, { limitCount: 10 })) {
      const ws = q.constraints.filter((c: any) => c.kind === 'where');
      expect(ws.some((w: any) => w.field === 'status' && w.op === '==' && w.value === 'published')).toBe(true);
      const pd = ws.filter((w: any) => w.field === 'publish_date');
      expect(pd).toHaveLength(1);
      expect(pd[0].op).toBe('<=');
      expect(pd[0].value.toMillis()).toBe(NOW);
      const ob = q.constraints.filter((c: any) => c.kind === 'orderBy');
      expect(ob).toEqual([expect.objectContaining({ field: 'updated_at', dir: 'desc' })]);
      const lim = q.constraints.filter((c: any) => c.kind === 'limit');
      expect(lim).toEqual([expect.objectContaining({ n: 10 })]);
    }
  });

  it('page options {limit ANNOUNCEMENT_LIST_LIMIT_COUNT}: the shared list cap lands on every split', () => {
    expect(ANNOUNCEMENT_LIST_LIMIT_COUNT).toBe(50);
    for (const q of splitsFor(member, { limitCount: ANNOUNCEMENT_LIST_LIMIT_COUNT })) {
      const lim = q.constraints.filter((c: any) => c.kind === 'limit');
      expect(lim).toEqual([expect.objectContaining({ n: 50 })]);
    }
  });

  it('featured options {isFeatured, limit 8}: every split also constrains isFeatured == true', () => {
    for (const q of splitsFor(anon, { isFeatured: true, limitCount: 8 })) {
      const ws = q.constraints.filter((c: any) => c.kind === 'where');
      expect(ws.some((w: any) => w.field === 'isFeatured' && w.op === '==' && w.value === true)).toBe(true);
      const lim = q.constraints.filter((c: any) => c.kind === 'limit');
      expect(lim).toEqual([expect.objectContaining({ n: 8 })]);
    }
  });
});

describe('timestamp representation contracts (C-TS)', () => {
  const iso = (millis: number) => new Date(millis).toISOString();
  // The four representations of one instant that this system produces
  // or consumes. R1: live Firestore Timestamp. R2: ISO string (legacy
  // stored docs; the type itself declares "Timestamp or ISO string").
  // R3: epoch millis. R4: raw JSON-serialized Timestamp object — what
  // JSON.stringify writes into the fs_announcements jsonb column.
  const reps = (millis: number) => ({
    timestamp: ts(millis),
    isoString: iso(millis),
    epochMillis: millis,
    serializedSeconds: { seconds: Math.floor(millis / 1000), nanoseconds: (millis % 1000) * 1e6 },
    serializedUnderscore: { _seconds: Math.floor(millis / 1000), _nanoseconds: (millis % 1000) * 1e6 },
  });

  const docWith = (overrides: Record<string, unknown>) =>
    ({
      id: 'x1',
      title: 'X',
      status: 'published',
      audience: 'public',
      publish_date: ts(NOW - DAY),
      ...overrides,
    } as any);

  it('C-TS-02 due decisions are identical for Timestamp, ISO string, and epoch forms', () => {
    for (const form of ['timestamp', 'isoString', 'epochMillis'] as const) {
      const future = docWith({ publish_date: reps(NOW + HOUR)[form] });
      expect(isAnnouncementDue(future, NOW)).toBe(false);
      const past = docWith({ publish_date: reps(NOW - HOUR)[form] });
      expect(isAnnouncementDue(past, NOW)).toBe(true);
      const exact = docWith({ publish_date: reps(NOW)[form] });
      expect(isAnnouncementDue(exact, NOW)).toBe(true);
    }
  });

  it('C-TS-02 expiry decisions are identical for Timestamp, ISO string, and epoch forms', () => {
    for (const form of ['timestamp', 'isoString', 'epochMillis'] as const) {
      const expired = docWith({ expiresAt: reps(NOW - HOUR)[form] });
      expect(isAnnouncementVisibleTo(expired, anon, NOW)).toBe(false);
      const live = docWith({ expiresAt: reps(NOW + HOUR)[form] });
      expect(isAnnouncementVisibleTo(live, anon, NOW)).toBe(true);
    }
  });

  // The consumer sort key, replicated verbatim from the three sorting
  // consumers (src/app/announcements/page.tsx, announcement-carousel,
  // featured-announcement-banner):
  //   v?.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0)
  const pageSortKey = (v: any): number =>
    v?.toDate ? v.toDate().getTime() : v ? new Date(v).getTime() : 0;
  // The bell's normalizer (notification-center.tsx toDate): try/catch,
  // null on failure; its combined sort reads `?.getTime() || 0`.
  const bellDate = (v: any): Date | null => {
    try {
      if (!v) return null;
      return v?.toDate ? v.toDate() : new Date(v);
    } catch {
      return null;
    }
  };

  it('C-TS-02 consumer sort keys are identical for Timestamp, ISO string, and epoch forms', () => {
    const instants = [NOW - 5000, NOW - 1000, NOW - 3000];
    for (const form of ['timestamp', 'isoString', 'epochMillis'] as const) {
      const keys = instants.map((m) => pageSortKey(reps(m)[form]));
      expect(keys).toEqual(instants);
      const sorted = [...instants]
        .map((m) => reps(m)[form])
        .sort((a, b) => pageSortKey(b) - pageSortKey(a));
      expect(sorted.map((v) => pageSortKey(v))).toEqual([NOW - 1000, NOW - 3000, NOW - 5000]);
      expect(bellDate(reps(NOW - 1000)[form])?.getTime()).toBe(NOW - 1000);
    }
  });

  it('C-TS-03 POISON SHAPE: serialized timestamp objects read as null (due, never expired, unsortable)', () => {
    for (const form of ['serializedSeconds', 'serializedUnderscore'] as const) {
      // A SCHEDULED announcement in this shape goes live immediately.
      const future = docWith({ publish_date: reps(NOW + DAY)[form] });
      expect(isAnnouncementDue(future, NOW)).toBe(true);
      // An EXPIRED announcement in this shape never expires.
      const expired = docWith({ expiresAt: reps(NOW - DAY)[form] });
      expect(isAnnouncementVisibleTo(expired, anon, NOW)).toBe(true);
      // The page comparator produces NaN, poisoning Array.sort.
      expect(Number.isNaN(pageSortKey(reps(NOW - 1000)[form]))).toBe(true);
      // The bell normalizer yields an Invalid Date, not null: its
      // isExpired/isNew read getTime() comparisons against NaN, which
      // are false in both directions — another silent no-op.
      const d = bellDate(reps(NOW - 1000)[form]);
      expect(d).not.toBeNull();
      expect(Number.isNaN(d!.getTime())).toBe(true);
    }
  });
});

describe('write-path contracts (C-WRT)', () => {
  it('C-WRT-01 converter write shape: exactly the 12 stored fields, defaults applied, audience verbatim', () => {
    const stored = announcementConverter.toFirestore({ title: 'T', content: 'C' } as any);
    expect(Object.keys(stored).sort()).toEqual(
      [
        'audience', 'content', 'ctaExpiredText', 'ctaLink', 'ctaText',
        'expiresAt', 'isFeatured', 'priority', 'publish_date', 'status',
        'title', 'updated_at',
      ].sort()
    );
    expect(stored.isFeatured).toBe(false);
    expect(stored.priority).toBe(0);
    expect(stored.expiresAt).toBeNull();
    expect(stored.publish_date).toBeNull();
    expect(stored.updated_at).toBeNull();
    // The converter does NOT normalize: a legacy audience written
    // through it would be stored verbatim. Normalization is the admin
    // writer's responsibility (C-WRT-03).
    const legacy = announcementConverter.toFirestore({ audience: 'team_leaders' } as any);
    expect(legacy.audience).toBe('team_leaders');
  });

  it('C-WRT-02 converter read projection defaults: priority 0, publish_date null', () => {
    const back = announcementConverter.fromFirestore({
      id: 'z9',
      data: () => ({ title: 'Bare', status: 'published', audience: 'public' }),
    } as any);
    expect(back.priority).toBe(0);
    expect(back.publish_date).toBeNull();
    expect(back.id).toBe('z9');
  });

  it('C-WRT-03 admin writer source pins (page payload + POST /api/admin/announcements)', () => {
    // WS10 relocation: the admin page no longer writes Firestore
    // itself. It builds the same payload (audience normalized, dates
    // as ISO strings, never-null publish_date) and posts it to
    // POST /api/admin/announcements, which converts dateFields back
    // to Admin Timestamps and stamps timestampFields with
    // serverTimestamp — the exact Firestore effects the client
    // writer had. Route behavior is also pinned behaviorally by
    // src/app/api/admin/announcements/__tests__/route-ws10.test.ts.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../app/admin/announcements/page.tsx'),
      'utf8'
    );
    const route = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/announcements/route.ts'),
      'utf8'
    );
    // Audience is normalized at write; legacy values are never written.
    expect(src).toMatch(/audience: normalizeAudience\(values\.audience\)/);
    // No picked date means publish immediately (the current instant),
    // and a picked date is that date — publish_date is never null.
    // The page sends the ISO string; the route converts it back to a
    // Timestamp with Timestamp.fromDate(new Date(v)), the same
    // instant the client Timestamp.fromDate produced.
    expect(src).toMatch(
      /publish_date: values\.publish_date \? new Date\(values\.publish_date\)\.toISOString\(\) : new Date\(\)\.toISOString\(\)/
    );
    expect(src).toMatch(/dateFields: \['publish_date', 'expiresAt'\]/);
    expect(route).toMatch(/Timestamp\.fromDate\(new Date\(v\)\)/);
    // updated_at is a server timestamp on both create and edit: the
    // page names it in timestampFields on both ops and the route
    // stamps every named field with FieldValue.serverTimestamp().
    expect(src).toMatch(/timestampFields: \['updated_at'\]/);
    expect(route).toMatch(/firestoreData\[field\] = FieldValue\.serverTimestamp\(\)/);
    // created_at / created_by exist only on the create branch.
    expect(src).toMatch(/timestampFields: \['updated_at', 'created_at'\]/);
    expect(src).toMatch(/\.\.\.announcementToSave, created_by: user\?\.uid/);
    // The writes themselves: page posts op create/update/delete to
    // the route; the route performs the Firestore set/update/delete.
    expect(src).toContain("serverWrite('/api/admin/announcements', 'POST'");
    expect(src).toMatch(/op: 'create',/);
    expect(src).toMatch(/op: 'update',/);
    expect(route).toMatch(/collection\('announcements'\)\.doc\(id\)\.set\(firestoreData\)/);
    expect(route).toMatch(/collection\('announcements'\)\.doc\(id\)\.update\(firestoreData\)/);
    expect(route).toMatch(/collection\('announcements'\)\.doc\(id\)\.delete\(\)/);
    // The page performs no client Firestore write of its own anymore.
    expect(src).not.toMatch(/await (addDoc|updateDoc|deleteDoc)\(/);
    // Status toggle flips published <-> draft; delete is a hard delete.
    expect(src).toMatch(/item\.status === 'published' \? 'draft' : 'published'/);
    expect(src).toMatch(/op: 'delete', id,/);
    // expiresAt: a picked date becomes a Timestamp, otherwise null.
    // The page sends the ISO string or null; the route converts only
    // strings, so null stays null, exactly as the client writer did.
    expect(src).toMatch(/expiresAt: values\.expiresAt \? new Date\(values\.expiresAt\)\.toISOString\(\) : null/);
  });

  it('C-WRT-04 write -> read round trip: a writer-stored doc is visible to its tier only, immediately', async () => {
    // Exactly what handleSubmitForm stores for a create whose form
    // audience was the legacy 'team_leaders' with no date picked.
    const storedByWriter = {
      _id: 'writer-1',
      title: 'Writer round trip',
      content: 'body',
      audience: normalizeAudience('team_leaders'),
      status: 'published',
      publish_date: ts(NOW),
      slug: 'writer-round-trip',
      meta_title: '',
      meta_description: '',
      keywords: '',
      isFeatured: false,
      ctaText: '',
      ctaLink: '',
      ctaExpiredText: '',
      expiresAt: null,
      priority: 0,
      updated_at: ts(NOW),
      created_at: ts(NOW),
      created_by: 'admin1',
    };
    expect(storedByWriter.audience).toBe('officers');
    fake.docs = [storedByWriter];

    const memberDocs = await fetchVisibleAnnouncements({} as any, member, {}, NOW);
    expect(ids(memberDocs)).not.toContain('writer-1');

    invalidateVisibleAnnouncementsCache();
    const officerDocs = await fetchVisibleAnnouncements({} as any, officer, {}, NOW);
    expect(ids(officerDocs)).toEqual(['writer-1']);
    const doc = officerDocs[0] as any;
    expect(isAnnouncementVisibleTo(doc, officer, NOW)).toBe(true);
    expect(doc.created_at).toBeUndefined();
    expect(doc.slug).toBeUndefined();
  });

  it('normalizeAudience write rule: every legacy/unknown input lands on a canonical value', () => {
    expect(normalizeAudience('all')).toBe('public');
    expect(normalizeAudience('team_leaders')).toBe('officers');
    expect(normalizeAudience('members')).toBe('members');
    expect(normalizeAudience('officers')).toBe('officers');
    expect(normalizeAudience('public')).toBe('public');
    expect(normalizeAudience(undefined)).toBe('public');
    expect(normalizeAudience('something-else')).toBe('public');
  });
});
