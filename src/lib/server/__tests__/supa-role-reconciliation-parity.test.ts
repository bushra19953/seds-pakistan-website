/**
 * @jest-environment node
 *
 * Supabase migration, ROLES cluster G4: reconciliation parity.
 * The SAME fixture set is classified identically flag OFF (served by
 * FakeFirestore) and flag ON (served by a REAL-SHAPED fake Supabase
 * adapter returning flattened docs, with an EMPTY Firestore behind it
 * - so any accidental Firestore fallback changes the report and fails
 * the test). Report mode only: repairs stay on role-writes/Firestore
 * via the G2 chokepoint mirror and are covered by the base suite.
 * Mocks/fakes only, zero live reads.
 */
import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import { reconcileRoles } from '../role-reconciliation';
import {
  __setSupaAdapterForTests,
  type SupaRolesAdapter,
} from '../supa-roles-reconcile-seam';

const NOW = new Date('2026-10-25T00:00:00.000Z');
const CHAPTER = 'seds-ist-chapter';

type DocMap = Record<string, Record<string, Record<string, unknown>>>;

/** One fixture per reconciliation class, plus one clean account. */
function fixtures(): DocMap {
  return {
    roles: {
      'u-clean': { role: 'member', additionalRoles: [], chapterId: CHAPTER },
      'u-stale': { role: 'member', additionalRoles: [], chapterId: CHAPTER },
      'u-conflict': { role: 'chapter_secretary', additionalRoles: [], chapterId: CHAPTER },
      'u-roles-only': { role: 'chapter_secretary', additionalRoles: [], chapterId: CHAPTER },
    },
    users: {
      'u-clean': { role: 'member', displayRole: 'member', additionalRoles: [], chapterId: CHAPTER },
      'u-stale': { role: 'member', displayRole: 'chapter_secretary', additionalRoles: [], chapterId: CHAPTER },
      'u-conflict': { role: 'member', displayRole: 'member', additionalRoles: [], chapterId: CHAPTER },
      'u-users-only': { role: 'chapter_secretary', displayRole: 'chapter_secretary', additionalRoles: [], chapterId: CHAPTER },
      'u-bootstrap': { role: 'member_basic', displayRole: 'member_basic', additionalRoles: [], chapterId: CHAPTER },
    },
    roleHistory: {
      h1: { uid: 'u-ghost', action: 'grant' },
      h2: { uid: 'u-clean', action: 'grant' },
    },
  };
}

function seedFirestore(db: FakeFirestore, docs: DocMap): void {
  for (const [collection, byId] of Object.entries(docs)) {
    for (const [id, data] of Object.entries(byId)) db.seed(collection, id, data);
  }
}

function fakeAdapter(docs: DocMap): SupaRolesAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    useSupa: () => true,
    getDoc: async (collection: string, id: string) => {
      calls.push(`getDoc:${collection}/${id}`);
      const data = docs[collection]?.[id];
      return data ? { id, ...data } : null;
    },
    listDocs: async (collection: string) => {
      calls.push(`listDocs:${collection}`);
      return Object.entries(docs[collection] ?? {}).map(([id, data]) => ({ id, ...data }));
    },
  };
}

afterEach(() => {
  __setSupaAdapterForTests(null);
});

describe('reconcileRoles parity (flag OFF vs flag ON)', () => {
  it('classifies the same fixture set identically from Firestore and from the seam', async () => {
    const docs = fixtures();

    __setSupaAdapterForTests(null);
    const offDb = new FakeFirestore();
    seedFirestore(offDb, docs);
    const offReport = await reconcileRoles(offDb.asDb(), { mode: 'report', now: NOW });

    const adapter = fakeAdapter(docs);
    __setSupaAdapterForTests(adapter);
    const onDb = new FakeFirestore(); // EMPTY: Firestore fallback would change the report
    const onReport = await reconcileRoles(onDb.asDb(), { mode: 'report', now: NOW });

    expect(onReport).toEqual(offReport);
    expect(onReport.counts).toEqual({
      'roles-only': 1,
      'users-only': 1,
      'users-only-bootstrap': 1,
      'conflicting-role': 1,
      'stale-displayRole': 1,
      'claims-divergence': 0,
      'orphan-roleHistory': 1,
    });
    expect(onReport.totalUsers).toBe(5);
    // All three reads came from the seam.
    expect(adapter.calls).toEqual(
      expect.arrayContaining(['listDocs:roles', 'listDocs:users', 'listDocs:roleHistory']),
    );
  });

  it('flag OFF injected adapter is never consulted for data and Firestore serves the report', async () => {
    const docs = fixtures();
    const adapter = fakeAdapter(docs);
    adapter.useSupa = () => false;
    __setSupaAdapterForTests(adapter);
    const db = new FakeFirestore();
    seedFirestore(db, docs);
    const report = await reconcileRoles(db.asDb(), { mode: 'report', now: NOW });
    expect(report.totalUsers).toBe(5);
    expect(adapter.calls).toEqual([]);
  });
});
