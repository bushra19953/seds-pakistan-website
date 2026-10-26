/**
 * Identity cutover step 1 — WRITE primacy contracts for the three
 * already-switched roles flows (design §2.2, census R-21..R-25):
 *   - upsertRoleDefinition        (src/lib/role-definitions.ts)
 *   - createRoleRequest           (src/lib/role-request.ts, R-23)
 *   - approve/rejectRoleRequest   (src/lib/role-request.ts, R-24/R-25)
 * (The server half of all three, the /api/roles/reads writeDoc path
 * R-22, is pinned in
 * src/app/api/roles/reads/__tests__/roles-reads-write-primacy.test.ts.)
 *
 * Truth table pinned per flow, keyed on the client flag twins
 * (NEXT_PUBLIC_SUPA_SURFACES / NEXT_PUBLIC_SUPA_PRIMARY, the client
 * twin of isSupaPrimary('roles')):
 *   primary (token in BOTH)  -> seam (adapter) write ONLY; the
 *     Firestore wrapper is NEVER called; a seam failure is loud
 *     (throw / false), never a silent Firestore fallback.
 *   surfaces ON, not primary -> uniform dual-write: Firestore primary
 *     FIRST (payload byte-identical to the pre-seam write, native
 *     serverTimestamp sentinels), THEN a best-effort mirror POST
 *     (body mirror:true) whose failure never fails the operation.
 *   flag OFF                 -> Firestore only, zero fetch calls,
 *     exactly the pre-migration behaviour.
 *
 * Firestore is mocked at the firebase/firestore + wrapper module
 * boundaries; fetch is stubbed. Zero live reads or writes.
 */

jest.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: { getIdToken: async () => 'test-token' } }),
}));

const mockGetDoc = jest.fn(async (..._args: any[]) => undefined as any);
jest.mock('firebase/firestore', () => ({
  doc: (...args: unknown[]) => {
    if (args.length === 1) {
      // doc(collectionRef) — the createRoleRequest id-minting shape.
      const collRef = args[0] as { _col: string };
      return { _col: collRef._col, _id: 'fs-minted-id', id: 'fs-minted-id' };
    }
    return { _col: args[1], _id: args[2], id: args[2] };
  },
  collection: (_fs: unknown, name: string) => ({ _col: name }),
  query: (ref: unknown, ...rest: unknown[]) => ({ ref, rest }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  orderBy: (field: string, dir: string) => ({ field, dir }),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocs: jest.fn(async () => ({ docs: [] })),
  serverTimestamp: () => ({ _serverTimestamp: true }),
}));

const mockWrapperSetDoc = jest.fn(async (..._args: any[]) => undefined);
const mockWrapperUpdateDoc = jest.fn(async (..._args: any[]) => undefined);
jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: (...args: unknown[]) => mockWrapperSetDoc(...args),
  updateDoc: (...args: unknown[]) => mockWrapperUpdateDoc(...args),
}));

const mockLogAuditEntry = jest.fn(async (..._args: any[]) => undefined);
jest.mock('../audit-logging', () => ({
  logAuditEntry: (...args: unknown[]) => mockLogAuditEntry(...args),
}));

import { upsertRoleDefinition } from '../role-definitions';
import { createRoleRequest, approveRoleRequest, rejectRoleRequest } from '../role-request';

const SURFACES_KEY = 'NEXT_PUBLIC_SUPA_SURFACES';
const PRIMARY_KEY = 'NEXT_PUBLIC_SUPA_PRIMARY';
const fakeFirestore = {} as never;

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, any>;
}
let fetchCalls: FetchCall[] = [];
let postStatus = 200;

const SEAM_DOC = {
  id: 'req-1',
  exists: true,
  data: {
    requesterUid: 'u1',
    requestedRole: 'team_lead',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: 'orig-notes',
  },
};

function installFetch() {
  fetchCalls = [];
  const m = jest.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, any>) : undefined;
    fetchCalls.push({ url: String(url), method, body });
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ doc: SEAM_DOC }) };
    }
    return {
      ok: postStatus >= 200 && postStatus < 300,
      status: postStatus,
      json: async () => ({ ok: postStatus < 300, id: body?.id ?? 'seam-minted-id' }),
    };
  });
  (globalThis as { fetch?: unknown }).fetch = m;
  return m;
}

function postCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.method === 'POST');
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = { [SURFACES_KEY]: process.env[SURFACES_KEY], [PRIMARY_KEY]: process.env[PRIMARY_KEY] };
  delete process.env[SURFACES_KEY];
  delete process.env[PRIMARY_KEY];
  postStatus = 200;
  jest.clearAllMocks();
  installFetch();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of [SURFACES_KEY, PRIMARY_KEY]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

