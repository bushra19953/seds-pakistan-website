/**
 * @jest-environment node
 *
 * Perf tests for src/lib/supa-seams/profile.ts (profile data-path
 * fix, 2026-10-31; skill: performance / addyosmani web-quality-skills).
 *
 * DEFECT (pre-fix): tryGetUsersByIds and tryGetSkillsByIds resolved
 * their ids with a SEQUENTIAL `for (const id of ids) await
 * adapter.getDoc(...)` loop — one network round trip per id, stacked:
 * up to 10 per MyTeam chunk and up to 30 for a profile's skill list,
 * all inside the profile route's dependent phase. The ids are
 * independent; they must be fetched concurrently, preserving input
 * order and the missing-docs-are-absent contract.
 */

import {
  setAdapterForTests,
  resetAdapterForTests,
  tryGetUsersByIds,
  tryGetSkillsByIds,
  type SupaAdapter,
} from '@/lib/supa-seams/profile';

const tracker = { inFlight: 0, maxInFlight: 0 };

function slowAdapter(): SupaAdapter {
  return {
    getDoc: (async (_coll: string, id: string) => {
      tracker.inFlight++;
      tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
      await new Promise((r) => setTimeout(r, 25));
      tracker.inFlight--;
      if (id === 'missing') return null;
      return { id, displayName: `User ${id}` } as any;
    }) as any,
    listDocs: async () => [],
    countDocs: async () => 0,
    setDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    updateDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    deleteDoc: async () => undefined,
    rpc: async () => { throw new Error('unexpected rpc'); },
    tx: async () => { throw new Error('unexpected tx'); },
  } as unknown as SupaAdapter;
}

beforeEach(() => {
  tracker.inFlight = 0;
  tracker.maxInFlight = 0;
  process.env.SUPA_SURFACES = 'profile,skills';
  setAdapterForTests(slowAdapter());
});
afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetAdapterForTests();
});

describe('profile seam by-ids fetches run concurrently', () => {
  it('tryGetUsersByIds overlaps the per-id getDoc calls and preserves order/absent contract', async () => {
    const res = await tryGetUsersByIds(['a', 'missing', 'b', 'c', 'd']);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.value.docs.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(tracker.maxInFlight).toBeGreaterThan(1);
  });

  it('tryGetSkillsByIds overlaps the per-id getDoc calls', async () => {
    const res = await tryGetSkillsByIds(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.value.docs.map((d) => d.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(tracker.maxInFlight).toBeGreaterThan(1);
  });
});
