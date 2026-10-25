/**
 * @jest-environment node
 *
 * /api/admin/announcements/supa — the admin mirror/read route the
 * announcements seam calls (feat/supa-ann-routes).
 *
 * Proven here, all against a mocked adapter (zero live reads):
 *  - Gate order: flag OFF -> 404 (even for a valid admin); no/invalid
 *    session -> 401; authenticated without canManageAnnouncements ->
 *    403; the adapter is never touched behind a failed gate.
 *  - GET -> { rows } in the seam's { id, data } shape for
 *    fetchAdminAnnouncementRowsViaRoute.
 *  - POST set/update/delete delegate to the adapter bridge;
 *    update-on-missing answers { ok: true, applied: false } (a missed
 *    mirror is a stale copy, not a failed write); malformed bodies
 *    are 400; adapter failure is 503.
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
import { __setSupaAdapterForTests } from '@/lib/announcements-supa';
import type { SupaAdapter, SupaDoc } from '@/lib/supa/adapter';
import { GET, POST } from '../route';

const URL = 'http://localhost/api/admin/announcements/supa';

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
      if (!existing) throw new Error(`updateDoc on missing document ${id}`);
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

function asAdmin() {
  authHolder.result = {
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin', email: '', displayName: null, emailVerified: true, user: {} },
  };
  permHolder.allowed = true;
}

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer tok' } });
}
function postReq(body: unknown) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ENV_KEYS = ['SUPA_SURFACES'];
let savedEnv: Record<string, string | undefined> = {};
let fake: ReturnType<typeof makeFakeAdapter>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SUPA_SURFACES = 'announcements';
  authHolder.result = { authenticated: false };
  permHolder.allowed = false;
  fake = makeFakeAdapter([
    { id: 'a1', title: 'One', status: 'published', priority: 2 } as SupaDoc,
    { id: 'a2', title: 'Two', status: 'draft' } as SupaDoc,
  ]);
  __setSupaAdapterForTests(fake.adapter);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setSupaAdapterForTests(undefined);
});

describe('gate', () => {
  it('flag OFF: 404 even for a valid admin; adapter untouched', async () => {
    delete process.env.SUPA_SURFACES;
    asAdmin();
    const res = await GET(getReq());
    expect(res.status).toBe(404);
    expect(fake.adapter.listDocs).not.toHaveBeenCalled();
  });

  it('no session: 401; adapter untouched', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(fake.adapter.listDocs).not.toHaveBeenCalled();
  });

  it('authenticated without canManageAnnouncements: 403', async () => {
    authHolder.result = {
      authenticated: true,
      user: { userId: 'm1', role: 'team_member', email: '', displayName: null, emailVerified: true, user: {} },
    };
    permHolder.allowed = false;
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    expect(fake.adapter.listDocs).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('returns raw rows in the seam {id, data} shape, drafts included (admin list)', async () => {
    asAdmin();
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.map((r: any) => r.id)).toEqual(['a1', 'a2']);
    expect(body.rows[0].data).toEqual({ title: 'One', status: 'published', priority: 2 });
  });

  it('adapter failure: 503', async () => {
    asAdmin();
    __setSupaAdapterForTests(null);
    const res = await GET(getReq());
    expect(res.status).toBe(503);
  });
});

describe('POST mirror ops', () => {
  it('set delegates the full body to the adapter', async () => {
    asAdmin();
    const res = await POST(postReq({ op: 'set', id: 'n1', data: { title: 'New', status: 'draft' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.adapter.setDoc).toHaveBeenCalledWith('announcements', 'n1', {
      title: 'New',
      status: 'draft',
    });
    expect(fake.store.get('n1')).toEqual({ title: 'New', status: 'draft' });
  });

  it('update merges and answers applied:true', async () => {
    asAdmin();
    const res = await POST(postReq({ op: 'update', id: 'a1', data: { status: 'draft' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true });
    expect(fake.store.get('a1')).toEqual({ title: 'One', status: 'draft', priority: 2 });
  });

  it('update on a row the mirror does not hold: 200 applied:false, nothing written', async () => {
    asAdmin();
    const res = await POST(postReq({ op: 'update', id: 'ghost', data: { status: 'draft' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: false });
    expect(fake.store.has('ghost')).toBe(false);
  });

  it('delete delegates', async () => {
    asAdmin();
    const res = await POST(postReq({ op: 'delete', id: 'a2' }));
    expect(res.status).toBe(200);
    expect(fake.adapter.deleteDoc).toHaveBeenCalledWith('announcements', 'a2');
    expect(fake.store.has('a2')).toBe(false);
  });

  it('malformed writes are 400 and never reach the adapter', async () => {
    asAdmin();
    for (const body of [
      { op: 'nope', id: 'a1', data: {} },
      { op: 'set', id: '', data: {} },
      { op: 'set', id: 'a1' },
      { op: 'update', data: { status: 'draft' } },
    ]) {
      const res = await POST(postReq(body));
      expect(res.status).toBe(400);
    }
    expect(fake.adapter.setDoc).not.toHaveBeenCalled();
    expect(fake.adapter.updateDoc).not.toHaveBeenCalled();
    expect(fake.adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('POST behind a failed gate never reaches the adapter', async () => {
    // authenticated but not permitted
    authHolder.result = {
      authenticated: true,
      user: { userId: 'm1', role: 'team_member', email: '', displayName: null, emailVerified: true, user: {} },
    };
    const res = await POST(postReq({ op: 'delete', id: 'a1' }));
    expect(res.status).toBe(403);
    expect(fake.adapter.deleteDoc).not.toHaveBeenCalled();
    expect(fake.store.has('a1')).toBe(true);
  });
});
