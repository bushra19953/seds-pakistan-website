/**
 * @jest-environment node
 *
 * GET /api/projects — the public/member projects read behind
 * useSupa('projects') (cluster I, step 10).
 *
 * Proven here, all against a mocked adapter (zero live reads):
 *  - flag OFF -> 404 and the adapter is never touched;
 *  - guest list = the client queries' union (status in
 *    published/active/completed OR published == true), drafts and
 *    archived rows never serve;
 *  - a valid token -> member list, unfiltered; a presented token
 *    that fails verification -> 401, not a narrowed guest list;
 *  - selection params (published / featured / featured flags /
 *    category / limit) apply in query order;
 *  - ?slugOrId= resolves id-first then slug, serves a miss as
 *    { project: null }, and (like getProjectBySlugOrId) applies no
 *    viewer filter to a direct lookup;
 *  - an adapter failure is a 503, never an empty 200.
 */

const authHolder: { result: any } = { result: { authenticated: false } };
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => authHolder.result),
}));

import { NextRequest } from 'next/server';
import { __setSupaAdapterForTests } from '@/lib/projects-supa';
import type { SupaAdapter, SupaDoc } from '@/lib/supa/adapter';
import { GET } from '../route';

const URL = 'http://localhost/api/projects';

const SEED: Array<{ id: string; data: Record<string, any> }> = [
  { id: 'pub1', data: { title: 'A', status: 'published', slug: 'a' } },
  { id: 'act1', data: { title: 'B', status: 'active', slug: 'b' } },
  { id: 'draft1', data: { title: 'C', status: 'draft', slug: 'c' } },
  { id: 'leg1', data: { title: 'D', published: true, slug: 'd' } },
  {
    id: 'feat1',
    data: {
      title: 'E',
      status: 'active',
      slug: 'e',
      published: true,
      showOnHomepage: true,
      category: 'technical',
      featured_on_recruitment_page: true,
    },
  },
];

function makeFakeAdapter(seed = SEED) {
  const store = new Map<string, Record<string, any>>();
  for (const row of seed) store.set(row.id, { ...row.data });
  const adapter: SupaAdapter = {
    getDoc: jest.fn(async (_c: string, id: string) => {
      const data = store.get(id);
      return data ? ({ id, ...data } as SupaDoc) : null;
    }),
    listDocs: jest.fn(async (_c: string, options?: any) => {
      let rows = [...store.entries()].map(([id, data]) => ({ id, ...data }) as SupaDoc);
      for (const [field, op, value] of options?.where ?? []) {
        if (op === '==') rows = rows.filter((r: any) => r[field] === value);
      }
      if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
      return rows;
    }),
    countDocs: jest.fn(async () => store.size),
    setDoc: jest.fn(async () => ({}) as SupaDoc),
    updateDoc: jest.fn(async () => ({}) as SupaDoc),
    deleteDoc: jest.fn(async () => undefined),
  };
  return { adapter, store };
}

function asMember() {
  authHolder.result = {
    authenticated: true,
    user: { userId: 'u1', role: 'member', email: '', displayName: null, emailVerified: true, user: {} },
  };
}
function asGuest() {
  authHolder.result = { authenticated: false };
}

function req(qs = '', withToken = false) {
  return new NextRequest(`${URL}${qs}`, {
    headers: withToken ? { authorization: 'Bearer <redacted>' } : {},
  });
}

const savedFlag = process.env.SUPA_SURFACES;
beforeEach(() => {
  process.env.SUPA_SURFACES = 'projects';
  asGuest();
});
afterEach(() => {
  __setSupaAdapterForTests(undefined);
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedFlag;
});

describe('GET /api/projects', () => {
  it('flag OFF -> 404, adapter untouched', async () => {
    delete process.env.SUPA_SURFACES;
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(adapter.listDocs).not.toHaveBeenCalled();
    expect(adapter.getDoc).not.toHaveBeenCalled();
  });

  it('guest list serves the public union only', async () => {
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects.map((p: any) => p.id)).toEqual(['pub1', 'act1', 'leg1', 'feat1']);
  });

  it('member list is unfiltered', async () => {
    asMember();
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const res = await GET(req('', true));
    const body = await res.json();
    expect(body.projects.map((p: any) => p.id)).toEqual(['pub1', 'act1', 'draft1', 'leg1', 'feat1']);
  });

  it('a presented token that fails verification is a 401', async () => {
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const res = await GET(req('', true));
    expect(res.status).toBe(401);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('selection params apply: published, featured, category, limit', async () => {
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    let body = await (await GET(req('?published=1'))).json();
    expect(body.projects.map((p: any) => p.id)).toEqual(['leg1', 'feat1']);
    body = await (await GET(req('?featured=1'))).json();
    expect(body.projects.map((p: any) => p.id)).toEqual(['feat1']);
    body = await (await GET(req('?category=technical'))).json();
    expect(body.projects.map((p: any) => p.id)).toEqual(['feat1']);
    body = await (await GET(req('?limit=2'))).json();
    expect(body.projects.map((p: any) => p.id)).toEqual(['pub1', 'act1']);
  });

  it('single lookup: id first, then slug; miss is { project: null }', async () => {
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    let body = await (await GET(req('?slugOrId=act1'))).json();
    expect(body.project.id).toBe('act1');
    body = await (await GET(req('?slugOrId=e'))).json();
    expect(body.project.id).toBe('feat1');
    const res = await GET(req('?slugOrId=missing'));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.project).toBe(null);
  });

  it('single lookup applies no viewer filter (getProjectBySlugOrId parity)', async () => {
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const body = await (await GET(req('?slugOrId=c'))).json();
    expect(body.project.id).toBe('draft1');
  });

  it('adapter failure is a 503, never an empty 200', async () => {
    const { adapter } = makeFakeAdapter();
    (adapter.listDocs as jest.Mock).mockRejectedValue(new Error('query-failed'));
    __setSupaAdapterForTests(adapter);
    const res = await GET(req());
    expect(res.status).toBe(503);
  });
});
