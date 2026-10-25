/**
 * getAllProjectsCached x projects seam (cluster I, C-14).
 *
 * The pre-existing suite (projects-cached.test.ts) pins the
 * flag-OFF contract and must pass unchanged. This suite pins the
 * flag-ON behavior added inside the same in-flight fetch:
 *  - flag ON + route rows -> route data, Firestore never read,
 *    cached under the same TTL semantics (one route read for
 *    repeat calls);
 *  - flag ON + route failure (or no token) -> the Firestore read
 *    serves, byte-identical to the flag-OFF path;
 *  - flag OFF -> the route fetchers are never touched.
 */

const mockGetDocs = jest.fn();
const mockCollection = jest.fn((_fs: any, name: string) => ({ __collection: name }));

jest.mock('firebase/firestore', () => ({
  collection: (fs: any, name: string) => mockCollection(fs, name),
  getDocs: (...args: any[]) => mockGetDocs(...args),
}));

const mockClientEnabled = jest.fn();
const mockGetToken = jest.fn();
const mockFetchAdminRows = jest.fn();

jest.mock('../projects-supa', () => ({
  projectsSupaClientEnabled: () => mockClientEnabled(),
  getCurrentUserIdToken: () => mockGetToken(),
  fetchAdminProjectRowsViaRoute: (...args: any[]) => mockFetchAdminRows(...args),
}));

import { getAllProjectsCached, invalidateProjectsCache } from '../projects-cached';

const fakeFirestore: any = { __fs: true };

function snapOf(rows: Array<{ id: string; data: any }>) {
  return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateProjectsCache();
  mockClientEnabled.mockReturnValue(false);
  mockGetToken.mockResolvedValue('tok-123');
  mockFetchAdminRows.mockResolvedValue([
    { id: 's1', data: { title: 'SupaRocket', slug: 'supa-rocket' } },
  ]);
  mockGetDocs.mockResolvedValue(
    snapOf([
      { id: 'p1', data: { title: 'Rocketry', slug: 'rocketry' } },
      { id: 'p2', data: { title: 'CubeSat', slug: 'cubesat' } },
    ]),
  );
});

describe('getAllProjectsCached with the projects seam', () => {
  it('flag OFF: Firestore serves, route fetchers untouched', async () => {
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toEqual([
      { id: 'p1', title: 'Rocketry', slug: 'rocketry' },
      { id: 'p2', title: 'CubeSat', slug: 'cubesat' },
    ]);
    expect(mockFetchAdminRows).not.toHaveBeenCalled();
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
  });

  it('flag ON: route rows serve, Firestore never read, result cached', async () => {
    mockClientEnabled.mockReturnValue(true);
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toEqual([{ id: 's1', title: 'SupaRocket', slug: 'supa-rocket' }]);
    expect(mockFetchAdminRows).toHaveBeenCalledWith('tok-123');
    expect(mockGetDocs).not.toHaveBeenCalled();

    await getAllProjectsCached(fakeFirestore);
    await getAllProjectsCached(fakeFirestore);
    expect(mockFetchAdminRows).toHaveBeenCalledTimes(1);
  });

  it('flag ON + route failure: falls back to the Firestore read', async () => {
    mockClientEnabled.mockReturnValue(true);
    mockFetchAdminRows.mockRejectedValue(new Error('route 503'));
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toEqual([
      { id: 'p1', title: 'Rocketry', slug: 'rocketry' },
      { id: 'p2', title: 'CubeSat', slug: 'cubesat' },
    ]);
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
  });

  it('flag ON + no token: falls back to the Firestore read', async () => {
    mockClientEnabled.mockReturnValue(true);
    mockGetToken.mockResolvedValue(null);
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toHaveLength(2);
    expect(mockFetchAdminRows).not.toHaveBeenCalled();
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
  });

  it('flag ON + route failure + Firestore failure: rejects and caches nothing', async () => {
    mockClientEnabled.mockReturnValue(true);
    mockFetchAdminRows.mockRejectedValue(new Error('route 503'));
    mockGetDocs.mockRejectedValueOnce(new Error('boom'));
    await expect(getAllProjectsCached(fakeFirestore)).rejects.toThrow('boom');
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toHaveLength(2);
  });
});
