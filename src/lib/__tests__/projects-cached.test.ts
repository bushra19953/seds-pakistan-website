/**
 * getAllProjectsCached: the admin tasks page (and future surfaces) must
 * pay the projects collection read once per TTL window per session,
 * not once per page mount (read-burn census P1 / fix F2).
 */

const mockGetDocs = jest.fn();
const mockCollection = jest.fn((_fs: any, name: string) => ({ __collection: name }));

jest.mock('firebase/firestore', () => ({
  collection: (fs: any, name: string) => mockCollection(fs, name),
  getDocs: (...args: any[]) => mockGetDocs(...args),
}));

import { getAllProjectsCached, invalidateProjectsCache } from '../projects-cached';

const fakeFirestore: any = { __fs: true };

function snapOf(rows: Array<{ id: string; data: any }>) {
  return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateProjectsCache();
  mockGetDocs.mockResolvedValue(
    snapOf([
      { id: 'p1', data: { title: 'Rocketry', slug: 'rocketry' } },
      { id: 'p2', data: { title: 'CubeSat', slug: 'cubesat' } },
    ])
  );
});

describe('getAllProjectsCached', () => {
  it('maps docs to { id, ...data }', async () => {
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toEqual([
      { id: 'p1', title: 'Rocketry', slug: 'rocketry' },
      { id: 'p2', title: 'CubeSat', slug: 'cubesat' },
    ]);
    expect(mockCollection).toHaveBeenCalledWith(fakeFirestore, 'projects');
  });

  it('serves repeat calls within the TTL from cache (one collection read)', async () => {
    await getAllProjectsCached(fakeFirestore);
    await getAllProjectsCached(fakeFirestore);
    await getAllProjectsCached(fakeFirestore);
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const [a, b] = await Promise.all([
      getAllProjectsCached(fakeFirestore),
      getAllProjectsCached(fakeFirestore),
    ]);
    expect(a).toBe(b);
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
  });

  it('refetches after explicit invalidation', async () => {
    await getAllProjectsCached(fakeFirestore);
    invalidateProjectsCache();
    await getAllProjectsCached(fakeFirestore);
    expect(mockGetDocs).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed fetch', async () => {
    mockGetDocs.mockRejectedValueOnce(new Error('boom'));
    await expect(getAllProjectsCached(fakeFirestore)).rejects.toThrow('boom');
    const list = await getAllProjectsCached(fakeFirestore);
    expect(list).toHaveLength(2);
    expect(mockGetDocs).toHaveBeenCalledTimes(2);
  });
});
