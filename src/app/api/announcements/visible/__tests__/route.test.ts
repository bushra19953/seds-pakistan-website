/**
 * @jest-environment node
 *
 * GET /api/announcements/visible — the route the announcements seam's
 * fetchVisibleAnnouncementsViaRoute calls (feat/supa-ann-routes).
 *
 * Proven here, all against a mocked adapter (zero live reads):
 *  - flag OFF -> 404 (the client falls back to Firestore; the app is
 *    byte-identical to pre-migration).
 *  - flag ON, anonymous -> 200 with ONLY the public tier and the
 *    audienceValues the client tier-guard expects (['public','all']),
 *    with the historical drifts pinned on the real route: C-AUD-04
 *    (updated_at-less excluded), C-SHP-01 (13 keys), C-SHP-02
 *    (priority default 0).
 *  - flag ON, signed-in officer -> the officers tier is served and
 *    audienceValues widens accordingly; a presented-but-invalid token
 *    is a 401, never a silent downgrade to anonymous.
 *  - limit / featured query params reach the selection.
 *  - adapter failure -> 503 (fallback signal), never an empty 200.
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

const authHolder: { result: any } = { result: { authenticated: false } };
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => authHolder.result),
}));

import { NextRequest } from 'next/server';
import {
  __setSupaAdapterForTests,
} from '@/lib/announcements-supa';
import type { SupaAdapter, SupaDoc } from '@/lib/supa/adapter';
import { GET } from '../route';

const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
// "Now" for fixtures: publish dates are all in the past relative to
// the real clock the route selects with, so fixture instants anchor
// to Date.now() instead of a frozen constant.
const T0 = Date.now();

function seedDocs(): SupaDoc[] {
  const base = (o: Record<string, any>) => ({
    content: 'body',
    status: 'published',
    isFeatured: false,
    ctaText: '',
    ctaLink: '',
    ctaExpiredText: '',
    expiresAt: null,
    publish_date: iso(T0 - DAY),
    ...o,
  });
  return [
    base({ id: 'pub-b', title: 'Public newer', audience: 'public', priority: 5, updated_at: iso(T0 - 1000), slug: 'x', created_by: 'admin1' }),
    base({ id: 'pub-a', title: 'Public older', audience: 'public', updated_at: iso(T0 - 5000) }),
    base({ id: 'featured-pub', title: 'Featured', audience: 'public', isFeatured: true, updated_at: iso(T0 - 4000) }),
    base({ id: 'no-updated', title: 'No updated_at', audience: 'public', updated_at: undefined }),
    base({ id: 'mem-1', title: 'Members', audience: 'members', updated_at: iso(T0 - 100) }),
    base({ id: 'off-1', title: 'Officers', audience: 'officers', updated_at: iso(T0 - 100) }),
    base({ id: 'draft-1', title: 'Draft', audience: 'public', status: 'draft', updated_at: iso(T0 - 100) }),
  ].map((d) => {
    const copy: Record<string, any> = { ...d };
    if (copy.updated_at === undefined) delete copy.updated_at;
    return copy as SupaDoc;
  });
}

function makeFakeAdapter(docs: SupaDoc[]) {
  const store = new Map<string, Record<string, any>>();
  for (const doc of docs) {
    const { id, ...data } = doc;
    store.set(id, { ...data });
  }
  const adapter: SupaAdapter = {
    getDoc: jest.fn(async (_c: string, id: string) => {
      const data = store.get(id);
      return data ? ({ id, ...data } as SupaDoc) : null;
    }),
    listDocs: jest.fn(async (_c: string, options?: any) => {
      let out = [...store.entries()].map(([id, data]) => ({ id, ...data }));
      for (const [field, op, value] of options?.where ?? []) {
        if (op === '==') out = out.filter((d: any) => d[field] === value);
      }
      return out as SupaDoc[];
    }),
    countDocs: jest.fn(async () => store.size),
    setDoc: jest.fn(async () => ({}) as SupaDoc),
    updateDoc: jest.fn(async () => ({}) as SupaDoc),
    deleteDoc: jest.fn(async () => undefined),
    rpc: jest.fn(async () => {
      throw new Error('unexpected rpc');
    }),
    tx: jest.fn(async () => {
      throw new Error('unexpected tx');
    }),
  };
  return adapter;
}

function req(url = 'http://localhost/api/announcements/visible', token?: string) {
  return new NextRequest(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const ENV_KEYS = ['SUPA_SURFACES', 'NEXT_PUBLIC_SUPA_SURFACES'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  authHolder.result = { authenticated: false };
  __setSupaAdapterForTests(makeFakeAdapter(seedDocs()));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setSupaAdapterForTests(undefined);
});

describe('GET /api/announcements/visible', () => {
  it('flag OFF: 404, and the adapter is never touched', async () => {
    const adapter = makeFakeAdapter(seedDocs());
    __setSupaAdapterForTests(adapter);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('flag ON, anonymous: public tier only, contract audienceValues, drifts pinned', async () => {
    process.env.SUPA_SURFACES = 'announcements';
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audienceValues).toEqual(['public', 'all']);
    const ids = body.announcements.map((d: any) => d.id);
    // C-AUD-04: no-updated excluded; drafts never reach the route's
    // published list; members/officers tiers do not leak downward.
    expect(ids).toEqual(['pub-b', 'featured-pub', 'pub-a']);
    // C-SHP-01: exactly the converter's 13 keys.
    const pub = body.announcements.find((d: any) => d.id === 'pub-b');
    expect(Object.keys(pub).sort()).toEqual(
      [
        'audience', 'content', 'ctaExpiredText', 'ctaLink', 'ctaText',
        'expiresAt', 'id', 'isFeatured', 'priority', 'publish_date',
        'status', 'title', 'updated_at',
      ].sort(),
    );
    // C-SHP-02: stored priority passes through; absent priority is 0.
    expect(pub.priority).toBe(5);
    const pubA = body.announcements.find((d: any) => d.id === 'pub-a');
    expect(pubA.priority).toBe(0);
  });

  it('flag ON, officer token: officers tier served, audienceValues widens', async () => {
    process.env.SUPA_SURFACES = 'announcements';
    authHolder.result = {
      authenticated: true,
      user: { userId: 'o1', role: 'chapter_president', email: '', displayName: null, emailVerified: true, user: {} },
    };
    const res = await GET(req('http://localhost/api/announcements/visible', 'tok'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audienceValues).toEqual(['public', 'all', 'members', 'officers', 'team_leaders']);
    const ids = body.announcements.map((d: any) => d.id);
    expect(ids).toContain('mem-1');
    expect(ids).toContain('off-1');
    expect(ids).not.toContain('draft-1');
  });

  it('flag ON, member token: members tier served, officers tier withheld', async () => {
    process.env.SUPA_SURFACES = 'announcements';
    authHolder.result = {
      authenticated: true,
      user: { userId: 'm1', role: 'team_member', email: '', displayName: null, emailVerified: true, user: {} },
    };
    const res = await GET(req('http://localhost/api/announcements/visible', 'tok'));
    const body = await res.json();
    expect(body.audienceValues).toEqual(['public', 'all', 'members']);
    const ids = body.announcements.map((d: any) => d.id);
    expect(ids).toContain('mem-1');
    expect(ids).not.toContain('off-1');
  });

  it('flag ON, presented-but-invalid token: 401, never a silent anonymous downgrade', async () => {
    process.env.SUPA_SURFACES = 'announcements';
    authHolder.result = { authenticated: false, error: 'bad token' };
    const res = await GET(req('http://localhost/api/announcements/visible', 'stale'));
    expect(res.status).toBe(401);
  });

  it('limit and featured params reach the selection (per-split cap, featured filter)', async () => {
    process.env.SUPA_SURFACES = 'announcements';
    const featured = await GET(
      req('http://localhost/api/announcements/visible?featured=1&limit=8'),
    );
    const featuredBody = await featured.json();
    expect(featuredBody.announcements.map((d: any) => d.id)).toEqual(['featured-pub']);

    const limited = await GET(req('http://localhost/api/announcements/visible?limit=1'));
    const limitedBody = await limited.json();
    expect(limitedBody.announcements.map((d: any) => d.id)).toEqual(['pub-b']);
  });

  it('adapter failure: 503 (the fallback signal), never an empty 200', async () => {
    process.env.SUPA_SURFACES = 'announcements';
    __setSupaAdapterForTests(null);
    const res = await GET(req());
    expect(res.status).toBe(503);
  });
});
