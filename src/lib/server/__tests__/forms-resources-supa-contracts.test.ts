/**
 * @jest-environment node
 *
 * Forms + resources Supabase contract suite (migration step 11,
 * Clusters J + K).
 *
 * Pins, for every surface:
 *  - flag OFF            -> Firestore (Admin SDK) behavior via the new
 *                           routes, adapter never called
 *  - flag ON             -> Supabase serves reads, shapes unchanged
 *  - adapter error       -> Firestore fallback, response unchanged
 *  - writes              -> Firestore primary; mirrors best-effort and
 *                           never able to fail the write; the member
 *                           response append mirrors with the SAME doc
 *                           id Firestore received (append shape)
 *  - auth                -> the new routes enforce the same permission
 *                           names the admin pages gate on
 *                           (canManageForms / canManageResources)
 *
 * Everything is mocked: '@/lib/supa' is a fake adapter over in-memory
 * rows, firebase-admin is FakeFirestore. Zero live reads.
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
      const orders = options.orderBy
        ? Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
        : [];
      for (const o of orders) {
        rows = [...rows].sort((a: any, b: any) => {
          const at = a[o.field]?.toDate ? a[o.field].toDate().getTime() : new Date(a[o.field]).getTime();
          const bt = b[o.field]?.toDate ? b[o.field].toDate().getTime() : new Date(b[o.field]).getTime();
          return o.direction === 'desc' ? bt - at : at - bt;
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
    updateDoc: async () => { throw new Error('unused in this suite'); },
    deleteDoc: async () => undefined,
    countDocs: async () => 0,
  }),
}));

const mockDbHolder: { db: any } = { db: null };
const mockAuth = { uid: 'admin-1', permission: true };

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
  verifyIdTokenString: async () => ({ uid: mockAuth.uid }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => mockAuth.permission,
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './fake-firestore';
import { GET as formsGET, POST as formsPOST } from '@/app/api/forms/route';
import { GET as responsesGET, POST as responsesPOST } from '@/app/api/forms/[formId]/responses/route';
import { GET as resourcesGET, POST as resourcesPOST } from '@/app/api/resources/route';
import { GET as competitionsGET } from '@/app/api/resources/competitions/route';

/** FakeDb lacks collection.add(); shim it (same as the blog suite). */
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
    return col;
  };
  return db;
}

function req(url: string, init?: any) {
  return new NextRequest(url, init);
}