function setPrimary() {
  process.env[SURFACES_KEY] = 'roles';
  process.env[PRIMARY_KEY] = 'roles';
}
function setDualWrite() {
  process.env[SURFACES_KEY] = 'roles';
  // SUPA_PRIMARY twin unset: surfaces-only == dual-write (flag law).
}

// ---------------------------------------------------------------------
// upsertRoleDefinition (R-21)
// ---------------------------------------------------------------------

describe('upsertRoleDefinition — primacy re-key', () => {
  it('primary: seam-only write, ZERO Firestore writes', async () => {
    setPrimary();
    await upsertRoleDefinition(fakeFirestore, 'custom_star', 'Star role');
    expect(mockWrapperSetDoc).not.toHaveBeenCalled();
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      op: 'set',
      collection: 'roleDefinitions',
      id: 'custom_star',
      merge: true,
    });
    expect(posts[0].body?.mirror).toBeUndefined();
    expect(typeof posts[0].body?.data?.createdAt).toBe('string');
  });

  it('non-primary (SURFACES only): Firestore primary first, then best-effort mirror', async () => {
    setDualWrite();
    await upsertRoleDefinition(fakeFirestore, 'custom_star', 'Star role');
    expect(mockWrapperSetDoc).toHaveBeenCalledTimes(1);
    const [ref, data, opts] = mockWrapperSetDoc.mock.calls[0];
    expect(ref._id).toBe('custom_star');
    // Firestore payload byte-identical to the pre-seam write.
    expect(data).toEqual({
      slug: 'custom_star',
      name: 'custom_star',
      description: 'Star role',
      updatedAt: { _serverTimestamp: true },
      createdAt: { _serverTimestamp: true },
    });
    expect(opts).toEqual({ merge: true });
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      op: 'set',
      collection: 'roleDefinitions',
      id: 'custom_star',
      mirror: true,
    });
    // Firestore strictly before the mirror attempt.
    expect(mockWrapperSetDoc.mock.invocationCallOrder[0]).toBeLessThan(
      (globalThis.fetch as unknown as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('flag OFF: Firestore only, zero fetch (pre-migration behaviour)', async () => {
    await upsertRoleDefinition(fakeFirestore, 'custom_star', 'Star role');
    expect(mockWrapperSetDoc).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });

  it('primary + seam failure: throws, still ZERO Firestore writes', async () => {
    setPrimary();
    postStatus = 500;
    await expect(upsertRoleDefinition(fakeFirestore, 'custom_star', 'Star role')).rejects.toThrow(
      /Supabase-primary/,
    );
    expect(mockWrapperSetDoc).not.toHaveBeenCalled();
  });

  it('non-primary + mirror failure: upsert still succeeds (mirror is best-effort)', async () => {
    setDualWrite();
    postStatus = 500;
    await expect(upsertRoleDefinition(fakeFirestore, 'custom_star', 'Star role')).resolves.toBeUndefined();
    expect(mockWrapperSetDoc).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------
// createRoleRequest (R-23)
// ---------------------------------------------------------------------

describe('createRoleRequest — primacy re-key', () => {
  it('primary: seam-only create, route-minted id, ZERO Firestore writes', async () => {
    setPrimary();
    const id = await createRoleRequest(fakeFirestore, 'u1', 'team_lead' as never, 'please');
    expect(id).toBe('seam-minted-id');
    expect(mockWrapperSetDoc).not.toHaveBeenCalled();
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ op: 'set', collection: 'role_requests', id: null });
    expect(posts[0].body?.mirror).toBeUndefined();
    expect(mockLogAuditEntry).toHaveBeenCalledWith(
      fakeFirestore,
      'create_role_request',
      'u1',
      'seam-minted-id',
      expect.anything(),
    );
  });

  it('non-primary: Firestore create first (pre-seam payload), mirror under the SAME id', async () => {
    setDualWrite();
    const id = await createRoleRequest(fakeFirestore, 'u1', 'team_lead' as never, 'please');
    expect(id).toBe('fs-minted-id');
    expect(mockWrapperSetDoc).toHaveBeenCalledTimes(1);
    const [, data] = mockWrapperSetDoc.mock.calls[0];
    expect(data).toEqual({
      requesterUid: 'u1',
      requestedRole: 'team_lead',
      status: 'pending',
      createdAt: { _serverTimestamp: true },
      notes: 'please',
    });
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      op: 'set',
      collection: 'role_requests',
      id: 'fs-minted-id',
      mirror: true,
    });
    expect(posts[0].body?.data).toMatchObject({ requesterUid: 'u1', status: 'pending' });
    expect(typeof posts[0].body?.data?.createdAt).toBe('string');
    expect(mockLogAuditEntry).toHaveBeenCalledWith(
      fakeFirestore,
      'create_role_request',
      'u1',
      'fs-minted-id',
      expect.anything(),
    );
  });

  it('flag OFF: Firestore only, zero fetch', async () => {
    const id = await createRoleRequest(fakeFirestore, 'u1', 'team_lead' as never);
    expect(id).toBe('fs-minted-id');
    expect(mockWrapperSetDoc).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });

  it('primary + seam failure: throws, ZERO Firestore writes', async () => {
    setPrimary();
    postStatus = 500;
    await expect(createRoleRequest(fakeFirestore, 'u1', 'team_lead' as never)).rejects.toThrow(
      'Failed to create role request',
    );
    expect(mockWrapperSetDoc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// approveRoleRequest / rejectRoleRequest (R-24 / R-25)
// ---------------------------------------------------------------------

describe('approveRoleRequest — primacy re-key', () => {
  it('primary: seam update only, ZERO Firestore writes', async () => {
    setPrimary();
    await expect(approveRoleRequest(fakeFirestore, 'req-1', 'manager-1')).resolves.toBe(true);
    expect(mockWrapperUpdateDoc).not.toHaveBeenCalled();
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ op: 'update', collection: 'role_requests', id: 'req-1' });
    expect(posts[0].body?.mirror).toBeUndefined();
    expect(posts[0].body?.data).toMatchObject({ status: 'approved', handledBy: 'manager-1' });
    expect(typeof posts[0].body?.data?.handledAt).toBe('string');
  });

  it('non-primary: Firestore update first (pre-seam payload), then mirror update', async () => {
    setDualWrite();
    await expect(approveRoleRequest(fakeFirestore, 'req-1', 'manager-1')).resolves.toBe(true);
    expect(mockWrapperUpdateDoc).toHaveBeenCalledTimes(1);
    const [, data] = mockWrapperUpdateDoc.mock.calls[0];
    expect(data).toEqual({
      status: 'approved',
      handledBy: 'manager-1',
      handledAt: { _serverTimestamp: true },
      notes: 'orig-notes',
    });
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      op: 'update',
      collection: 'role_requests',
      id: 'req-1',
      mirror: true,
    });
    expect(posts[0].body?.data).toMatchObject({ status: 'approved', notes: 'orig-notes' });
  });

  it('flag OFF: Firestore only (doc read + update), zero fetch', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      id: 'req-1',
      data: () => ({
        requesterUid: 'u1',
        requestedRole: 'team_lead',
        status: 'pending',
        createdAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
        notes: 'orig-notes',
      }),
    });
    await expect(approveRoleRequest(fakeFirestore, 'req-1', 'manager-1')).resolves.toBe(true);
    expect(mockWrapperUpdateDoc).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });

  it('primary + seam failure: returns false, ZERO Firestore writes', async () => {
    setPrimary();
    postStatus = 500;
    await expect(approveRoleRequest(fakeFirestore, 'req-1', 'manager-1')).resolves.toBe(false);
    expect(mockWrapperUpdateDoc).not.toHaveBeenCalled();
  });
});

describe('rejectRoleRequest — primacy re-key', () => {
  it('primary: seam update only, ZERO Firestore writes', async () => {
    setPrimary();
    await expect(rejectRoleRequest(fakeFirestore, 'req-1', 'manager-1')).resolves.toBe(true);
    expect(mockWrapperUpdateDoc).not.toHaveBeenCalled();
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body?.data).toMatchObject({ status: 'rejected' });
    expect(posts[0].body?.mirror).toBeUndefined();
  });

  it('non-primary: Firestore update first, then mirror update', async () => {
    setDualWrite();
    await expect(rejectRoleRequest(fakeFirestore, 'req-1', 'manager-1')).resolves.toBe(true);
    expect(mockWrapperUpdateDoc).toHaveBeenCalledTimes(1);
    const [, data] = mockWrapperUpdateDoc.mock.calls[0];
    expect(data).toMatchObject({ status: 'rejected', handledAt: { _serverTimestamp: true } });
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ op: 'update', id: 'req-1', mirror: true });
    expect(posts[0].body?.data).toMatchObject({ status: 'rejected' });
  });
});
