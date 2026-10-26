/**
 * @jest-environment node
 *
 * FLAG-ON evidence for the announcements Supabase surface
 * (feat/supa-ann-routes, the step-2 waiver close-out).
 *
 * The contracts suite (announcements-contracts.test.ts) proves the
 * Firestore path; this suite proves the SAME behaviors with the flag
 * ON, against a mocked adapter injected through the seam's
 * __setSupaAdapterForTests (the roles flag-states pattern,
 * src/lib/server/__tests__/supa-roles-flag-states.test.ts):
 *
 *  - Flag helpers: server delegates to useSupa('announcements')
 *    (SUPA_SURFACES: unset / other surface OFF; 'announcements', '*',
 *    case/space variants ON); client parses the NEXT_PUBLIC_ twin the
 *    roles client seam way, including '*'.
 *  - Bridge delegation: list / published-list / set / update / delete
 *    hit the adapter with the announcements collection and the exact
 *    where clause; update on a missing row returns false and writes
 *    nothing; no adapter (forced off) rejects every bridge call.
 *  - The three historical drifts pinned FLAG-ON, end to end through
 *    the bridge + selectVisibleAnnouncements:
 *      C-AUD-04  a row with no updated_at is excluded entirely;
 *      C-SHP-01  exactly the converter's 13 keys reach consumers;
 *      C-SHP-02  a stored doc without priority reads back priority 0.
 *    Fixtures run in both timestamp representations the adapter can
 *    hand the bridge: ISO strings, and SupaTimestamp instances (the
 *    adapter's rehydration of the Admin-dump {_seconds,_nanoseconds}
 *    shape).
 *
 * ZERO live reads: the adapter is an in-memory fake; Firestore is a
 * module stub that exists only so src/lib/announcements.ts loads.
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
      withConverter: (converter: any) => ({ _name: name, converter }),
    })),
    query: jest.fn((ref: any, ...constraints: any[]) => ({ ref, constraints })),
    where: jest.fn((field: string, op: string, value: any) => ({ field, op, value })),
    orderBy: jest.fn((field: string, dir: string) => ({ field, dir })),
    limit: jest.fn((n: number) => ({ n })),
    getDocs: jest.fn(async () => ({ docs: [] })),
  };
});

jest.mock('@/lib/roles', () => {
  const actual = jest.requireActual('@/lib/roles');
  return { ...actual, isSuperAdmin: () => false };
});

import {
  announcementAudienceValuesForViewer,
  resolveAnnouncementViewer,
} from '@/lib/announcements';
import {
  __setSupaAdapterForTests,
  announcementsSupaClientEnabled,
  announcementsSupaServerEnabled,
  parseAnnouncementsClientSurfaces,
  selectVisibleAnnouncements,
  supaDeleteAnnouncement,
  supaListAnnouncementRows,
  supaListPublishedAnnouncementRows,
  supaSetAnnouncement,
  supaUpdateAnnouncement,
} from '@/lib/announcements-supa';
import { SupaTimestamp } from '@/lib/supa/adapter';
import type { SupaAdapter, SupaDoc } from '@/lib/supa/adapter';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const ENV_KEYS = ['SUPA_SURFACES', 'NEXT_PUBLIC_SUPA_SURFACES'];
let savedEnv: Record<string, string | undefined> = {};

/* ------------------------------------------------------------ fake adapter */

/**
 * In-memory adapter fake with the real adapter's surface: flat
 * Firestore-shaped docs ({ id, ...data }) in and out, listDocs honoring
 * equality where clauses, updateDoc rejecting on a missing doc.
 */
