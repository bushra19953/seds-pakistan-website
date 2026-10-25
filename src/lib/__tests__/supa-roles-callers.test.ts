/**
 * Caller-level seam tests (file-group 3): the migrated libraries must
 * (a) make ZERO seam network calls with the flag OFF and use Firestore
 * exactly as before, and (b) with the flag ON, serve reads from the
 * seam route with byte-identical result shapes, falling back to
 * Firestore when the route fails.
 *
 * Firestore is mocked at the firebase/firestore module boundary (the
 * same seam the pre-existing role-management tests use); fetch is
 * stubbed. Zero live reads.
 */

jest.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: { getIdToken: async () => 'test-token' } }),
}));

const mockGetDoc = jest.fn();
const mockGetDocs = jest.fn();
jest.mock('firebase/firestore', () => ({
  doc: (_fs: unknown, collection: string, id?: string) => ({ _col: collection, _id: id }),
  collection: (_fs: unknown, name: string) => ({ _col: name }),
  query: (ref: unknown, ...rest: unknown[]) => ({ ref, rest }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  orderBy: (field: string, dir: string) => ({ field, dir }),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  serverTimestamp: () => ({ _serverTimestamp: true }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: jest.fn(async () => undefined),
  updateDoc: jest.fn(async () => undefined),
}));

jest.mock('../audit-logging', () => ({
  logAuditEntry: jest.fn(async () => undefined),
}));

import { getAllRoleDefinitionsCached, invalidateRoleDefinitionsCache } from '../role-definitions';
import { getRoleRequest, getPendingRoleRequests } from '../role-request';

const ENV_KEY = 'NEXT_PUBLIC_SUPA_SURFACES';
const fakeFirestore = {} as never;
let savedEnv: string | undefined;

function stubFetch(status: number, payload: unknown): jest.Mock {
  const m = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }));
  (globalThis as { fetch?: unknown }).fetch = m;
  return m;
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  invalidateRoleDefinitionsCache();
  jest.clearAllMocks();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('flag OFF: Firestore path, zero seam calls', () => {
  it('getAllRoleDefinitionsCached uses getDocs and never fetches', async () => {
    const fetchMock = stubFetch(200, { docs: [] });
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 'member',
          data: () => ({ slug: 'member', description: 'Member role', permissions: ['x'] }),
        },
      ],
    });
    const defs = await getAllRoleDefinitionsCached(fakeFirestore);
    expect(defs).toHaveLength(1);
    expect(defs[0].role).toBe('member');
    expect(defs[0].permissions).toEqual(['x']);
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getRoleRequest uses getDoc and converts the Timestamp via toDate()', async () => {
    const fetchMock = stubFetch(200, { doc: null });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      id: 'r1',
      data: () => ({
        requesterUid: 'u1',
        requestedRole: 'team_lead',
        status: 'pending',
        createdAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
      }),
    });
    const req = await getRoleRequest(fakeFirestore, 'r1');
    expect(req?.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flag ON: seam path with identical shapes', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'roles';
  });

  it('getAllRoleDefinitionsCached serves the registry from the route', async () => {
    stubFetch(200, {
      docs: [
        {
          id: 'custom_star',
          exists: true,
          data: {
            slug: 'custom_star',
            name: 'Star',
            isCustom: true,
            parentRoleKey: 'member',
            chapterId: 'seds-ist-chapter',
            permissions: ['canViewTasks'],
          },
        },
      ],
    });
    const defs = await getAllRoleDefinitionsCached(fakeFirestore);
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(defs[0]).toMatchObject({
      role: 'custom_star',
      name: 'Star',
      isCustom: true,
      permissions: ['canViewTasks'],
    });
  });

  it('getPendingRoleRequests maps seam docs, ISO createdAt -> Date', async () => {
    stubFetch(200, {
      docs: [
        {
          id: 'r9',
          exists: true,
          data: {
            requesterUid: 'u9',
            requestedRole: 'team_lead',
            status: 'pending',
            createdAt: '2026-02-02T00:00:00.000Z',
          },
        },
      ],
    });
    const reqs = await getPendingRoleRequests(fakeFirestore);
    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].createdAt.toISOString()).toBe('2026-02-02T00:00:00.000Z');
  });

  it('route failure falls back to Firestore (getDoc) transparently', async () => {
    stubFetch(500, { error: 'boom' });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      id: 'r1',
      data: () => ({
        requesterUid: 'u1',
        requestedRole: 'member',
        status: 'approved',
        createdAt: { toDate: () => new Date('2026-03-03T00:00:00.000Z') },
      }),
    });
    const req = await getRoleRequest(fakeFirestore, 'r1');
    expect(mockGetDoc).toHaveBeenCalledTimes(1);
    expect(req?.status).toBe('approved');
  });
});
