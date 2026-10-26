/**
 * @jest-environment node
 *
 * Identity cutover step 1 — WRITE primacy contracts for the
 * /api/roles/reads writeDoc path (census R-22, design §2.2). This
 * route is the server half of the three already-switched roles flows
 * (roleDefinitions upsert R-21, role_requests lifecycle R-23..R-25):
 * before the re-key it chose ONE backend by SUPA_SURFACES alone
 * (Supabase-only when ON) — the flag-law violation this step fixes.
 *
 * Truth table pinned for a POST write:
 *   isSupaPrimary('roles')     -> adapter ONLY; the Admin-SDK
 *     Firestore fake records ZERO writes.
 *   SURFACES on, not primary   -> uniform dual-write: Firestore
 *     primary FIRST, then the adapter mirror under the same id; a
 *     mirror failure still answers 200 (best-effort, R-16 posture).
 *   SURFACES off               -> Firestore only, adapter untouched.
 *   body mirror:true           -> adapter ONLY in every state (the
 *     caller already committed Firestore as its primary; this is its
 *     mirror leg) — and 500 when no adapter is available.
 * Reads (GET) are NOT exercised here: §2.4 pins them unchanged.
 *
 * Zero live I/O: firebase-admin, auth, permissions and '@/lib/supa'
 * are all mocked at the module boundary.
 */

import { NextRequest } from 'next/server';

// ------------------------------------------------------------ Firestore fake
const mockOrder: string[] = [];
const mockFsSets: Array<{ collection: string; id: string; data: unknown; opts: unknown }> = [];
const mockFsUpdates: Array<{ collection: string; id: string; data: unknown }> = [];

function fakeRef(collection: string, id: string) {
  return {
    id,
    set: jest.fn(async (data: unknown, opts: unknown) => {
      mockOrder.push('firestore');
      mockFsSets.push({ collection, id, data, opts });
    }),
    update: jest.fn(async (data: unknown) => {
      mockOrder.push('firestore');
      mockFsUpdates.push({ collection, id, data });
    }),
  };
}

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'manager-1' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

// ------------------------------------------------------------ Supa fake
const mockUseSupa = jest.fn((_surface: string) => true);
const mockIsSupaPrimary = jest.fn((_surface: string) => false);
const mockGetSupaClient = jest.fn((): unknown => ({}));
const mockAdapterSetDoc = jest.fn(async (..._args: any[]) => {
  mockOrder.push('adapter');
  return undefined;
});
const mockAdapterUpdateDoc = jest.fn(async (..._args: any[]) => {
  mockOrder.push('adapter');
  return undefined;
});
jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => mockUseSupa(surface),
  getSupaClient: () => mockGetSupaClient(),
  getSupaAdapter: () => ({
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    setDoc: (collection: string, id: string, data: Record<string, unknown>, opts?: unknown) =>
      mockAdapterSetDoc(collection, id, data, opts),
    updateDoc: (collection: string, id: string, data: Record<string, unknown>) =>
      mockAdapterUpdateDoc(collection, id, data),
  }),
  isSupaPrimary: (surface: string) => mockIsSupaPrimary(surface),
}));

import { POST } from '../route';

function makeDb() {
  return {
    collection: (name: string) => ({
      doc: (id?: string) => fakeRef(name, id ?? 'fs-minted-id'),
    }),
  };
}

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/roles/reads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DEF_WRITE = {
  op: 'set',
  collection: 'roleDefinitions',
  id: 'custom_star',
  merge: true,
  data: { slug: 'custom_star', name: 'custom_star', description: 'Star role' },
};

