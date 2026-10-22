/**
 * Unit tests for the Item 10 announcement visibility helpers
 * (src/lib/announcements.ts, spec fragment (f) Suite 1).
 *
 * The firebase/firestore query builders are mocked to capture the
 * constraint shapes visibleAnnouncementQueries emits; the visibility
 * predicate itself runs against the real helpers and the real role
 * taxonomy in src/lib/roles.ts.
 */

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: any, name: string) => ({ _collection: name })),
  query: jest.fn((ref: any, ...constraints: any[]) => ({ ref, constraints })),
  where: jest.fn((field: string, op: string, value: any) => ({
    kind: 'where',
    field,
    op,
    value,
  })),
  orderBy: jest.fn((field: string, dir: string) => ({ kind: 'orderBy', field, dir })),
  limit: jest.fn((n: number) => ({ kind: 'limit', n })),
  Timestamp: {
    fromDate: (d: Date) => ({ __tsMillis: d.getTime() }),
    now: () => ({ __tsMillis: Date.now() }),
  },
}));

import {
  announcementConverter,
  isAnnouncementVisibleTo,
  normalizeAudience,
  resolveAnnouncementViewer,
  visibleAnnouncementQueries,
  FOUNDER_UID,
} from '@/lib/announcements';

const NOW = new Date('2026-10-21T12:00:00Z');
const PAST = '2026-10-20T12:00:00Z';
const FUTURE = '2026-10-22T12:00:00Z';

const anon = resolveAnnouncementViewer({ signedIn: false });
const member = resolveAnnouncementViewer({ uid: 'm1', role: 'team_member' });
const officerViewer = (role: string) => resolveAnnouncementViewer({ uid: `u-${role}`, role });

function ann(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    title: 'Post',
    status: 'published',
    audience: 'public',
    publish_date: null,
    ...overrides,
  } as any;
}

