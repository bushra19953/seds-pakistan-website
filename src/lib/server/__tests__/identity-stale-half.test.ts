/**
 * @jest-environment node
 *
 * Read-bleed train 2 (census 23 B1): the identity bundle loader in
 * permissions.ts. On a transient Supabase failure (seam returns null
 * on a Supabase-primary surface) the loader used to fall straight
 * back to 2 Firestore gets per cold load — across every
 * authenticated route, that is what turns a Supabase blip into a
 * Firestore quota bleed. The choice implemented here: serve the
 * last-good identity half from a short-TTL (60s) in-process cache,
 * ZERO Firestore reads; only with no fresh last-good half does the
 * legacy Firestore get run (unchanged semantics for genuinely-cold
 * identities). These tests pin all three branches.
 */

const mockSupaGetDoc = jest.fn();
const mockSupaEnabledFor = jest.fn();
let fsGetCount = 0;
let fsRolesData: any = null;
let fsUsersData: any = null;

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

function makeDb(): any {
  return {
    collection: (name: string) => ({
      doc: () => ({
        get: async () => {
          fsGetCount += 1;
          if (name === 'roles') {
            return { exists: fsRolesData !== null, data: () => fsRolesData ?? undefined };
          }
          return { exists: fsUsersData !== null, data: () => fsUsersData ?? undefined };
        },
      }),
    }),
  };
}

const UID = 'uid-stale-1';

beforeEach(() => {
  jest.clearAllMocks();
  fsGetCount = 0;
  fsRolesData = null;
  fsUsersData = null;
  __resetLastGoodIdentityHalvesForTests();
  bustIdentity(UID);
  mockSupaEnabledFor.mockReturnValue(true);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('identity loader stale-half fallback (train 2, census 23 B1)', () => {
  it('healthy seam load remembers the halves and costs zero Firestore reads', async () => {
    mockSupaGetDoc.mockImplementation(async (collection: string) => {
      if (collection === 'roles') return { exists: true, data: { role: 'chapter_president' } };
      return { exists: true, data: { role: 'chapter_president', displayName: 'Pres' } };
    });
    const bundle = await getIdentityBundleCached(makeDb(), UID);
    expect(bundle.roles.role).toBe('chapter_president');
    expect(fsGetCount).toBe(0);
  });

  it('transient seam failure serves the last-good halves — zero Firestore reads', async () => {
    mockSupaGetDoc.mockImplementation(async (collection: string) => {
      if (collection === 'roles') return { exists: true, data: { role: 'chapter_president' } };
      return { exists: true, data: { role: 'chapter_president', displayName: 'Pres' } };
    });
    await getIdentityBundleCached(makeDb(), UID);
    expect(fsGetCount).toBe(0);

    // Bust the 30s identity cache so the loader runs again, then
    // make the seam fail transiently (null on a primary surface).
    bustIdentity(UID);
    mockSupaGetDoc.mockResolvedValue(null);
    fsRolesData = { role: 'member_basic' }; // would give a DIFFERENT answer if read
    fsUsersData = { role: 'member_basic' };

    const bundle = await getIdentityBundleCached(makeDb(), UID);
    expect(bundle.roles.role).toBe('chapter_president');
    expect(bundle.users.role).toBe('chapter_president');
    expect(fsGetCount).toBe(0);
  });

  it('no last-good half: the legacy Firestore get still runs (unchanged cold semantics)', async () => {
    mockSupaGetDoc.mockResolvedValue(null);
    fsRolesData = { role: 'member_basic' };
    fsUsersData = { role: 'member_basic' };
    const bundle = await getIdentityBundleCached(makeDb(), UID);
    expect(bundle.roles.role).toBe('member_basic');
    expect(fsGetCount).toBe(2);
  });

  it('flag OFF (Firestore-primary surface): seam null is a genuine miss, no stale games', async () => {
    mockSupaGetDoc.mockImplementation(async (collection: string) => {
      if (collection === 'roles') return { exists: true, data: { role: 'chapter_president' } };
      return { exists: true, data: { role: 'chapter_president' } };
    });
    await getIdentityBundleCached(makeDb(), UID);
    bustIdentity(UID);
    // Surface no longer Supabase-enabled: a null seam answer is the
    // ordinary not-configured state, answered by Firestore as before.
    mockSupaEnabledFor.mockReturnValue(false);
    mockSupaGetDoc.mockResolvedValue(null);
    fsRolesData = { role: 'member_basic' };
    fsUsersData = { role: 'member_basic' };
    const bundle = await getIdentityBundleCached(makeDb(), UID);
    expect(bundle.roles.role).toBe('member_basic');
    expect(fsGetCount).toBe(2);
  });
});
