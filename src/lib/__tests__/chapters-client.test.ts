/**
 * @jest-environment node
 *
 * Unit tests for the shared chapters cached reader (read-bleed fix
 * U2/R2, src/lib/chapters-client.ts). firebase/firestore is mocked:
 * the fake getDocs counts its calls, so the cache contract (one read
 * per 5-minute window, shared across callers, retry after failure)
 * is verified with zero live Firestore reads.
 */

const state = {
  getDocsCalls: 0,
  docs: [] as Array<{ id: string; data: Record<string, any> }>,
  failNext: false,
};

jest.mock('firebase/firestore', () => ({
  collection: (_firestore: unknown, name: string) => ({ __collection: name }),
  getDocs: async (_ref: unknown) => {
    state.getDocsCalls += 1;
    if (state.failNext) {
      state.failNext = false;
      throw new Error('fake getDocs failure');
    }
    return {
      docs: state.docs.map((d) => ({ id: d.id, data: () => d.data })),
    };
  },
}));

import { getChaptersCached, invalidateChaptersCache } from '../chapters-client';

const fakeFirestore = {} as any;

beforeEach(() => {
  invalidateChaptersCache();
  state.getDocsCalls = 0;
  state.failNext = false;
  state.docs = [
    { id: 'seds-ist', data: { name: 'SEDS IST' } },
    { id: 'seds-nust', data: {} },
  ];
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('getChaptersCached', () => {
  it('maps docs to { id, name } with the id as the name fallback, in read order', async () => {
    const list = await getChaptersCached(fakeFirestore);
    expect(list).toEqual([
      { id: 'seds-ist', name: 'SEDS IST' },
      { id: 'seds-nust', name: 'seds-nust' },
    ]);
    expect(state.getDocsCalls).toBe(1);
  });

  it('shares ONE read across concurrent and repeat callers inside the TTL', async () => {
    const [a, b] = await Promise.all([
      getChaptersCached(fakeFirestore),
      getChaptersCached(fakeFirestore),
    ]);
    const c = await getChaptersCached(fakeFirestore);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(state.getDocsCalls).toBe(1);
  });

  it('re-reads after invalidation', async () => {
    await getChaptersCached(fakeFirestore);
    invalidateChaptersCache();
    await getChaptersCached(fakeFirestore);
    expect(state.getDocsCalls).toBe(2);
  });

  it('re-reads after the TTL expires', async () => {
    await getChaptersCached(fakeFirestore);
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 5 * 60 * 1000 + 1);
    try {
      await getChaptersCached(fakeFirestore);
    } finally {
      (Date.now as jest.Mock).mockRestore?.();
    }
    expect(state.getDocsCalls).toBe(2);
  });

  it('clears the cache on failure so a later caller can retry', async () => {
    state.failNext = true;
    await expect(getChaptersCached(fakeFirestore)).rejects.toThrow('fake getDocs failure');
    const list = await getChaptersCached(fakeFirestore);
    expect(list).toHaveLength(2);
    expect(state.getDocsCalls).toBe(2);
  });
});