beforeEach(() => {
  mockOrder.length = 0;
  mockFsSets.length = 0;
  mockFsUpdates.length = 0;
  mockDbHolder.db = makeDb();
  jest.clearAllMocks();
  // clearAllMocks drops the jest.fn defaults above; restore them.
  mockUseSupa.mockImplementation(() => true);
  mockIsSupaPrimary.mockImplementation(() => false);
  mockGetSupaClient.mockImplementation(() => ({}));
  mockAdapterSetDoc.mockImplementation(async () => {
    mockOrder.push('adapter');
    return undefined;
  });
  mockAdapterUpdateDoc.mockImplementation(async () => {
    mockOrder.push('adapter');
    return undefined;
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('writeDoc primacy re-key (R-22)', () => {
  it('primary: adapter-only set, ZERO Firestore writes', async () => {
    mockIsSupaPrimary.mockImplementation(() => true);
    const res = await POST(postReq(DEF_WRITE));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, id: 'custom_star' });
    expect(mockAdapterSetDoc).toHaveBeenCalledTimes(1);
    expect(mockAdapterSetDoc).toHaveBeenCalledWith(
      'roleDefinitions',
      'custom_star',
      DEF_WRITE.data,
      { merge: true },
    );
    expect(mockFsSets).toHaveLength(0);
    expect(mockFsUpdates).toHaveLength(0);
    expect(mockOrder).toEqual(['adapter']);
  });

  it('primary: adapter-only update for the role_requests lifecycle', async () => {
    mockIsSupaPrimary.mockImplementation(() => true);
    const res = await POST(
      postReq({
        op: 'update',
        collection: 'role_requests',
        id: 'req-1',
        data: { status: 'approved', handledBy: 'manager-1' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockAdapterUpdateDoc).toHaveBeenCalledTimes(1);
    expect(mockAdapterUpdateDoc).toHaveBeenCalledWith('role_requests', 'req-1', {
      status: 'approved',
      handledBy: 'manager-1',
    });
    expect(mockFsSets).toHaveLength(0);
    expect(mockFsUpdates).toHaveLength(0);
  });

  it('non-primary (SURFACES only): Firestore primary FIRST, adapter mirror second, same id', async () => {
    const res = await POST(postReq(DEF_WRITE));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, id: 'custom_star' });
    expect(mockFsSets).toHaveLength(1);
    expect(mockFsSets[0]).toMatchObject({ collection: 'roleDefinitions', id: 'custom_star' });
    expect(mockAdapterSetDoc).toHaveBeenCalledTimes(1);
    expect(mockAdapterSetDoc).toHaveBeenCalledWith(
      'roleDefinitions',
      'custom_star',
      DEF_WRITE.data,
      { merge: true },
    );
    expect(mockOrder).toEqual(['firestore', 'adapter']);
  });

  it('non-primary create (id null): both stores land under the Firestore-minted id', async () => {
    const res = await POST(
      postReq({
        op: 'set',
        collection: 'role_requests',
        id: null,
        data: { requesterUid: 'manager-1', requestedRole: 'team_lead', status: 'pending' },
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, id: 'fs-minted-id' });
    expect(mockFsSets).toHaveLength(1);
    expect(mockFsSets[0].id).toBe('fs-minted-id');
    expect(mockAdapterSetDoc).toHaveBeenCalledWith(
      'role_requests',
      'fs-minted-id',
      expect.objectContaining({ status: 'pending' }),
      { merge: false },
    );
  });

  it('non-primary + mirror failure: still 200, Firestore primary stands (best-effort mirror)', async () => {
    mockAdapterSetDoc.mockImplementation(async () => {
      mockOrder.push('adapter');
      throw new Error('supabase down');
    });
    const res = await POST(postReq(DEF_WRITE));
    expect(res.status).toBe(200);
    expect(mockFsSets).toHaveLength(1);
    expect(mockOrder).toEqual(['firestore', 'adapter']);
  });

  it('SURFACES off: Firestore only, adapter never called', async () => {
    mockUseSupa.mockImplementation(() => false);
    const res = await POST(postReq(DEF_WRITE));
    expect(res.status).toBe(200);
    expect(mockFsSets).toHaveLength(1);
    expect(mockAdapterSetDoc).not.toHaveBeenCalled();
    expect(mockAdapterUpdateDoc).not.toHaveBeenCalled();
    expect(mockOrder).toEqual(['firestore']);
  });

  it('mirror:true: adapter-only even when NOT primary (caller already committed Firestore)', async () => {
    const res = await POST(postReq({ ...DEF_WRITE, mirror: true }));
    expect(res.status).toBe(200);
    expect(mockAdapterSetDoc).toHaveBeenCalledTimes(1);
    expect(mockFsSets).toHaveLength(0);
    expect(mockFsUpdates).toHaveLength(0);
    expect(mockOrder).toEqual(['adapter']);
  });

  it('mirror:true + no adapter available: 500 and ZERO Firestore writes', async () => {
    mockUseSupa.mockImplementation(() => false);
    const res = await POST(postReq({ ...DEF_WRITE, mirror: true }));
    expect(res.status).toBe(500);
    expect(mockFsSets).toHaveLength(0);
    expect(mockAdapterSetDoc).not.toHaveBeenCalled();
  });
});
