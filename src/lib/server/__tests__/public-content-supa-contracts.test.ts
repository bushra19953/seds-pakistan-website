/**
 * @jest-environment node
 *
 * Public-content Supabase contract suite (migration steps 6, Cluster E
 * surfaces: organizations, organizations/homepage, site-state,
 * public intake-window, public skills).
 *
 * Pins, for every surface:
 *  - flag OFF            -> Firestore behavior, adapter never called
 *  - flag ON             -> Supabase serves, response shape unchanged
 *  - adapter error       -> Firestore fallback, response unchanged
 *  - writes              -> Firestore primary; mirror best-effort and
 *                           never able to fail the write
 *
 * Everything is mocked: '@/lib/supa' is a fake adapter over in-memory
 * rows, firebase-admin is FakeFirestore. Zero live reads.
 *
 * Mocked-away neighbors (their own clusters' contracts, not this
 * suite's): the related-party logo gate (pass-through here — all seed
 * orgs are unlinked, so the real gate performs no reads either), token
 * verification, and the permissions resolver.
 */

const mockSupa = {
  surfaces: new Set<string>(),
  clientConfigured: true,
  fail: false,
  rows: new Map<string, Map<string, Record<string, any>>>(),
  calls: [] as string[],
  setDocCalls: [] as Array<{ col: string; id: string; data: any; opts?: any }>,
};

function mockCol(col: string) {
  let m = mockSupa.rows.get(col);
  if (!m) { m = new Map(); mockSupa.rows.set(col, m); }
  return m;
}

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) =>
    mockSupa.surfaces.has('*') || mockSupa.surfaces.has(surface.trim().toLowerCase()),
  getSupaClient: () => (mockSupa.clientConfigured ? {} : null),
  getSupaAdapter: () => ({
    listDocs: async (col: string, options: any = {}) => {
      mockSupa.calls.push(`listDocs:${col}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      let rows = [...mockCol(col).entries()].map(([id, data]) => ({ id, ...data }));
      for (const [field, op, value] of options.where ?? []) {
        if (op !== '==') throw new Error(`fake adapter: unsupported op ${op}`);
        rows = rows.filter((r: any) => r[field] === value);
      }
      const orders = options.orderBy
        ? Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
        : [];
      for (const o of orders) {
        rows = [...rows].sort((a: any, b: any) => {
          const av = a[o.field]; const bv = b[o.field];
          const c = av < bv ? -1 : av > bv ? 1 : 0;
          return o.direction === 'desc' ? -c : c;
        });
      }
      if (typeof options.limit === 'number') rows = rows.slice(0, options.limit);
      return rows;
    },
    getDoc: async (col: string, id: string) => {
      mockSupa.calls.push(`getDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const data = mockCol(col).get(id);
      return data ? { id, ...data } : null;
    },
    setDoc: async (col: string, id: string, data: any, opts?: any) => {
      mockSupa.calls.push(`setDoc:${col}/${id}`);
      mockSupa.setDocCalls.push({ col, id, data, opts });
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const existing = mockCol(col).get(id);
      mockCol(col).set(id, opts?.merge && existing ? { ...existing, ...data } : { ...data });
      return { id, ...data };
    },
    updateDoc: async (col: string, id: string, data: any) => {
      mockSupa.calls.push(`updateDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const existing = mockCol(col).get(id);
      if (!existing) { const e: any = new Error('not found'); e.code = 'not-found'; throw e; }
      mockCol(col).set(id, { ...existing, ...data });
      return { id, ...existing, ...data };
    },
    deleteDoc: async (col: string, id: string) => {
      mockSupa.calls.push(`deleteDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      mockCol(col).delete(id);
    },
    countDocs: async () => 0,
  }),
}));

const mockDbHolder: { db: any } = { db: null };

function mockTs(iso: string) {
  const d = new Date(iso);
  return {
    toDate: () => d,
    toMillis: () => d.getTime(),
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getAdminDiagnostics: () => ({}),
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => mockTs(new Date().toISOString()) },
      Timestamp: { fromMillis: (ms: number) => mockTs(new Date(ms).toISOString()) },
    },
    auth: {},
  },
}));

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'tok',
  verifyIdTokenString: async () => ({ uid: 'admin-1' }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
}));