function makeFakeAdapter(seed: SupaDoc[] = []) {
  const store = new Map<string, Record<string, any>>();
  for (const doc of seed) {
    const { id, ...data } = doc;
    store.set(id, { ...data });
  }
  const adapter: SupaAdapter = {
    getDoc: jest.fn(async (_c: string, id: string) => {
      const data = store.get(id);
      return data ? ({ id, ...data } as SupaDoc) : null;
    }),
    listDocs: jest.fn(async (_c: string, options?: any) => {
      let docs = [...store.entries()].map(([id, data]) => ({ id, ...data }));
      for (const [field, op, value] of options?.where ?? []) {
        if (op === '==') docs = docs.filter((d: any) => d[field] === value);
      }
      docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return docs as SupaDoc[];
    }),
    countDocs: jest.fn(async () => store.size),
    setDoc: jest.fn(async (_c: string, id: string, data: any) => {
      store.set(id, { ...data });
      return { id, ...data } as SupaDoc;
    }),
    updateDoc: jest.fn(async (_c: string, id: string, updates: any) => {
      const existing = store.get(id);
      if (!existing) throw new Error(`updateDoc on missing document ${id}`);
      const next = { ...existing, ...updates };
      store.set(id, next);
      return { id, ...next } as SupaDoc;
    }),
    deleteDoc: jest.fn(async (_c: string, id: string) => {
      store.delete(id);
    }),
    rpc: jest.fn(async () => {
      throw new Error('unexpected rpc');
    }),
    tx: jest.fn(async () => {
      throw new Error('unexpected tx');
    }),
  };
  return { adapter, store };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  __setSupaAdapterForTests(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setSupaAdapterForTests(undefined);
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------- flags */

describe('flag helpers delegate to useSupa / the NEXT_PUBLIC twin', () => {
  it('server: SUPA_SURFACES unset or other-surface is OFF', () => {
    expect(announcementsSupaServerEnabled()).toBe(false);
    process.env.SUPA_SURFACES = 'roles,directory';
    expect(announcementsSupaServerEnabled()).toBe(false);
    process.env.SUPA_SURFACES = '';
    expect(announcementsSupaServerEnabled()).toBe(false);
  });

  it("server: 'announcements', case/space variants and '*' are ON", () => {
    process.env.SUPA_SURFACES = 'announcements';
    expect(announcementsSupaServerEnabled()).toBe(true);
    process.env.SUPA_SURFACES = ' roles , ANNOUNCEMENTS ';
    expect(announcementsSupaServerEnabled()).toBe(true);
    process.env.SUPA_SURFACES = '*';
    expect(announcementsSupaServerEnabled()).toBe(true);
  });

  it('client: NEXT_PUBLIC twin parses the roles client seam way', () => {
    expect(announcementsSupaClientEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'directory';
    expect(announcementsSupaClientEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'announcements';
    expect(announcementsSupaClientEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = '*';
    expect(announcementsSupaClientEnabled()).toBe(true);
    expect([...parseAnnouncementsClientSurfaces(' Roles, ,DIRECTORY ')]).toEqual([
      'roles',
      'directory',
    ]);
    expect(parseAnnouncementsClientSurfaces(undefined).size).toBe(0);
  });

  it('client flag does not leak into the server flag (separate envs)', () => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'announcements';
    expect(announcementsSupaServerEnabled()).toBe(false);
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
    process.env.SUPA_SURFACES = 'announcements';
    expect(announcementsSupaClientEnabled()).toBe(false);
  });
});

/* ------------------------------------------------------- bridge delegation */

describe('bridge delegation with the flag ON (mocked adapter)', () => {
  beforeEach(() => {
    process.env.SUPA_SURFACES = 'announcements';
  });

  it('list returns {id, data} rows; a stored rogue id never survives the split', async () => {
    const { adapter } = makeFakeAdapter([
      { id: 'a1', title: 'One', status: 'published' } as SupaDoc,
      { id: 'a2', title: 'Two', status: 'draft' } as SupaDoc,
    ]);
    __setSupaAdapterForTests(adapter);
    const rows = await supaListAnnouncementRows();
    expect(adapter.listDocs).toHaveBeenCalledWith('announcements');
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(rows[0].data).toEqual({ title: 'One', status: 'published' });
    expect(rows[0].data.id).toBeUndefined();
  });

  it('published list passes the exact status where clause to the adapter', async () => {
    const { adapter } = makeFakeAdapter([
      { id: 'a1', title: 'One', status: 'published' } as SupaDoc,
      { id: 'a2', title: 'Two', status: 'draft' } as SupaDoc,
    ]);
    __setSupaAdapterForTests(adapter);
    const rows = await supaListPublishedAnnouncementRows();
    expect(adapter.listDocs).toHaveBeenCalledWith('announcements', {
      where: [['status', '==', 'published']],
    });
    expect(rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('set / delete delegate to the adapter with the announcements collection', async () => {
    const { adapter, store } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    await supaSetAnnouncement('n1', { title: 'New', status: 'draft' });
    expect(adapter.setDoc).toHaveBeenCalledWith('announcements', 'n1', {
      title: 'New',
      status: 'draft',
    });
    expect(store.get('n1')).toEqual({ title: 'New', status: 'draft' });
    await supaDeleteAnnouncement('n1');
    expect(adapter.deleteDoc).toHaveBeenCalledWith('announcements', 'n1');
    expect(store.has('n1')).toBe(false);
  });

  it('update merges through adapter.updateDoc and returns true', async () => {
    const { adapter, store } = makeFakeAdapter([
      { id: 'a1', title: 'One', status: 'draft', priority: 3 } as SupaDoc,
    ]);
    __setSupaAdapterForTests(adapter);
    await expect(supaUpdateAnnouncement('a1', { status: 'published' })).resolves.toBe(true);
    expect(adapter.updateDoc).toHaveBeenCalledWith('announcements', 'a1', {
      status: 'published',
    });
    expect(store.get('a1')).toEqual({ title: 'One', status: 'published', priority: 3 });
  });

  it('update on a missing row returns false and writes nothing', async () => {
    const { adapter, store } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    await expect(supaUpdateAnnouncement('ghost', { status: 'published' })).resolves.toBe(false);
    expect(adapter.updateDoc).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('no adapter (forced off): every bridge call rejects, nothing silently succeeds', async () => {
    __setSupaAdapterForTests(null);
    await expect(supaListAnnouncementRows()).rejects.toThrow();
    await expect(supaListPublishedAnnouncementRows()).rejects.toThrow();
    await expect(supaSetAnnouncement('x', {})).rejects.toThrow();
    await expect(supaUpdateAnnouncement('x', {})).rejects.toThrow();
    await expect(supaDeleteAnnouncement('x')).rejects.toThrow();
  });
});

/* ------------------------------------------- historical drifts, flag ON */

describe.each([
  ['ISO strings', (ms: number) => new Date(ms).toISOString()],
  ['SupaTimestamp (adapter rehydration of the dump shape)', (ms: number) => SupaTimestamp.fromMillis(ms)],
])('flag-ON visible set through the bridge, %s timestamps', (_label, enc) => {
  const seed = (): SupaDoc[] => {
    const base = (o: Record<string, any>) => ({
      content: 'body',
      status: 'published',
      isFeatured: false,
      ctaText: '',
      ctaLink: '',
      ctaExpiredText: '',
      expiresAt: null,
      publish_date: enc(NOW - DAY),
      ...o,
    });
    return [
      base({ id: 'pub-b', title: 'Public newer', audience: 'public', priority: 5, updated_at: enc(NOW - 1000), slug: 'x', created_by: 'admin1', showInTicker: true }),
      base({ id: 'due-exact', title: 'Due exactly now', audience: 'public', publish_date: enc(NOW), updated_at: enc(NOW - 2000) }),
      base({ id: 'no-updated', title: 'No updated_at', audience: 'public', updated_at: undefined }),
      base({ id: 'future-1', title: 'Scheduled', audience: 'public', publish_date: enc(NOW + HOUR), updated_at: enc(NOW - 100) }),
      base({ id: 'mem-1', title: 'Members post', audience: 'members', updated_at: enc(NOW - 100) }),
      base({ id: 'draft-1', title: 'Draft', audience: 'public', status: 'draft', updated_at: enc(NOW - 100) }),
    ].map((d) => {
      const copy: Record<string, any> = { ...d };
      if (copy.updated_at === undefined) delete copy.updated_at;
      return copy as SupaDoc;
    });
  };

  beforeEach(() => {
    process.env.SUPA_SURFACES = 'announcements';
  });

  it('C-AUD-04: the updated_at-less row is excluded end to end', async () => {
    const { adapter } = makeFakeAdapter(seed());
    __setSupaAdapterForTests(adapter);
    const rows = await supaListPublishedAnnouncementRows();
    // The bridge returns the raw row (the admin list needs it); the
    // exclusion is the selection layer's, exactly as Firestore's
    // orderBy exclusion is the query layer's.
    expect(rows.map((r) => r.id)).toContain('no-updated');
    const docs = selectVisibleAnnouncements(
      rows,
      announcementAudienceValuesForViewer(resolveAnnouncementViewer({ signedIn: false })),
      {},
      NOW,
    );
    expect(docs.map((d) => d.id)).toEqual(['pub-b', 'due-exact']);
  });

  it('C-SHP-01: exactly the 13 converter keys reach the consumer', async () => {
    const { adapter } = makeFakeAdapter(seed());
    __setSupaAdapterForTests(adapter);
    const rows = await supaListPublishedAnnouncementRows();
    const docs = selectVisibleAnnouncements(
      rows,
      announcementAudienceValuesForViewer(resolveAnnouncementViewer({ signedIn: false })),
      {},
      NOW,
    );
    const pub = docs.find((d) => d.id === 'pub-b') as any;
    expect(Object.keys(pub).sort()).toEqual(
      [
        'audience', 'content', 'ctaExpiredText', 'ctaLink', 'ctaText',
        'expiresAt', 'id', 'isFeatured', 'priority', 'publish_date',
        'status', 'title', 'updated_at',
      ].sort(),
    );
    expect(pub.slug).toBeUndefined();
    expect(pub.created_by).toBeUndefined();
    expect(pub.showInTicker).toBeUndefined();
  });

  it('C-SHP-02: priority defaults to 0 flag-ON; a stored priority passes through', async () => {
    const { adapter } = makeFakeAdapter(seed());
    __setSupaAdapterForTests(adapter);
    const rows = await supaListPublishedAnnouncementRows();
    const docs = selectVisibleAnnouncements(
      rows,
      announcementAudienceValuesForViewer(resolveAnnouncementViewer({ signedIn: false })),
      {},
      NOW,
    );
    expect((docs.find((d) => d.id === 'due-exact') as any).priority).toBe(0);
    expect((docs.find((d) => d.id === 'pub-b') as any).priority).toBe(5);
  });

  it('tier leakage holds flag-ON: an anonymous selection never sees members rows the bridge returned filtered by status only', async () => {
    const { adapter } = makeFakeAdapter(seed());
    __setSupaAdapterForTests(adapter);
    const rows = await supaListPublishedAnnouncementRows();
    const anonDocs = selectVisibleAnnouncements(
      rows,
      announcementAudienceValuesForViewer(resolveAnnouncementViewer({ signedIn: false })),
      {},
      NOW,
    );
    expect(anonDocs.map((d) => d.id)).not.toContain('mem-1');
    const memberDocs = selectVisibleAnnouncements(
      rows,
      announcementAudienceValuesForViewer(
        resolveAnnouncementViewer({ uid: 'm1', role: 'team_member' }),
      ),
      {},
      NOW,
    );
    expect(memberDocs.map((d) => d.id)).toContain('mem-1');
  });
});