function jsonReq(url: string, body: unknown, method = 'POST') {
  return req(url, {
    method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

const FORM = {
  title: 'Induction Survey', description: 'Tell us things',
  fields: [{ id: 'f1', label: 'Name', type: 'text', required: true }],
};

beforeEach(() => {
  mockSupa.surfaces.clear();
  mockSupa.clientConfigured = true;
  mockSupa.fail = false;
  mockSupa.rows.clear();
  mockSupa.calls = [];
  mockSupa.setDocCalls = [];
  mockAuth.uid = 'admin-1';
  mockAuth.permission = true;
  mockDbHolder.db = shimDb(createFakeDb());
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

/* ------------------------------------------------------------------ forms */

describe('forms list/create (step 11, surface forms)', () => {
  it('flag OFF: Firestore serves the list, adapter never called', async () => {
    mockDbHolder.db.seed('forms', 'form-1', { ...FORM, createdAt: mockTs('2026-02-01T00:00:00.000Z'), updatedAt: mockTs('2026-02-01T00:00:00.000Z') });
    const res = await formsGET(req('http://localhost/api/forms'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.forms).toHaveLength(1);
    expect(body.forms[0].id).toBe('form-1');
    // Timestamps serialize to ISO on this route in BOTH modes.
    expect(body.forms[0].createdAt).toBe('2026-02-01T00:00:00.000Z');
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase serves the same shape', async () => {
    mockCol('forms').set('form-9', { ...FORM, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' });
    mockSupa.surfaces.add('forms');
    const res = await formsGET(req('http://localhost/api/forms'));
    const body = await res.json();
    expect(body.forms.map((f: any) => f.id)).toEqual(['form-9']);
    expect(body.forms[0].createdAt).toBe('2026-03-01T00:00:00.000Z');
    expect(mockSupa.calls).toContain('listDocs:forms');
  });

  it('flag ON + adapter error: Firestore fallback', async () => {
    mockDbHolder.db.seed('forms', 'form-1', { ...FORM });
    mockSupa.surfaces.add('forms');
    mockSupa.fail = true;
    const res = await formsGET(req('http://localhost/api/forms'));
    const body = await res.json();
    expect(body.forms.map((f: any) => f.id)).toEqual(['form-1']);
  });

  it('permission denied -> 403 (same gate the admin page uses)', async () => {
    mockAuth.permission = false;
    const res = await formsGET(req('http://localhost/api/forms'));
    expect(res.status).toBe(403);
  });

  it('POST create: Firestore primary; mirror only when flag ON; validation unchanged', async () => {
    let res = await formsPOST(jsonReq('http://localhost/api/forms', { title: 'X' }));
    expect(res.status).toBe(400);

    res = await formsPOST(jsonReq('http://localhost/api/forms', FORM));
    expect(res.status).toBe(201);
    expect(mockDbHolder.db.all('forms')).toHaveLength(1);
    expect(mockSupa.setDocCalls).toEqual([]);

    mockSupa.surfaces.add('forms');
    res = await formsPOST(jsonReq('http://localhost/api/forms', FORM));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(mockSupa.setDocCalls).toHaveLength(1);
    expect(mockSupa.setDocCalls[0].col).toBe('forms');
    expect(mockSupa.setDocCalls[0].id).toBe(body.id);

    mockSupa.fail = true;
    res = await formsPOST(jsonReq('http://localhost/api/forms', FORM));
    expect(res.status).toBe(201);
    expect(mockDbHolder.db.all('forms')).toHaveLength(3);
  });
});

/* ------------------------------------------------------------- responses */

describe('form responses (step 11, surface forms)', () => {
  const RESP = { formId: 'form-1', data: { f1: 'Bushra' }, submittedBy: 'member-1' };

  it('flag OFF: Firestore serves form + responses', async () => {
    mockDbHolder.db.seed('forms', 'form-1', { ...FORM });
    mockDbHolder.db.seed('forms/form-1/responses', 'resp-1', { ...RESP, submittedAt: mockTs('2026-02-02T00:00:00.000Z') });
    const res = await responsesGET(req('http://localhost/api/forms/form-1/responses'), { params: Promise.resolve({ formId: 'form-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.form.id).toBe('form-1');
    expect(body.responses).toHaveLength(1);
    expect(body.responses[0].submittedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase serves form + responses from the subcollection path', async () => {
    mockCol('forms').set('form-1', { ...FORM });
    mockCol('forms/form-1/responses').set('resp-9', { ...RESP, submittedAt: '2026-04-02T00:00:00.000Z' });
    mockSupa.surfaces.add('forms');
    const res = await responsesGET(req('http://localhost/api/forms/form-1/responses'), { params: Promise.resolve({ formId: 'form-1' }) });
    const body = await res.json();
    expect(body.responses.map((r: any) => r.id)).toEqual(['resp-9']);
    expect(mockSupa.calls).toContain('listDocs:forms/form-1/responses');
  });

  it('flag ON + adapter error: Firestore fallback', async () => {
    mockDbHolder.db.seed('forms', 'form-1', { ...FORM });
    mockDbHolder.db.seed('forms/form-1/responses', 'resp-1', { ...RESP });
    mockSupa.surfaces.add('forms');
    mockSupa.fail = true;
    const res = await responsesGET(req('http://localhost/api/forms/form-1/responses'), { params: Promise.resolve({ formId: 'form-1' }) });
    const body = await res.json();
    expect(body.responses.map((r: any) => r.id)).toEqual(['resp-1']);
  });

  it('missing form -> 404 in both modes', async () => {
    let res = await responsesGET(req('http://localhost/api/forms/nope/responses'), { params: Promise.resolve({ formId: 'nope' }) });
    expect(res.status).toBe(404);
    mockSupa.surfaces.add('forms');
    res = await responsesGET(req('http://localhost/api/forms/nope/responses'), { params: Promise.resolve({ formId: 'nope' }) });
    expect(res.status).toBe(404);
  });

  it('POST append: Firestore primary with a pre-generated id; the mirror lands under the SAME id on the subcollection path', async () => {
    mockDbHolder.db.seed('forms', 'form-1', { ...FORM });
    mockAuth.uid = 'member-1';
    mockSupa.surfaces.add('forms');
    const res = await responsesPOST(
      jsonReq('http://localhost/api/forms/form-1/responses', { data: { f1: 'Bushra' } }),
      { params: Promise.resolve({ formId: 'form-1' }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const stored = mockDbHolder.db.all('forms/form-1/responses');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(body.id);
    expect(stored[0].data.submittedBy).toBe('member-1');
    expect(mockSupa.setDocCalls).toHaveLength(1);
    expect(mockSupa.setDocCalls[0].col).toBe('forms/form-1/responses');
    expect(mockSupa.setDocCalls[0].id).toBe(body.id);
    expect(mockSupa.setDocCalls[0].data.data).toEqual({ f1: 'Bushra' });
  });

  it('POST append: mirror failure never fails the append; missing form -> 404; bad body -> 400', async () => {
    mockDbHolder.db.seed('forms', 'form-1', { ...FORM });
    mockSupa.surfaces.add('forms');
    mockSupa.fail = true;
    let res = await responsesPOST(
      jsonReq('http://localhost/api/forms/form-1/responses', { data: { f1: 'x' } }),
      { params: Promise.resolve({ formId: 'form-1' }) },
    );
    expect(res.status).toBe(201);
    res = await responsesPOST(
      jsonReq('http://localhost/api/forms/nope/responses', { data: { f1: 'x' } }),
      { params: Promise.resolve({ formId: 'nope' }) },
    );
    expect(res.status).toBe(404);
    res = await responsesPOST(
      jsonReq('http://localhost/api/forms/form-1/responses', {}),
      { params: Promise.resolve({ formId: 'form-1' }) },
    );
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------- resources */

describe('resources (step 11, surface resources)', () => {
  const RES_OLD = { title: 'Old Resource', type: 'documentation', url: 'https://x/old' };
  const RES_NEW = { title: 'New Resource', type: 'software', url: 'https://x/new' };

  it('flag OFF: Firestore serves createdAt-desc order', async () => {
    mockDbHolder.db.seed('resources', 'res-old', { ...RES_OLD, createdAt: new Date('2026-01-01T00:00:00.000Z') });
    mockDbHolder.db.seed('resources', 'res-new', { ...RES_NEW, createdAt: new Date('2026-06-01T00:00:00.000Z') });
    const res = await resourcesGET();
    const body = await res.json();
    expect(body.items.map((r: any) => r.id)).toEqual(['res-new', 'res-old']);
    expect(body.items[0].createdAt).toBe('2026-06-01T00:00:00.000Z');
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: Supabase serves the same order + shape', async () => {
    mockCol('resources').set('res-old', { ...RES_OLD, createdAt: '2026-01-01T00:00:00.000Z' });
    mockCol('resources').set('res-new', { ...RES_NEW, createdAt: '2026-06-01T00:00:00.000Z' });
    mockSupa.surfaces.add('resources');
    const res = await resourcesGET();
    const body = await res.json();
    expect(body.items.map((r: any) => r.id)).toEqual(['res-new', 'res-old']);
    expect(mockSupa.calls).toContain('listDocs:resources');
  });

  it('flag ON + adapter error: Firestore fallback', async () => {
    mockDbHolder.db.seed('resources', 'res-old', { ...RES_OLD, createdAt: new Date('2026-01-01T00:00:00.000Z') });
    mockSupa.surfaces.add('resources');
    mockSupa.fail = true;
    const res = await resourcesGET();
    const body = await res.json();
    expect(body.items.map((r: any) => r.id)).toEqual(['res-old']);
  });

  it('POST create: permission gate, Firestore primary, mirror when flag ON', async () => {
    mockAuth.permission = false;
    let res = await resourcesPOST(jsonReq('http://localhost/api/resources', RES_NEW));
    expect(res.status).toBe(403);

    mockAuth.permission = true;
    res = await resourcesPOST(jsonReq('http://localhost/api/resources', RES_NEW));
    expect(res.status).toBe(201);
    expect(mockSupa.setDocCalls).toEqual([]);

    mockSupa.surfaces.add('resources');
    res = await resourcesPOST(jsonReq('http://localhost/api/resources', RES_NEW));
    expect(res.status).toBe(201);
    expect(mockSupa.setDocCalls.map((c) => c.col)).toEqual(['resources']);
  });
});

/* ----------------------------------------------------------- competitions */

describe('competitions list (step 11, surface resources)', () => {
  const COMP = { title: 'CanSat', description: 'd', featuredImage: '', startDate: '2026-05-01', endDate: '2026-05-02', isPublic: true };

  it('flag OFF: Firestore serves; flag ON: Supabase serves; error: fallback', async () => {
    mockDbHolder.db.seed('competitions', 'comp-fs', { ...COMP });
    let res = await competitionsGET(req('http://localhost/api/resources/competitions'));
    let body = await res.json();
    expect(body.items.map((c: any) => c.id)).toEqual(['comp-fs']);
    expect(mockSupa.calls).toEqual([]);

    mockCol('competitions').set('comp-supa', { ...COMP });
    mockSupa.surfaces.add('resources');
    res = await competitionsGET(req('http://localhost/api/resources/competitions'));
    body = await res.json();
    expect(body.items.map((c: any) => c.id)).toEqual(['comp-supa']);

    mockSupa.fail = true;
    res = await competitionsGET(req('http://localhost/api/resources/competitions'));
    body = await res.json();
    expect(body.items.map((c: any) => c.id)).toEqual(['comp-fs']);
  });

  it('permission denied -> 403', async () => {
    mockAuth.permission = false;
    const res = await competitionsGET(req('http://localhost/api/resources/competitions'));
    expect(res.status).toBe(403);
  });
});