describe('announcement visibility (Item 10)', () => {
  it('1. future-dated published public post is invisible to anonymous, member, and officer', () => {
    const a = ann({ publish_date: FUTURE });
    expect(isAnnouncementVisibleTo(a, anon, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, member, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, officerViewer('president_national'), NOW)).toBe(false);
  });

  it('2. publish_date exactly now, null, absent, and past are all visible', () => {
    expect(isAnnouncementVisibleTo(ann({ publish_date: NOW.toISOString() }), anon, NOW)).toBe(true);
    expect(isAnnouncementVisibleTo(ann({ publish_date: null }), anon, NOW)).toBe(true);
    const absent = ann();
    delete absent.publish_date;
    expect(isAnnouncementVisibleTo(absent, anon, NOW)).toBe(true);
    expect(isAnnouncementVisibleTo(ann({ publish_date: PAST }), anon, NOW)).toBe(true);
  });

  it('3. officers-only: hidden from anonymous and plain members, visible to each officer family and the founder', () => {
    const a = ann({ audience: 'officers' });
    expect(isAnnouncementVisibleTo(a, anon, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, member, NOW)).toBe(false);
    for (const role of ['president_national', 'national_vp_operations', 'chapter_president', 'lead_propulsion']) {
      expect(isAnnouncementVisibleTo(a, officerViewer(role), NOW)).toBe(true);
    }
    const founder = resolveAnnouncementViewer({ uid: FOUNDER_UID, role: 'member' });
    expect(isAnnouncementVisibleTo(a, founder, NOW)).toBe(true);
  });

  it("4. legacy 'team_leaders' reads as officers; legacy 'all' and absent audience read as public", () => {
    const legacy = ann({ audience: 'team_leaders' });
    expect(normalizeAudience('team_leaders')).toBe('officers');
    expect(isAnnouncementVisibleTo(legacy, member, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(legacy, officerViewer('chapter_president'), NOW)).toBe(true);

    expect(normalizeAudience('all')).toBe('public');
    expect(isAnnouncementVisibleTo(ann({ audience: 'all' }), anon, NOW)).toBe(true);
    const absent = ann();
    delete absent.audience;
    expect(isAnnouncementVisibleTo(absent, anon, NOW)).toBe(true);
  });

  it('5. members tier: invisible to anonymous, visible to any signed-in viewer', () => {
    const a = ann({ audience: 'members' });
    expect(isAnnouncementVisibleTo(a, anon, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, member, NOW)).toBe(true);
    expect(
      isAnnouncementVisibleTo(a, resolveAnnouncementViewer({ uid: 'ap1', role: 'applicant' }), NOW)
    ).toBe(true);
  });

  it('6. draft is invisible to every non-admin viewer', () => {
    const a = ann({ status: 'draft' });
    expect(isAnnouncementVisibleTo(a, anon, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, member, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, officerViewer('superadmin'), NOW)).toBe(false);
  });

  it('7. expired announcement is invisible even when published, due, and public', () => {
    const a = ann({ expiresAt: PAST });
    expect(isAnnouncementVisibleTo(a, anon, NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, officerViewer('president_national'), NOW)).toBe(false);
  });

  it('8. chapter_design_chair and chapter_faculty_advisor are NOT officers (locked exclusion)', () => {
    const a = ann({ audience: 'officers' });
    expect(isAnnouncementVisibleTo(a, officerViewer('chapter_design_chair'), NOW)).toBe(false);
    expect(isAnnouncementVisibleTo(a, officerViewer('chapter_faculty_advisor'), NOW)).toBe(false);
  });
});

describe('visibleAnnouncementQueries shape (Item 10)', () => {
  const fakeRef: any = { _collection: 'announcements' };

  function wheres(q: any) {
    return q.constraints.filter((c: any) => c.kind === 'where');
  }

  it('9a. anonymous viewer: only public-tier values, one due query each, all constrained', () => {
    const queries = visibleAnnouncementQueries(fakeRef, anon, NOW);
    expect(queries).toHaveLength(2); // values public, all x due
    const audiences = new Set(wheres(queries[0]).map((w: any) => w.value));
    expect(audiences.has('members')).toBe(false);
    for (const q of queries) {
      const ws = wheres(q);
      expect(ws.some((w: any) => w.field === 'status' && w.op === '==' && w.value === 'published')).toBe(true);
      expect(ws.some((w: any) => w.field === 'audience')).toBe(true);
      const pd = ws.filter((w: any) => w.field === 'publish_date');
      expect(pd).toHaveLength(1);
      // Due query only: an equality-on-null split is unprovable under the
      // visibility rules and denied the whole feed (2026-10-22 incident).
      expect(pd[0].op).toBe('<=');
    }
    const audienceValues = new Set(
      queries.flatMap((q) => wheres(q).filter((w: any) => w.field === 'audience').map((w: any) => w.value))
    );
    expect([...audienceValues].sort()).toEqual(['all', 'public']);
  });

  it('9b. officer viewer: additionally emits members, officers, and team_leaders queries', () => {
    const queries = visibleAnnouncementQueries(fakeRef, officerViewer('president_national'), NOW);
    expect(queries).toHaveLength(5); // 5 values x due
    const audienceValues = new Set(
      queries.flatMap((q) => wheres(q).filter((w: any) => w.field === 'audience').map((w: any) => w.value))
    );
    expect([...audienceValues].sort()).toEqual(
      ['all', 'members', 'officers', 'public', 'team_leaders']
    );
  });
});

describe('announcementConverter round-trip (Item 10)', () => {
  it('10. toFirestore then fromFirestore preserves publish_date and audience', () => {
    const original: any = {
      id: 'a9',
      title: 'Round trip',
      content: 'Body',
      audience: 'officers',
      status: 'published',
      publish_date: '2026-11-01T00:00:00Z',
      expiresAt: null,
    };
    const stored = announcementConverter.toFirestore(original);
    expect(stored.publish_date).toBe('2026-11-01T00:00:00Z');
    expect(stored.audience).toBe('officers');

    const back = announcementConverter.fromFirestore({
      id: 'a9',
      data: () => stored,
    } as any);
    expect(back.publish_date).toBe('2026-11-01T00:00:00Z');
    expect(back.audience).toBe('officers');
    expect(back.status).toBe('published');
  });
});
