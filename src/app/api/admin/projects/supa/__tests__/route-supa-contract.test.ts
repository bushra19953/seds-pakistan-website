/**
 * @jest-environment node
 *
 * /api/admin/projects/supa — the admin mirror/read endpoint for
 * the projects Supabase surface (cluster I, step 10).
 *
 * Proven here, all against a mocked adapter (zero live reads):
 *  - Gate order: flag OFF -> 404 (even for a valid admin); no/
 *    invalid session -> 401; authenticated without
 *    canManageProjects -> 403; the adapter is never touched
 *    behind a failed gate.
 *  - GET -> { rows } in the seam's { id, data } shape for
 *    fetchAdminProjectRowsViaRoute.
 *  - POST set/update/delete delegate to the adapter bridge;
 *    update-on-missing answers { ok: true, applied: false } (a
 *    missed mirror is a stale copy, not a failed write);
 *    malformed bodies are 400; adapter failure is 503.
 */

const authHolder: { result: any } = { result: { authenticated: false } };
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => authHolder.result),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));

const permHolder: { allowed: boolean } = { allowed: false };
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => permHolder.allowed),
}));

import { NextRequest } from 'next/server';
import { __setSupaAdapterForTests } from '@/lib/projects-supa';
import type { SupaAdapter, SupaDoc } from '@/lib/supa/adapter';
import { GET, POST } from '../route';

const URL = 'http://localhost/api/admin/projects/supa';

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
    listDocs: jest.fn(async () =>
      [...store.entries()].map(([id, data]) => ({ id, ...data }) as SupaDoc),
    ),
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
    rpc: jest.fn(async () => {
      throw new Error('unexpected rpc');
    }),
    tx: jest.fn(async () => {
      throw new Error('unexpected tx');
    }),
  };
  return { adapter, store };
}

function asAdmin() {
  authHolder.result = {
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin', email: '', displayName: null, emailVerified: true, user: {} },
  };
  permHolder.allowed = true;
}

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer <redacted>' } });
}
function postReq(body: unknown) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer <redacted>', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const savedFlag = process.env.SUPA_SURFACES;
beforeEach(() => {
  process.env.SUPA_SURFACES = 'projects';
  authHolder.result = { authenticated: false };
  permHolder.allowed = false;
});
afterEach(() => {
  __setSupaAdapterForTests(undefined);
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedFlag;
});

describe('gate order', () => {
  it('flag OFF -> 404 even for a valid admin; adapter untouched', async () => {
    delete process.env.SUPA_SURFACES;
    asAdmin();
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    expect((await GET(getReq())).status).toBe(404);
    expect((await POST(postReq({ op: 'delete', id: 'p1' }))).status).toBe(404);
    expect(adapter.listDocs).not.toHaveBeenCalled();
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('no session -> 401', async () => {
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    expect((await GET(getReq())).status).toBe(401);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('authenticated without canManageProjects -> 403', async () => {
    authHolder.result = {
      authenticated: true,
      user: { userId: 'u9', role: 'member', email: '', displayName: null, emailVerified: true, user: {} },
    };
    permHolder.allowed = false;
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    expect((await GET(getReq())).status).toBe(403);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('returns rows in the { id, data } seam shape', async () => {
    asAdmin();
    const { adapter } = makeFakeAdapter([
      { id: 'p1', title: 'Rocketry', slug: 'rocketry' } as SupaDoc,
      { id: 'p2', title: 'CubeSat', slug: 'cubesat' } as SupaDoc,
    ]);
    __setSupaAdapterForTests(adapter);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([
      { id: 'p1', data: { title: 'Rocketry', slug: 'rocketry' } },
      { id: 'p2', data: { title: 'CubeSat', slug: 'cubesat' } },
    ]);
  });

  it('adapter failure -> 503', async () => {
    asAdmin();
    const { adapter } = makeFakeAdapter();
    (adapter.listDocs as jest.Mock).mockRejectedValue(new Error('query-failed'));
    __setSupaAdapterForTests(adapter);
    expect((await GET(getReq())).status).toBe(503);
  });
});

describe('POST mirrors', () => {
  it('set writes the full row', async () => {
    asAdmin();
    const { adapter, store } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const res = await POST(postReq({ op: 'set', id: 'p1', data: { title: 'R', slug: 'r' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.get('p1')).toEqual({ title: 'R', slug: 'r' });
  });

  it('update merges into an existing row and reports applied:true', async () => {
    asAdmin();
    const { adapter, store } = makeFakeAdapter([
      { id: 'p1', title: 'R', slug: 'r' } as SupaDoc,
    ]);
    __setSupaAdapterForTests(adapter);
    const res = await POST(postReq({ op: 'update', id: 'p1', data: { status: 'active' } }));
    expect(await res.json()).toEqual({ ok: true, applied: true });
    expect(store.get('p1')).toEqual({ title: 'R', slug: 'r', status: 'active' });
  });

  it('update on a missing row writes nothing and reports applied:false', async () => {
    asAdmin();
    const { adapter, store } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    const res = await POST(postReq({ op: 'update', id: 'ghost', data: { status: 'active' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: false });
    expect(store.has('ghost')).toBe(false);
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });

  it('delete removes the row', async () => {
    asAdmin();
    const { adapter, store } = makeFakeAdapter([
      { id: 'p1', title: 'R' } as SupaDoc,
    ]);
    __setSupaAdapterForTests(adapter);
    const res = await POST(postReq({ op: 'delete', id: 'p1' }));
    expect(await res.json()).toEqual({ ok: true });
    expect(store.has('p1')).toBe(false);
  });

  it('malformed bodies are 400', async () => {
    asAdmin();
    const { adapter } = makeFakeAdapter();
    __setSupaAdapterForTests(adapter);
    expect((await POST(postReq({ op: 'nuke', id: 'p1' }))).status).toBe(400);
    expect((await POST(postReq({ op: 'set', id: 'p1' }))).status).toBe(400);
    expect((await POST(postReq({ op: 'delete' }))).status).toBe(400);
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('adapter failure on a mirror is a 503', async () => {
    asAdmin();
    const { adapter } = makeFakeAdapter();
    (adapter.setDoc as jest.Mock).mockRejectedValue(new Error('write-failed'));
    __setSupaAdapterForTests(adapter);
    expect((await POST(postReq({ op: 'set', id: 'p1', data: { title: 'R' } }))).status).toBe(503);
  });
});
