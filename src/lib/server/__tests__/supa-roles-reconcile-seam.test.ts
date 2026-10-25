/**
 * @jest-environment node
 *
 * Supabase migration, ROLES cluster G4 seam unit tests.
 * REAL-SHAPED fake adapter only (feat/supa-adapter contract):
 * getDoc returns a FLATTENED doc { id, ...fields } or null for a
 * missing doc; listDocs returns flattened docs. Zero live reads.
 *
 * Pins:
 *  - adapter null (missing doc) -> { exists: false }, NO fallback
 *  - flattened doc -> { exists: true, data } with the id key stripped
 *  - adapter throw -> null from the seam (caller takes Firestore path)
 *  - flag OFF -> seam returns null and adapter DATA fns never called
 *  - mirror failure is swallowed (false), never throws
 */
import {
  __setSupaAdapterForTests,
  supaEnabledForRoles,
  supaGetDoc,
  supaListDocs,
  supaMirrorUpdate,
  type SupaRolesAdapter,
} from '../supa-roles-reconcile-seam';

type DocMap = Record<string, Record<string, Record<string, unknown>>>;

function fakeAdapter(opts: {
  on?: boolean;
  docs?: DocMap;
  throwOn?: 'get' | 'list' | 'update';
}): SupaRolesAdapter & { calls: string[] } {
  const calls: string[] = [];
  const on = opts.on ?? true;
  return {
    calls,
    useSupa: () => on,
    getDoc: async (collection: string, id: string) => {
      calls.push(`getDoc:${collection}/${id}`);
      if (opts.throwOn === 'get') throw new Error('supa boom');
      const data = opts.docs?.[collection]?.[id];
      return data ? { id, ...data } : null;
    },
    listDocs: async (collection: string, listOpts?: unknown) => {
      calls.push(`listDocs:${collection}:${JSON.stringify(listOpts ?? null)}`);
      if (opts.throwOn === 'list') throw new Error('supa boom');
      return Object.entries(opts.docs?.[collection] ?? {}).map(([id, data]) => ({
        id,
        ...data,
      }));
    },
    countDocs: async () => 0,
    setDoc: async () => undefined,
    updateDoc: async (collection: string, id: string) => {
      calls.push(`updateDoc:${collection}/${id}`);
      if (opts.throwOn === 'update') throw new Error('supa boom');
      return undefined;
    },
    deleteDoc: async () => undefined,
  };
}

afterEach(() => {
  __setSupaAdapterForTests(null);
});

describe('supa-roles-reconcile seam (real adapter shape)', () => {
  it('no adapter injected and module absent on this branch -> seam unavailable', async () => {
    __setSupaAdapterForTests(null);
    await expect(supaEnabledForRoles()).resolves.toBe(false);
    await expect(supaGetDoc('roles', 'u1')).resolves.toBeNull();
    await expect(supaListDocs('roles')).resolves.toBeNull();
    await expect(supaMirrorUpdate('roles', 'u1', { a: 1 })).resolves.toBe(false);
  });

  it('adapter null for a missing doc -> { exists: false }, which is data, not fallback (null)', async () => {
    const a = fakeAdapter({ docs: { roles: {} } });
    __setSupaAdapterForTests(a);
    const result = await supaGetDoc('roles', 'missing');
    expect(result).not.toBeNull();
    expect(result).toEqual({ exists: false, data: undefined });
  });

  it('flattened doc -> { exists: true, data } with id stripped and fields verbatim', async () => {
    const a = fakeAdapter({
      docs: {
        users: {
          u1: { role: 'member', isBanned: false, nested: { x: [1, 2] } },
        },
      },
    });
    __setSupaAdapterForTests(a);
    await expect(supaGetDoc('users', 'u1')).resolves.toEqual({
      exists: true,
      data: { role: 'member', isBanned: false, nested: { x: [1, 2] } },
    });
  });

  it('adapter throw on get -> null (Firestore fallback signal), never throws', async () => {
    const a = fakeAdapter({ throwOn: 'get' });
    __setSupaAdapterForTests(a);
    await expect(supaGetDoc('roles', 'u1')).resolves.toBeNull();
  });

  it('adapter throw on list -> null, never throws', async () => {
    const a = fakeAdapter({ throwOn: 'list' });
    __setSupaAdapterForTests(a);
    await expect(supaListDocs('users')).resolves.toBeNull();
  });

  it('flag OFF -> null/false and adapter data functions are never called', async () => {
    const a = fakeAdapter({ on: false, docs: { roles: { u1: { role: 'admin' } } } });
    __setSupaAdapterForTests(a);
    await expect(supaEnabledForRoles()).resolves.toBe(false);
    await expect(supaGetDoc('roles', 'u1')).resolves.toBeNull();
    await expect(supaListDocs('roles')).resolves.toBeNull();
    await expect(supaMirrorUpdate('roles', 'u1', { expiryAlertStage: 't30_sent' })).resolves.toBe(false);
    expect(a.calls).toEqual([]);
  });

  it('listDocs translates flattened docs to { id, data }[] and passes ListOptions through', async () => {
    const a = fakeAdapter({
      docs: {
        roleHistory: {
          h1: { uid: 'ghost', action: 'grant' },
          h2: { uid: 'u1', action: 'change' },
        },
      },
    });
    __setSupaAdapterForTests(a);
    const opts = { where: [['uid', '==', 'ghost']] as Array<[string, string, unknown]> };
    await expect(supaListDocs('roleHistory', opts)).resolves.toEqual([
      { id: 'h1', data: { uid: 'ghost', action: 'grant' } },
      { id: 'h2', data: { uid: 'u1', action: 'change' } },
    ]);
    expect(a.calls[0]).toContain(JSON.stringify(opts));
  });

  it('mirror update: success -> true with the same payload', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const a = fakeAdapter({});
    a.updateDoc = async (_c: string, _id: string, data: Record<string, unknown>) => {
      seen.push(data);
      return undefined;
    };
    __setSupaAdapterForTests(a);
    await expect(
      supaMirrorUpdate('roles', 'u1', { expiryAlertStage: 't7_sent' }),
    ).resolves.toBe(true);
    expect(seen).toEqual([{ expiryAlertStage: 't7_sent' }]);
  });

  it('mirror update: adapter failure is swallowed -> false, never throws', async () => {
    const a = fakeAdapter({ throwOn: 'update' });
    __setSupaAdapterForTests(a);
    await expect(
      supaMirrorUpdate('roles', 'u1', { expiryAlertStage: 't7_sent' }),
    ).resolves.toBe(false);
  });
});
