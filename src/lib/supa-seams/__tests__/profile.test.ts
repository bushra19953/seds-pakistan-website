/* Seam unit tests for src/lib/supa-seams/profile.ts (mocked adapter only,
 * zero live reads). */
import {
  tryGetProfileUser,
  tryGetProfileRole,
  tryListUsersByManagerIds,
  tryGetUsersByIds,
  toTimestampLike,
  convertUserTimestamps,
  setAdapterForTests,
  resetAdapterForTests,
  isProfileSupaEnabled,
  type SupaAdapter,
  type SupaDoc,
} from '../profile';

const users: Record<string, SupaDoc> = {
  'u-1': {
    id: 'u-1',
    displayName: 'Supa User',
    displayRole: 'member',
    createdAt: '2025-06-01T10:00:00.000Z',
    lastLogin: '2026-10-20T10:00:00.000Z',
    termsAcceptedAt: '2026-01-15T00:00:00.000Z',
    managerId: 'mgr-1',
  },
  'sub-1': { id: 'sub-1', displayName: 'Sub One', managerId: 'u-1', displayRole: 'member' },
};
const roles: Record<string, SupaDoc> = {
  'admin-1': { id: 'admin-1', role: 'president_chapter', createdAt: '2025-01-01T00:00:00.000Z' },
};

function fakeAdapter(overrides: Partial<SupaAdapter> = {}): SupaAdapter {
  return {
    getDoc: async (coll: string, id: string) =>
      coll === 'users' ? users[id] ?? null : coll === 'roles' ? roles[id] ?? null : null,
    listDocs: async (coll: string, opts: any) => {
      if (coll !== 'users') return [];
      const mgr = opts?.where?.find((w: any) => w[0] === 'managerId')?.[2] as string[];
      return Object.values(users).filter((u) => mgr?.includes(String(u.managerId)));
    },
    countDocs: async () => 0,
    setDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    updateDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    deleteDoc: async () => undefined,
    ...overrides,
    rpc: async () => { throw new Error('unexpected rpc'); },
    tx: async () => { throw new Error('unexpected tx'); },
  };
}

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  resetAdapterForTests();
});
afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetAdapterForTests();
});

describe('flag gating', () => {
  it('flag OFF: disabled even with an adapter injected', async () => {
    setAdapterForTests(fakeAdapter());
    expect(isProfileSupaEnabled()).toBe(false);
    await expect(tryGetProfileUser('u-1')).resolves.toEqual({ status: 'disabled' });
  });
  it('flag ON but no adapter: disabled', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(null);
    expect(isProfileSupaEnabled()).toBe(false);
    await expect(tryGetProfileUser('u-1')).resolves.toEqual({ status: 'disabled' });
  });
  it("flag ON via '*': enabled with adapter", () => {
    process.env.SUPA_SURFACES = '*';
    setAdapterForTests(fakeAdapter());
    expect(isProfileSupaEnabled()).toBe(true);
  });
});

describe('reads', () => {
  beforeEach(() => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter());
  });

  it('profile user: snapshot shape, data() excludes id', async () => {
    const r = await tryGetProfileUser('u-1');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value.exists).toBe(true);
    expect(r.value.id).toBe('u-1');
    expect(r.value.data()?.displayName).toBe('Supa User');
    expect('id' in (r.value.data() ?? {})).toBe(false);
  });

  it('profile user: missing doc -> exists:false, data undefined (route renders profile_not_found)', async () => {
    const r = await tryGetProfileUser('ghost');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value.exists).toBe(false);
    expect(r.value.data()).toBeUndefined();
  });

  it('roles: requester role doc', async () => {
    const r = await tryGetProfileRole('admin-1');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value.data()?.role).toBe('president_chapter');
  });

  it('managerId-in list + by-ids fetch (missing ids absent)', async () => {
    const list = await tryListUsersByManagerIds(['u-1']);
    expect(list.status).toBe('ok');
    if (list.status === 'ok') expect(list.value.docs.map((d) => d.id)).toEqual(['sub-1']);
    const byIds = await tryGetUsersByIds(['sub-1', 'ghost']);
    expect(byIds.status).toBe('ok');
    if (byIds.status === 'ok') {
      expect(byIds.value.docs.map((d) => d.id)).toEqual(['sub-1']);
      expect(byIds.value.docs[0].data().displayName).toBe('Sub One');
    }
  });

  it('adapter error: status error (caller falls back to Firestore)', async () => {
    setAdapterForTests(
      fakeAdapter({
        getDoc: async () => {
          throw new Error('supa down');
        },
      }),
    );
    const r = await tryGetProfileUser('u-1');
    expect(r.status).toBe('error');
  });
});

describe('timestamp conversion at the seam', () => {
  it('ISO -> Timestamp-like serialising exactly like Admin Timestamp JSON', () => {
    const v: any = toTimestampLike('2025-06-01T10:00:00.000Z');
    expect(JSON.stringify({ v })).toBe(
      JSON.stringify({ v: { _seconds: 1748772000, _nanoseconds: 0 } }),
    );
    expect(v.seconds).toBe(1748772000);
    expect(v._seconds).toBe(1748772000);
    expect(v.toDate()).toEqual(new Date('2025-06-01T10:00:00.000Z'));
    expect(v.toMillis()).toBe(1748772000000);
    expect(v.toISOString()).toBe('2025-06-01T10:00:00.000Z');
  });

  it('unparseable / non-date values pass through untouched', () => {
    expect(toTimestampLike('not-a-date')).toBe('not-a-date');
    expect(toTimestampLike(42)).toBe(42);
    expect(toTimestampLike(null)).toBeNull();
  });

  it('convertUserTimestamps converts listed fields only', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter());
    const r = await tryGetProfileUser('u-1');
    if (r.status !== 'ok') throw new Error('expected ok');
    const data = r.value.data()!;
    // createdAt/lastLogin/termsAcceptedAt are converted...
    expect((data.createdAt as any).toDate()).toEqual(new Date('2025-06-01T10:00:00.000Z'));
    expect((data.lastLogin as any)._seconds).toBeGreaterThan(0);
    expect(JSON.stringify({ t: data.termsAcceptedAt })).toContain('_seconds');
    // ...displayName is untouched
    expect(data.displayName).toBe('Supa User');
    const raw = convertUserTimestamps({ createdAt: '2025-06-01T10:00:00.000Z', other: '2025-06-01T10:00:00.000Z' });
    expect(typeof raw.other).toBe('string');
  });
});
