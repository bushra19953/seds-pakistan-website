/**
 * @jest-environment node
 *
 * Read-bleed hardening (validation-queue outage, 2026-10-29): the
 * validator chain walk must resolve through the Supabase seam when it
 * is live, so the review queue keeps rendering during a Firestore
 * read outage. Before the fix, getValidatorChain read
 * reporting_relationships and users only via Firestore; under
 * RESOURCE_EXHAUSTED every walk came back partial-empty and
 * canValidateTask discarded queue items whose only door was the chain
 * (or fell through to a permission arm whose own reads were also
 * Firestore-bound at the time).
 *
 * These tests pin: (1) with the seam live and Firestore throwing
 * quota errors, the walk resolves direct and legacy links and
 * canValidateTask grants via the chain; (2) with the seam absent and
 * Firestore throwing, the walk still returns partial (fail-closed,
 * byte-identical to the pre-fix behaviour — never a fabricated grant).
 */
const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { canValidateTask, getValidatorChain } from '../hierarchy';
import { __setSupaLoaderForTests } from '@/lib/supa/seam-tasks-lists';

function quotaError(): Error & { code: number } {
  const e = new Error('RESOURCE_EXHAUSTED: quota exceeded') as Error & { code: number };
  e.code = 8;
  return e;
}

/** A db whose every read throws RESOURCE_EXHAUSTED, counting calls. */
function makeDeadDb() {
  const calls = { count: 0 };
  const boom = async () => {
    calls.count++;
    throw quotaError();
  };
  const db = {
    collection: () => ({
      where: () => ({ get: boom }),
      doc: () => ({ get: boom }),
      get: boom,
    }),
  };
  return { db, calls };
}

function installSeam() {
  // SupaDoc shape: { id, ...fields } — the seam strips `id` and treats
  // the remaining fields as the document data (toDocSnap).
  const users: Record<string, any> = {
    'sub-1': { displayName: 'Submitter One' },
    'mgr-1': { displayName: 'Manager One' },
    'sub-2': { displayName: 'Submitter Two', managerId: 'mgr-9' },
    'mgr-9': { displayName: 'Legacy Manager' },
  };
  const adapter = {
    getDoc: jest.fn(async (collectionPath: string, id: string) => {
      if (collectionPath === 'users' && users[id]) return { id, ...users[id] };
      return null;
    }),
    listDocs: jest.fn(async (collectionPath: string, opts: any) => {
      if (collectionPath !== 'reporting_relationships') return [];
      const sub = opts?.where?.find((w: any) => w[0] === 'subordinateId')?.[2];
      if (sub === 'sub-1') {
        return [{ id: 'rel-1', subordinateId: 'sub-1', managerId: 'mgr-1', type: 'direct' }];
      }
      return [];
    }),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({ id: 'x' }) as any),
    updateDoc: jest.fn(async () => ({ id: 'x' }) as any),
    deleteDoc: jest.fn(async () => undefined),
  };
  __setSupaLoaderForTests(async () => ({
    useSupa: () => true,
    getSupaAdapter: () => adapter as any,
  }));
  return adapter;
}

afterEach(() => {
  __setSupaLoaderForTests(null);
  jest.restoreAllMocks();
});

describe('chain walk seam routing', () => {
  it('resolves a direct link from the seam while Firestore is quota-dead', async () => {
    const { db, calls } = makeDeadDb();
    mockDbHolder.db = db;
    installSeam();

    const result = await getValidatorChain('sub-1');
    expect(result.partial).toBeFalsy();
    expect(result.chain).toEqual([
      { uid: 'mgr-1', depth: 1, type: 'direct', userExists: true },
    ]);
    expect(calls.count).toBe(0);

    const check = await canValidateTask('mgr-1', 'member', {
      submittedBy: 'sub-1',
      assigneeId: 'sub-1',
      assignerId: 'someone-else',
    } as any);
    expect(check.allowed).toBe(true);
    expect(check.via).toBe('chain');
    expect(check.depth).toBe(1);
  });

  it('resolves the legacy managerId fallback from the seam', async () => {
    const { db } = makeDeadDb();
    mockDbHolder.db = db;
    installSeam();

    const result = await getValidatorChain('sub-2');
    expect(result.partial).toBeFalsy();
    expect(result.chain).toEqual([
      { uid: 'mgr-9', depth: 1, type: 'legacy', userExists: true },
    ]);
  });

  it('seam absent + Firestore dead: partial walk, no fabricated grant', async () => {
    const { db } = makeDeadDb();
    mockDbHolder.db = db;
    __setSupaLoaderForTests(async () => ({
      useSupa: () => false,
      getSupaAdapter: () => null as any,
    }));

    const result = await getValidatorChain('sub-1');
    expect(result.partial).toBe(true);
    expect(result.chain).toEqual([]);
  });
});
