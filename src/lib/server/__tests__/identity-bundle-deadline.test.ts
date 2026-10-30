/**
 * @jest-environment node
 *
 * Identity bundle load under a HUNG Firestore (perf program,
 * 2026-10-30). The identity bundle (roles/{uid} + users/{uid}) is
 * loaded on every authenticated request through permissions.ts. When
 * the Supabase seam cannot answer and the Firestore fallback get
 * hangs, the pre-fix loader waited out the GAPIC retry budget
 * (60 s per RPC, 600 s total) — on the single free-tier instance,
 * a handful of cold identity loads during a Firestore degradation
 * is enough to queue the whole site into 502s (proven live
 * 2026-10-30).
 *
 * Pinned here: with the app-level deadline, the fallback get rejects
 * with ReadDeadlineError in FIRESTORE_DOC_DEADLINE_MS — the SAME
 * propagation the identity cache already gives a thrown Firestore
 * error (errors are never cached; callers keep their error
 * semantics). Nothing about the success path changes.
 */

const mockSupaGetDoc = jest.fn();
const mockSupaEnabledFor = jest.fn();

jest.mock('@/lib/server/supa-roles-seam', () => ({
  supaGetDoc: (...args: any[]) => mockSupaGetDoc(...args),
  supaEnabledFor: (...args: any[]) => mockSupaEnabledFor(...args),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({}),
  admin: { firestore: { Timestamp: class {} } },
}));

import {
  __resetLastGoodIdentityHalvesForTests,
  getIdentityBundleCached,
} from '../permissions';
import { bustIdentity } from '../identity-cache';
import {
  FIRESTORE_DOC_DEADLINE_MS,
  ReadDeadlineError,
} from '../read-deadline';

const UID = 'uid-hung-1';

function hangingDb(): any {
  return {
    collection: () => ({
      doc: () => ({
        get: () => new Promise<never>(() => undefined),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetLastGoodIdentityHalvesForTests();
  bustIdentity(UID);
  // Seam cannot answer (null) and is NOT enabled, so the loader takes
  // the plain Firestore fallback — the path this test deadlines.
  mockSupaGetDoc.mockResolvedValue(null);
  mockSupaEnabledFor.mockReturnValue(false);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('identity bundle Firestore fallback deadline', () => {
  it('a hung roles/users get rejects with ReadDeadlineError at the deadline', async () => {
    let outcome: unknown = 'pending';
    const p = getIdentityBundleCached(hangingDb(), UID).then(
      () => {
        outcome = 'resolved';
      },
      (err) => {
        outcome = err;
      },
    );
    await jest.advanceTimersByTimeAsync(FIRESTORE_DOC_DEADLINE_MS + 1);
    await p;
    expect(outcome).toBeInstanceOf(ReadDeadlineError);
    expect((outcome as ReadDeadlineError).label).toContain('identity');
  });
});
