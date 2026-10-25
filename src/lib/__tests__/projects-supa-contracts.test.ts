/**
 * Projects Supabase seam contracts (cluster I, step 10).
 *
 * Pins for src/lib/projects-supa.ts, all against fakes (zero live
 * reads):
 *  - Flags: server useSupa('projects') over SUPA_SURFACES (default
 *    OFF) and the NEXT_PUBLIC_ client twin (default OFF, '*',
 *    case/whitespace tolerant, no partial matches).
 *  - Timestamp normalization across every stored shape (ISO,
 *    epoch, Date, toDate(), toMillis(), {_seconds,_nanoseconds},
 *    {seconds,nanoseconds}) and restoreProjectTimestamps reviving
 *    only the known fields.
 *  - Mirror serialization: Timestamp-like -> ISO, serverTimestamp
 *    sentinel -> ISO now, dumped shapes -> ISO, deep recursion,
 *    never throws.
 *  - Selection: the guest predicate is the union of the status
 *    query and the legacy published==true fallback; filters apply
 *    in query order with limit() last.
 *  - Adapter bridge over an injected fake adapter: list/get/
 *    find-by-slug-or-id (id first, slug second, getDoc errors fall
 *    through like the Firestore original), set/update/delete,
 *    update-on-missing writes nothing, forced-off adapter rejects.
 *  - Client fetchers: URL params + bearer token, throw on !ok;
 *    mirror never throws and skips on a null token.
 */

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: async () => 'tok-123' },
  }),
}));

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: () => ({}),
}));

import {
  __setSupaAdapterForTests,
  fetchAdminProjectRowsViaRoute,
  fetchProjectBySlugOrIdViaRoute,
  fetchProjectsViaRoute,
  getCurrentUserIdToken,
  isPubliclyVisibleProject,
  mirrorProjectViaRoute,
  parseProjectsClientSurfaces,
  projectTimestampToIso,
  projectsSupaClientEnabled,
  projectsSupaServerEnabled,
  restoreProjectTimestamps,
  selectProjectList,
  serializeProjectForSupa,
  supaDeleteProject,
  supaFindProjectBySlugOrId,
  supaGetProject,
  supaListProjectRows,
  supaListProjects,
  supaSetProject,
  supaUpdateProject,
  type ProjectSupaDoc,
} from '../projects-supa';
import type { SupaAdapter, SupaDoc } from '../supa/adapter';

