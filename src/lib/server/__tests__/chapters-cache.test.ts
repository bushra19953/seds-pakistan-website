/**
 * @jest-environment node
 *
 * Perf program (2026-10-30): the chapters-collection cache behind
 * GET /api/v1/chapters and the profile route's chapter leg.
 *
 * Pinned behaviour:
 *  - repeat calls within the TTL share ONE collection read;
 *  - concurrent calls coalesce behind one read;
 *  - a FAILED load propagates and is never cached (the next call
 *    retries), exactly as the uncached reads behaved;
 *  - an EMPTY snapshot is returned but never cached (the forbidden
 *    cached-empty failure mode: a degraded read must not pin an
 *    empty chapters list);
 *  - getActiveChapterDocs applies the isActive === true predicate
 *    and the limit, returning Firestore-doc-shaped objects;
 *  - invalidateChaptersCache forces a fresh read (chapter write
 *    paths rely on it for next-read visibility);
 *  - entries are keyed by db handle.
 */
import {
  getActiveChapterDocs,
  getChaptersSnapshot,
  invalidateChaptersCache,
} from '@/lib/server/chapters-cache';

function countingDb(
  initialDocs: Array<{ id: string; data: Record<string, unknown> }>,
  fail = false,
) {
  const state = { docs: initialDocs, fail, gets: 0 };
  const db = {
    collection: jest.fn(() => ({
      get: jest.fn(async () => {
        state.gets += 1;
        if (state.fail) throw new Error('firestore down');
        return {
          docs: state.docs.map((d) => ({ id: d.id, data: () => d.data })),
        };
      }),
    })),
  } as any;
  return { db, state };
}

const IST = { id: 'seds-ist-chapter', data: { name: 'IST Chapter', isActive: true } };
const LUMS = { id: 'seds-lums-chapter', data: { name: 'LUMS Chapter', isActive: true } };
const OLD = { id: 'seds-old-chapter', data: { name: 'Old Chapter', isActive: false } };
const UNSET = { id: 'seds-unset-chapter', data: { name: 'Unset Chapter' } };

describe('chapters cache', () => {
  it('serves repeat snapshot calls from one read', async () => {
    const { db, state } = countingDb([IST, LUMS]);
    const first = await getChaptersSnapshot(db);
    const second = await getChaptersSnapshot(db);
    expect(first.map((r) => r.id)).toEqual(['seds-ist-chapter', 'seds-lums-chapter']);
    expect(second.map((r) => r.id)).toEqual(['seds-ist-chapter', 'seds-lums-chapter']);
    expect(state.gets).toBe(1);
  });

  it('coalesces concurrent calls behind one read', async () => {
    const { db, state } = countingDb([IST]);
    const [a, b] = await Promise.all([getChaptersSnapshot(db), getChaptersSnapshot(db)]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(state.gets).toBe(1);
  });

  it('propagates a failed load and never caches it', async () => {
    const { db, state } = countingDb([IST], true);
    await expect(getChaptersSnapshot(db)).rejects.toThrow('firestore down');
    state.fail = false;
    const rows = await getChaptersSnapshot(db);
    expect(rows.map((r) => r.id)).toEqual(['seds-ist-chapter']);
    expect(state.gets).toBe(2);
  });

  it('never caches an empty snapshot', async () => {
    const { db, state } = countingDb([]);
    await expect(getChaptersSnapshot(db)).resolves.toEqual([]);
    await expect(getChaptersSnapshot(db)).resolves.toEqual([]);
    expect(state.gets).toBe(2);
    state.docs = [IST];
    const rows = await getChaptersSnapshot(db);
    expect(rows.map((r) => r.id)).toEqual(['seds-ist-chapter']);
    expect(state.gets).toBe(3);
  });

  it('getActiveChapterDocs filters isActive === true and returns doc-shaped rows', async () => {
    const { db, state } = countingDb([IST, OLD, UNSET, LUMS]);
    const docs = await getActiveChapterDocs(db);
    expect(docs.map((d) => d.id)).toEqual(['seds-ist-chapter', 'seds-lums-chapter']);
    expect(docs[0].data()).toEqual({ name: 'IST Chapter', isActive: true });
    expect(state.gets).toBe(1);
  });

  it('getActiveChapterDocs honours the limit', async () => {
    const { db } = countingDb([IST, LUMS]);
    const docs = await getActiveChapterDocs(db, 1);
    expect(docs.map((d) => d.id)).toEqual(['seds-ist-chapter']);
  });

  it('invalidateChaptersCache forces a fresh read', async () => {
    const { db, state } = countingDb([IST]);
    await getChaptersSnapshot(db);
    state.docs = [IST, LUMS];
    const stale = await getChaptersSnapshot(db);
    expect(stale).toHaveLength(1);
    invalidateChaptersCache(db);
    const fresh = await getChaptersSnapshot(db);
    expect(fresh).toHaveLength(2);
    expect(state.gets).toBe(2);
  });

  it('keys entries by db handle: two handles never share data', async () => {
    const a = countingDb([IST]);
    const b = countingDb([LUMS]);
    expect((await getChaptersSnapshot(a.db)).map((r) => r.id)).toEqual(['seds-ist-chapter']);
    expect((await getChaptersSnapshot(b.db)).map((r) => r.id)).toEqual(['seds-lums-chapter']);
    expect(a.state.gets).toBe(1);
    expect(b.state.gets).toBe(1);
  });
});
