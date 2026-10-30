/**
 * @jest-environment node
 *
 * fetchVisibleAnnouncementsSet in src/lib/announcements.ts falls back
 * to the Firestore split queries only when the Supabase route FAILS.
 * A successful route response is authoritative (read-bleed fix
 * train 2, census 01 item 4 — this supersedes the
 * fix/supa-read-fallback hotfix, whose empty-list fallthrough re-ran
 * the full Firestore split queries on every poll):
 *
 *  - route returns []  -> served as a valid empty, Firestore never read.
 *  - route returns rows -> served as-is, Firestore never read (guard).
 *  - route throws       -> Firestore rows served (pre-existing guard).
 */

const firestoreState = { getDocsCalls: 0 };

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
  }
  return {
    Timestamp: FakeTimestamp,
    collection: jest.fn((_db: any, name: string) => ({
      _name: name,
      withConverter: () => ({ _name: name }),
    })),
    query: jest.fn((ref: any, ...constraints: any[]) => ({ ref, constraints })),
    where: jest.fn((field: string, op: string, value: any) => ({ field, op, value })),
    orderBy: jest.fn((field: string, dir: string) => ({ field, dir })),
    limit: jest.fn((n: number) => ({ n })),
    getDocs: jest.fn(async () => {
      firestoreState.getDocsCalls += 1;
      return {
        docs: [
          {
            id: 'fs-ann-1',
            data: () => ({
              title: 'Firestore Public Announcement',
              content: 'served from Firestore',
              audience: 'public',
              status: 'published',
              isFeatured: false,
              priority: 0,
            }),
          },
        ],
      };
    }),
  };
});

const routeState: { result: any; error: Error | null } = { result: null, error: null };
jest.mock('@/lib/announcements-supa', () => ({
  announcementsSupaClientEnabled: () => true,
  fetchVisibleAnnouncementsViaRoute: jest.fn(async () => {
    if (routeState.error) throw routeState.error;
    return routeState.result;
  }),
}));

import {
  fetchVisibleAnnouncementsSet,
  resolveAnnouncementViewer,
} from '@/lib/announcements';

const anon = resolveAnnouncementViewer({ signedIn: false });

beforeEach(() => {
  firestoreState.getDocsCalls = 0;
  routeState.result = null;
  routeState.error = null;
});

describe('fetchVisibleAnnouncementsSet — route result authority', () => {
  it('route returns an empty list: served as a valid empty, Firestore is never read', async () => {
    routeState.result = { docs: [], audienceValues: ['public', 'all'] };
    const docs = await fetchVisibleAnnouncementsSet({} as any, anon, {});
    expect(docs).toEqual([]);
    expect(firestoreState.getDocsCalls).toBe(0);
  });

  it('route returns rows: served as-is, Firestore is never read (guard)', async () => {
    routeState.result = {
      docs: [{ id: 'supa-ann-1', title: 'Supa', status: 'published', audience: 'public' }],
      audienceValues: ['public', 'all'],
    };
    const docs = await fetchVisibleAnnouncementsSet({} as any, anon, {});
    expect(docs.map((d: any) => d.id)).toEqual(['supa-ann-1']);
    expect(firestoreState.getDocsCalls).toBe(0);
  });

  it('route throws: Firestore rows are served (pre-existing behavior)', async () => {
    routeState.error = new Error('visible route 503');
    const docs = await fetchVisibleAnnouncementsSet({} as any, anon, {});
    expect(docs.map((d: any) => d.id)).toEqual(['fs-ann-1']);
  });
});