const ENV_KEYS = ['SUPA_SURFACES', 'NEXT_PUBLIC_SUPA_SURFACES'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __setSupaAdapterForTests(undefined);
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------- flags

describe('flags', () => {
  it('server flag defaults OFF and follows SUPA_SURFACES', () => {
    expect(projectsSupaServerEnabled()).toBe(false);
    process.env.SUPA_SURFACES = 'blog';
    expect(projectsSupaServerEnabled()).toBe(false);
    process.env.SUPA_SURFACES = 'blog, projects';
    expect(projectsSupaServerEnabled()).toBe(true);
    process.env.SUPA_SURFACES = '*';
    expect(projectsSupaServerEnabled()).toBe(true);
  });

  it('client twin defaults OFF, is case/whitespace tolerant, no partials', () => {
    expect(projectsSupaClientEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = ' PROJECTS ';
    expect(projectsSupaClientEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'project';
    expect(projectsSupaClientEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'projects-extra';
    expect(projectsSupaClientEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = '*';
    expect(projectsSupaClientEnabled()).toBe(true);
  });

  it('parseProjectsClientSurfaces drops empties and lowercases', () => {
    expect([...parseProjectsClientSurfaces(' A,,b ')]).toEqual(['a', 'b']);
    expect(parseProjectsClientSurfaces(undefined).size).toBe(0);
  });
});

// ------------------------------------------------------------ timestamps

describe('projectTimestampToIso', () => {
  it('accepts every stored shape', () => {
    const iso = '2023-11-14T22:13:20.000Z';
    expect(projectTimestampToIso(iso)).toBe(iso);
    expect(projectTimestampToIso(1700000000000)).toBe(iso);
    expect(projectTimestampToIso(new Date(iso))).toBe(iso);
    expect(projectTimestampToIso({ _seconds: 1700000000, _nanoseconds: 0 })).toBe(iso);
    expect(projectTimestampToIso({ seconds: 1700000000, nanoseconds: 500000000 })).toBe(
      '2023-11-14T22:13:20.500Z',
    );
    expect(projectTimestampToIso({ toDate: () => new Date(iso) })).toBe(iso);
    expect(projectTimestampToIso({ toMillis: () => 1700000000000 })).toBe(iso);
  });

  it('returns null for absent/unparseable values', () => {
    expect(projectTimestampToIso(null)).toBe(null);
    expect(projectTimestampToIso(undefined)).toBe(null);
    expect(projectTimestampToIso('not a date')).toBe(null);
    expect(projectTimestampToIso({})).toBe(null);
  });
});

describe('restoreProjectTimestamps', () => {
  it('revives only the known timestamp fields, via the injected factory', () => {
    const make = jest.fn((d: Date) => ({ __ts: d.toISOString() }));
    const out = restoreProjectTimestamps(
      {
        title: '2023-11-14T22:13:20.000Z',
        createdAt: '2023-11-14T22:13:20.000Z',
        updated_at: { _seconds: 1700000000, _nanoseconds: 0 },
        started_at: null,
      },
      make,
    );
    expect(out.title).toBe('2023-11-14T22:13:20.000Z');
    expect(out.createdAt).toEqual({ __ts: '2023-11-14T22:13:20.000Z' });
    expect(out.updated_at).toEqual({ __ts: '2023-11-14T22:13:20.000Z' });
    expect(out.started_at).toBe(null);
    expect(make).toHaveBeenCalledTimes(2);
  });
});

// ----------------------------------------------------------- serialize

describe('serializeProjectForSupa', () => {
  it('converts Timestamp-like, sentinel and dumped shapes to ISO, deeply', () => {
    const out = serializeProjectForSupa({
      title: 'Rocketry',
      createdAt: { toDate: () => new Date('2023-11-14T22:13:20.000Z') },
      updatedAt: { _methodName: 'serverTimestamp' },
      nested: { when: { _seconds: 1700000000, _nanoseconds: 0 } },
      tags: ['a', { at: new Date('2023-11-14T22:13:20.000Z') }],
      count: 3,
      flag: null,
    });
    expect(out.title).toBe('Rocketry');
    expect(out.createdAt).toBe('2023-11-14T22:13:20.000Z');
    expect(typeof out.updatedAt).toBe('string');
    expect(new Date(out.updatedAt).getTime()).not.toBeNaN();
    expect(out.nested.when).toBe('2023-11-14T22:13:20.000Z');
    expect(out.tags[1].at).toBe('2023-11-14T22:13:20.000Z');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(null);
  });

  it('never throws on hostile input', () => {
    const hostile: any = { self: null };
    hostile.self = hostile;
    expect(() => serializeProjectForSupa(hostile)).not.toThrow();
  });
});

// ------------------------------------------------------------ selection

const DOCS: ProjectSupaDoc[] = [
  { id: 'pub', title: 'P', status: 'published' },
  { id: 'act', title: 'A', status: 'active', showOnHomepage: true, category: 'technical', published: true },
  { id: 'draft', title: 'D', status: 'draft' },
  { id: 'leg', title: 'L', published: true },
  { id: 'arch', title: 'R', status: 'archived', published: false },
  { id: 'rec', title: 'F', status: 'active', published: true, featured_on_recruitment_page: true, featured_on_sponsorship_page: true, category: 'outreach' },
];

describe('isPubliclyVisibleProject / selectProjectList', () => {
  it('guest predicate = status query UNION legacy published==true', () => {
    expect(isPubliclyVisibleProject({ status: 'completed' })).toBe(true);
    expect(isPubliclyVisibleProject({ status: 'draft' })).toBe(false);
    expect(isPubliclyVisibleProject({ status: 'draft', published: true })).toBe(true);
    expect(isPubliclyVisibleProject({})).toBe(false);
    expect(isPubliclyVisibleProject({ published: false })).toBe(false);
  });

  it('guest selection drops drafts/archived, keeps legacy boolean rows', () => {
    const ids = selectProjectList(DOCS, { viewer: 'guest' }).map((d) => d.id);
    expect(ids).toEqual(['pub', 'act', 'leg', 'rec']);
  });

  it('member selection is unfiltered', () => {
    expect(selectProjectList(DOCS, { viewer: 'member' })).toHaveLength(6);
    expect(selectProjectList(DOCS)).toHaveLength(6);
  });

  it('equality filters mirror the featured hook queries', () => {
    expect(selectProjectList(DOCS, { publishedOnly: true }).map((d) => d.id)).toEqual(['act', 'leg', 'rec']);
    expect(selectProjectList(DOCS, { featuredOnly: true }).map((d) => d.id)).toEqual(['act']);
    expect(
      selectProjectList(DOCS, { publishedOnly: true, featuredOnRecruitment: true }).map((d) => d.id),
    ).toEqual(['rec']);
    expect(
      selectProjectList(DOCS, { publishedOnly: true, featuredOnSponsorship: true, category: 'outreach' }).map((d) => d.id),
    ).toEqual(['rec']);
    expect(selectProjectList(DOCS, { category: 'technical' }).map((d) => d.id)).toEqual(['act']);
  });

  it('limit applies last', () => {
    expect(selectProjectList(DOCS, { viewer: 'guest', limit: 2 }).map((d) => d.id)).toEqual(['pub', 'act']);
  });
});

// --------------------------------------------------------------- bridge

function makeFakeAdapter(seed: Array<{ id: string; data: Record<string, any> }> = []) {
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
    setDoc: jest.fn(async (_c: string, id: string, data: any) => {
      store.set(id, { ...data });
      return { id, ...data } as SupaDoc;
    }),
    updateDoc: jest.fn(async (_c: string, id: string, updates: any) => {
      const existing = store.get(id);
      if (!existing) {
        const err: any = new Error(`updateDoc on missing document ${id}`);
        err.code = 'not-found';
        throw err;
      }
      const next = { ...existing, ...updates };
      store.set(id, next);
      return { id, ...next } as SupaDoc;
    }),
    deleteDoc: jest.fn(async (_c: string, id: string) => {
      store.delete(id);
    }),
  };
  return { adapter, store };
}

const SEED = [
  { id: 'p1', data: { title: 'Rocketry', slug: 'rocketry', status: 'active' } },
  { id: 'p2', data: { title: 'CubeSat', slug: 'cubesat', status: 'published' } },
];

describe('adapter bridge', () => {
  it('listDocs flattens to { id, ...data } and rows split back to { id, data }', async () => {
    const { adapter } = makeFakeAdapter(SEED);
    __setSupaAdapterForTests(adapter);
    await expect(supaListProjects()).resolves.toEqual([
      { id: 'p1', title: 'Rocketry', slug: 'rocketry', status: 'active' },
      { id: 'p2', title: 'CubeSat', slug: 'cubesat', status: 'published' },
    ]);
    await expect(supaListProjectRows()).resolves.toEqual([
      { id: 'p1', data: { title: 'Rocketry', slug: 'rocketry', status: 'active' } },
      { id: 'p2', data: { title: 'CubeSat', slug: 'cubesat', status: 'published' } },
    ]);
    expect(adapter.listDocs).toHaveBeenCalledWith('projects');
  });

  it('getDoc hit and miss', async () => {
    const { adapter } = makeFakeAdapter(SEED);
    __setSupaAdapterForTests(adapter);
    await expect(supaGetProject('p2')).resolves.toMatchObject({ id: 'p2', slug: 'cubesat' });
    await expect(supaGetProject('nope')).resolves.toBe(null);
  });

  it('find by slug-or-id: id first, then slug, then null', async () => {
    const { adapter } = makeFakeAdapter(SEED);
    __setSupaAdapterForTests(adapter);
    await expect(supaFindProjectBySlugOrId('p1')).resolves.toMatchObject({ id: 'p1' });
    await expect(supaFindProjectBySlugOrId('cubesat')).resolves.toMatchObject({ id: 'p2' });
    await expect(supaFindProjectBySlugOrId('missing')).resolves.toBe(null);
    await expect(supaFindProjectBySlugOrId('')).resolves.toBe(null);
  });

  it('find falls through to the slug query when the id get throws (Firestore parity)', async () => {
    const { adapter, store } = makeFakeAdapter(SEED);
    (adapter.getDoc as jest.Mock).mockRejectedValue(new Error('get failed'));
    __setSupaAdapterForTests(adapter);
    await expect(supaFindProjectBySlugOrId('rocketry')).resolves.toMatchObject({ id: 'p1' });
    expect(store.size).toBe(2);
  });

  it('set/update/delete delegate; update on a missing row writes nothing', async () => {
    const { adapter, store } = makeFakeAdapter(SEED);
    __setSupaAdapterForTests(adapter);
    await supaSetProject('p3', { title: 'Rover', slug: 'rover' });
    expect(store.get('p3')).toEqual({ title: 'Rover', slug: 'rover' });
    await expect(supaUpdateProject('p3', { status: 'active' })).resolves.toBe(true);
    expect(store.get('p3')).toEqual({ title: 'Rover', slug: 'rover', status: 'active' });
    await expect(supaUpdateProject('ghost', { status: 'active' })).resolves.toBe(false);
    expect(store.has('ghost')).toBe(false);
    expect(adapter.updateDoc).not.toHaveBeenCalledWith('projects', 'ghost', expect.anything());
    await supaDeleteProject('p3');
    expect(store.has('p3')).toBe(false);
  });

  it('forced-off adapter rejects, so callers fall back', async () => {
    __setSupaAdapterForTests(null);
    await expect(supaListProjects()).rejects.toThrow('adapter unavailable');
  });

  it('adapter errors propagate', async () => {
    const { adapter } = makeFakeAdapter(SEED);
    (adapter.listDocs as jest.Mock).mockRejectedValue(new Error('query-failed'));
    __setSupaAdapterForTests(adapter);
    await expect(supaListProjects()).rejects.toThrow('query-failed');
  });
});

// -------------------------------------------------------- client fetch

describe('client route fetchers', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('getCurrentUserIdToken resolves the mocked user token', async () => {
    await expect(getCurrentUserIdToken()).resolves.toBe('tok-123');
  });

  it('fetchProjectsViaRoute sends params + bearer and returns projects', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({ projects: [{ id: 'p1', title: 'Rocketry' }] }),
    }));
    global.fetch = fetchFn as any;
    const out = await fetchProjectsViaRoute({ featuredOnly: true, limit: 3 });
    expect(out).toEqual([{ id: 'p1', title: 'Rocketry' }]);
    const [url, init] = fetchFn.mock.calls[0] as any[];
    expect(url).toBe('/api/projects?featured=1&limit=3');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('fetchProjectsViaRoute throws on !ok so callers fall back', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    await expect(fetchProjectsViaRoute()).rejects.toThrow('projects route 404');
  });

  it('fetchProjectBySlugOrIdViaRoute returns the doc or null', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ project: { id: 'p1' } }),
    })) as any;
    await expect(fetchProjectBySlugOrIdViaRoute('p1')).resolves.toEqual({ id: 'p1' });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ project: null }),
    })) as any;
    await expect(fetchProjectBySlugOrIdViaRoute('nope')).resolves.toBe(null);
  });

  it('fetchAdminProjectRowsViaRoute returns rows and throws on !ok', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ rows: [{ id: 'p1', data: { title: 'R' } }] }),
    })) as any;
    await expect(fetchAdminProjectRowsViaRoute('tok')).resolves.toEqual([
      { id: 'p1', data: { title: 'R' } },
    ]);
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
    await expect(fetchAdminProjectRowsViaRoute('tok')).rejects.toThrow('503');
  });

  it('mirror never throws, serializes data, and skips on a null token', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchFn as any;
    await mirrorProjectViaRoute('tok', 'set', 'p1', {
      title: 'R',
      createdAt: { toDate: () => new Date('2023-11-14T22:13:20.000Z') },
    });
    const body = JSON.parse((fetchFn.mock.calls[0] as any[])[1].body);
    expect(body).toEqual({ op: 'set', id: 'p1', data: { title: 'R', createdAt: '2023-11-14T22:13:20.000Z' } });

    fetchFn.mockClear();
    await mirrorProjectViaRoute(null, 'delete', 'p1');
    expect(fetchFn).not.toHaveBeenCalled();

    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as any;
    await expect(mirrorProjectViaRoute('tok', 'delete', 'p1')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});