jest.mock('@/lib/finance/public-org-gate', () => ({
  filterPublicOrganizations: async (_db: unknown, orgs: any[]) => orgs,
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './fake-firestore';
import { GET as orgsGET, POST as orgsPOST } from '@/app/api/organizations/route';
import { GET as homepageGET, POST as homepagePOST } from '@/app/api/organizations/homepage/route';
import { GET as siteStateGET } from '@/app/api/site-state/route';
import { GET as intakeGET } from '@/app/api/public/intake-window/route';
import { GET as skillsGET, __resetSkillsSeedGuard } from '@/app/api/public/skills/route';
import { getEffectiveSiteState } from '@/lib/server/platform-licence';

/** FakeDb snapshots lack forEach + collection.add(); shim both (the
 * same shim the blog contract suite applies). */
function shimDb(db: FakeDb): FakeDb {
  const origCollection = db.collection.bind(db);
  (db as any).collection = (name: string) => {
    const col: any = origCollection(name);
    if (typeof col.add !== 'function') {
      col.add = async (data: any) => {
        const ref = col.doc();
        await ref.set(data);
        return ref;
      };
    }
    const origGet = col.get.bind(col);
    col.get = async (...args: any[]) => {
      const snap = await origGet(...args);
      if (snap && Array.isArray(snap.docs) && typeof snap.forEach !== 'function') {
        snap.forEach = (cb: (doc: any) => void) => snap.docs.forEach(cb);
      }
      return snap;
    };
    return col;
  };
  return db;
}

function req(url: string, init?: any) {
  return new NextRequest(url, init);
}

const ORG_A = {
  name: 'Alpha Chapter', logoUrl: 'https://x/a.png', websiteUrl: '',
  type: 'National Chapter', showOnHomepageMarquee: true, displayOrder: 2,
  isActive: true, isGlobal: true, partnerId: null, logoUseGranted: false,
  description: 'a',
};
const ORG_B = {
  name: 'Beta Sponsor', logoUrl: 'https://x/b.png', websiteUrl: '',
  type: 'Sponsor', showOnHomepageMarquee: true, displayOrder: 1,
  isActive: true, isGlobal: false, partnerId: null, logoUseGranted: false,
  description: 'b',
};
const ORG_INACTIVE = { ...ORG_A, name: 'Ghost', isActive: false };

function seedFirestoreOrgs(db: FakeDb) {
  db.seed('organizations', 'org-a', { ...ORG_A, createdAt: mockTs('2026-01-01T00:00:00.000Z'), updatedAt: mockTs('2026-01-02T00:00:00.000Z') });
  db.seed('organizations', 'org-b', { ...ORG_B, createdAt: mockTs('2026-01-01T00:00:00.000Z'), updatedAt: mockTs('2026-01-02T00:00:00.000Z') });
  db.seed('organizations', 'org-ghost', { ...ORG_INACTIVE, createdAt: mockTs('2026-01-01T00:00:00.000Z'), updatedAt: mockTs('2026-01-02T00:00:00.000Z') });
}

function seedSupaOrgs() {
  mockCol('organizations').set('org-a', { ...ORG_A, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  mockCol('organizations').set('org-b', { ...ORG_B, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  mockCol('organizations').set('org-ghost', { ...ORG_INACTIVE, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
}

beforeEach(() => {
  mockSupa.surfaces.clear();
  mockSupa.clientConfigured = true;
  mockSupa.fail = false;
  mockSupa.rows.clear();
  mockSupa.calls = [];
  mockSupa.setDocCalls = [];
  mockDbHolder.db = shimDb(createFakeDb());
  __resetSkillsSeedGuard();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

/* ------------------------------------------------------------ organizations */

describe('organizations list (step 6, surface organizations)', () => {
  it('flag OFF: Firestore serves, adapter never called, inactive filtered, sorted', async () => {
    seedFirestoreOrgs(mockDbHolder.db);
    const res = await orgsGET(req('http://localhost/api/organizations'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.organizations.map((o: any) => o.id)).toEqual(['org-b', 'org-a']);
    expect(body.organizations[0].createdAt).toBeDefined();
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase serves the same payload shape', async () => {
    seedFirestoreOrgs(mockDbHolder.db);
    seedSupaOrgs();
    mockSupa.surfaces.add('organizations');
    const res = await orgsGET(req('http://localhost/api/organizations?showOnHomepage=true'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.organizations.map((o: any) => o.id)).toEqual(['org-b', 'org-a']);
    expect(mockSupa.calls).toContain('listDocs:organizations');
    // Supa ISO dates are parsed back to Dates by the mapper.
    expect(String(body.organizations[0].createdAt)).toContain('2026');
  });

  it('flag ON + adapter error: Firestore fallback, response unchanged', async () => {
    seedFirestoreOrgs(mockDbHolder.db);
    seedSupaOrgs();
    mockSupa.surfaces.add('organizations');
    mockSupa.fail = true;
    const res = await orgsGET(req('http://localhost/api/organizations'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.organizations.map((o: any) => o.id)).toEqual(['org-b', 'org-a']);
  });

  it('flag ON + client unconfigured: Firestore fallback', async () => {
    seedFirestoreOrgs(mockDbHolder.db);
    mockSupa.surfaces.add('organizations');
    mockSupa.clientConfigured = false;
    const res = await orgsGET(req('http://localhost/api/organizations'));
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(mockSupa.calls).toEqual([]);
  });

  it('POST create: Firestore primary; mirror fires only when flag ON; mirror failure never fails the create', async () => {
    const payload = { name: 'New Org', logoUrl: 'https://x/n.png' };
    // flag OFF
    let res = await orgsPOST(req('http://localhost/api/organizations', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    expect(mockSupa.setDocCalls).toEqual([]);
    expect(mockDbHolder.db.all('organizations')).toHaveLength(1);

    // flag ON
    mockSupa.surfaces.add('organizations');
    res = await orgsPOST(req('http://localhost/api/organizations', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    expect(mockSupa.setDocCalls.map((c) => c.col)).toEqual(['organizations']);

    // flag ON + adapter broken: create still succeeds on Firestore
    mockSupa.fail = true;
    res = await orgsPOST(req('http://localhost/api/organizations', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    expect(mockDbHolder.db.all('organizations')).toHaveLength(3);
  });
});

/* ------------------------------------------------------ organizations/homepage */

describe('organizations homepage (step 6, surface organizations)', () => {
  async function clearCache() {
    await homepagePOST(req('http://localhost/api/organizations/homepage?action=clear-cache', { method: 'POST' }));
  }

  // NOTE (parity, both modes): the homepage mapper's pre-existing
  // `isActive: data?.isActive || true` quirk makes even the isActive:
  // false "ghost" org active on this route. Both expectations below
  // pin that quirk identically for Firestore and Supabase — the seam
  // preserves it, it does not fix it.
  it('flag OFF: Firestore serves, sections split as before', async () => {
    await clearCache();
    seedFirestoreOrgs(mockDbHolder.db);
    const res = await homepageGET(req('http://localhost/api/organizations/homepage'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.globalChapters.map((o: any) => o.id)).toEqual(['org-a', 'org-ghost']);
    expect(body.localSupporters.map((o: any) => o.id)).toEqual(['org-b']);
    expect(body.metadata.totalChapters).toBe(2);
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase serves the same sections', async () => {
    await clearCache();
    seedFirestoreOrgs(mockDbHolder.db);
    seedSupaOrgs();
    mockSupa.surfaces.add('organizations');
    const res = await homepageGET(req('http://localhost/api/organizations/homepage'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.globalChapters.map((o: any) => o.id)).toEqual(['org-a', 'org-ghost']);
    expect(body.localSupporters.map((o: any) => o.id)).toEqual(['org-b']);
    expect(mockSupa.calls).toContain('listDocs:organizations');
  });
});

/* ------------------------------------------------------------ site-state */

describe('site-state (step 6, surface site-state)', () => {
  function seedFirestoreState(db: FakeDb) {
    db.seed('settings', 'siteWide', { siteEnabled: true, maintenanceMode: true });
    db.seed('governance', 'platform_licence', { status: 'active' });
  }

  it('flag OFF: Firestore switches drive the state (maintenance)', async () => {
    seedFirestoreState(mockDbHolder.db);
    const state = await getEffectiveSiteState();
    expect(state.mode).toBe('maintenance');
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase docs drive the state (revoked + public notice surfaced by the route)', async () => {
    seedFirestoreState(mockDbHolder.db);
    mockCol('settings').set('siteWide', { siteEnabled: true, maintenanceMode: false });
    mockCol('governance').set('platform_licence', {
      status: 'notice_served',
      effectiveRevocationAt: '2020-01-01T00:00:00.000Z',
      licencePublicNotice: 'Licence revoked notice',
    });
    mockSupa.surfaces.add('site-state');
    const state = await getEffectiveSiteState();
    expect(state.mode).toBe('revoked');
    const res = await siteStateGET();
    const body = await res.json();
    expect(body).toEqual({ mode: 'revoked', licencePublicNotice: 'Licence revoked notice' });
    expect(mockSupa.calls).toContain('getDoc:governance/platform_licence');
  });

  it('flag ON + adapter error: Firestore fallback (maintenance), never a spurious live/revoked flip', async () => {
    seedFirestoreState(mockDbHolder.db);
    mockSupa.surfaces.add('site-state');
    mockSupa.fail = true;
    const state = await getEffectiveSiteState();
    expect(state.mode).toBe('maintenance');
  });

  it('explicit db argument always wins over the seam (injected-db callers keep Firestore semantics)', async () => {
    seedFirestoreState(mockDbHolder.db);
    mockCol('settings').set('siteWide', { siteEnabled: true, maintenanceMode: false });
    mockCol('governance').set('platform_licence', { status: 'revoked', licencePublicNotice: 'x' });
    mockSupa.surfaces.add('site-state');
    const state = await getEffectiveSiteState(mockDbHolder.db);
    expect(state.mode).toBe('maintenance');
  });
});

/* ------------------------------------------------------------ intake window */

describe('public intake-window (step 6, surface intake-windows)', () => {
  const OPENS = '2026-01-01T00:00:00.000Z';
  const CLOSES = '2999-01-01T00:00:00.000Z';

  function seedFirestoreWindow(db: FakeDb) {
    db.seed('intake_windows', 'win-fs', {
      windowId: 'win-fs', kind: 'induction', label: 'Firestore Window',
      opensAt: mockTs(OPENS), closesAt: mockTs(CLOSES),
      isDefault: false, storedStatus: null, createdAt: mockTs(OPENS),
    });
  }

  it('flag OFF: Firestore window resolves open', async () => {
    seedFirestoreWindow(mockDbHolder.db);
    const res = await intakeGET(req('http://localhost/api/public/intake-window?kind=induction'));
    const body = await res.json();
    expect(body.state).toBe('open');
    expect(body.windowId).toBe('win-fs');
    expect(res.headers.get('x-intake-source')).toBe('data');
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase window (ISO shapes) resolves open with its own label/id', async () => {
    seedFirestoreWindow(mockDbHolder.db);
    mockCol('intake_windows').set('win-supa', {
      windowId: 'win-supa', kind: 'induction', label: 'Supa Window',
      opensAt: OPENS, closesAt: CLOSES, isDefault: false, storedStatus: null,
      createdAt: OPENS,
    });
    mockSupa.surfaces.add('intake-windows');
    const res = await intakeGET(req('http://localhost/api/public/intake-window?kind=induction'));
    const body = await res.json();
    expect(body.state).toBe('open');
    expect(body.windowId).toBe('win-supa');
    expect(mockSupa.calls).toContain('listDocs:intake_windows');
  });

  it('flag ON + adapter error: Firestore fallback still resolves open (fail-safe posture unchanged)', async () => {
    seedFirestoreWindow(mockDbHolder.db);
    mockSupa.surfaces.add('intake-windows');
    mockSupa.fail = true;
    const res = await intakeGET(req('http://localhost/api/public/intake-window?kind=induction'));
    const body = await res.json();
    expect(body.state).toBe('open');
    expect(body.windowId).toBe('win-fs');
  });

  it('flag ON + empty Supabase list: empty means no windows — shim/fail-safe path, not Firestore data', async () => {
    // No Firestore windows either: induction resolves via the legacy
    // deadline shim exactly as the flag-OFF empty case does.
    mockSupa.surfaces.add('intake-windows');
    const res = await intakeGET(req('http://localhost/api/public/intake-window?kind=induction'));
    expect(res.headers.get('x-intake-source')).toBe('shim');
  });
});

/* ------------------------------------------------------------ public skills */

describe('public skills (step 6 scope: READ only, surface public-skills)', () => {
  function seedFirestoreSkills(db: FakeDb) {
    db.seed('skills', 'programming', { name: 'Programming', slug: 'programming', category: 'General Skills', status: 'active' });
  }

  it('flag OFF: Firestore serves', async () => {
    seedFirestoreSkills(mockDbHolder.db);
    const res = await skillsGET(req('http://localhost/api/public/skills'));
    const body = await res.json();
    expect(body.items.map((s: any) => s.name)).toEqual(['Programming']);
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase serves, route filtering unchanged', async () => {
    seedFirestoreSkills(mockDbHolder.db);
    mockCol('skills').set('cad', { name: 'CAD Modeling', slug: 'cad', category: 'Software & Simulation', status: 'active' });
    mockCol('skills').set('hidden', { name: 'Hidden', slug: 'hidden', category: 'X', status: 'archived' });
    mockSupa.surfaces.add('public-skills');
    const res = await skillsGET(req('http://localhost/api/public/skills?status=active'));
    const body = await res.json();
    expect(body.items.map((s: any) => s.name)).toEqual(['CAD Modeling']);
    expect(mockSupa.calls).toContain('listDocs:skills');
  });

  it('flag ON + adapter error: Firestore fallback', async () => {
    seedFirestoreSkills(mockDbHolder.db);
    mockSupa.surfaces.add('public-skills');
    mockSupa.fail = true;
    const res = await skillsGET(req('http://localhost/api/public/skills'));
    const body = await res.json();
    expect(body.items.map((s: any) => s.name)).toEqual(['Programming']);
  });

  it('flag ON + EMPTY Supabase list: falls back to Firestore (never-blank contract preserved)', async () => {
    seedFirestoreSkills(mockDbHolder.db);
    mockSupa.surfaces.add('public-skills');
    const res = await skillsGET(req('http://localhost/api/public/skills'));
    const body = await res.json();
    expect(body.items.map((s: any) => s.name)).toEqual(['Programming']);
  });
});
