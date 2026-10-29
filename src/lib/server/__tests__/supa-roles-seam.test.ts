/**
 * @jest-environment node
 *
 * Supabase migration, ROLES+PERMISSIONS file-group 1 seam tests.
 * Mock only - zero live reads. Pins:
 *  - flag OFF  -> Firestore path exactly (adapter data fn never called)
 *  - flag ON   -> Supabase path for roles / roleDefinitions / permissions
 *  - adapter error / absent -> null from the seam -> Firestore fallback
 *  - founder blanket + permission-doc walk order preserved in both states
 *  - identity bundle: roles half seamable; users half seamable too
 *    since the 2026-10-29 auth identity re-home (was ALWAYS Firestore)
 */
const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' } } },
}));

import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import * as seam from '../supa-roles-seam';
import * as serverPerms from '../permissions';
import { resetIdentityCache } from '../identity-cache';

function fakeAdapter(opts: {
  on: boolean;
  docs?: Record<string, Record<string, Record<string, unknown>>>;
  throwOnGet?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    useSupa: () => opts.on,
    getDoc: async (collection: string, id: string) => {
      calls.push(`getDoc:${collection}/${id}`);
      if (opts.throwOnGet) throw new Error('supa boom');
      const data = opts.docs?.[collection]?.[id];
      return data ? { exists: true, data } : { exists: false };
    },
    listDocs: async (collection: string) => {
      calls.push(`listDocs:${collection}`);
      return Object.entries(opts.docs?.[collection] ?? {}).map(([id, data]) => ({ id, data }));
    },
    setDoc: async () => undefined,
    updateDoc: async () => undefined,
    deleteDoc: async () => undefined,
  };
}

let fake: FakeFirestore;
beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
  resetIdentityCache();
  seam.__setSupaAdapterForTests(null);
});
afterEach(() => {
  seam.__setSupaAdapterForTests(null);
  resetIdentityCache();
});

describe('seam unit behaviour', () => {
  test('no adapter injected and module absent -> disabled, getDoc null', async () => {
    await expect(seam.supaEnabledFor('roles')).resolves.toBe(false);
    await expect(seam.supaGetDoc('roles', 'u1')).resolves.toBeNull();
  });

  test('flag OFF -> adapter getDoc never called', async () => {
    const a = fakeAdapter({ on: false, docs: { roles: { u1: { role: 'admin' } } } });
    seam.__setSupaAdapterForTests(a);
    await expect(seam.supaGetDoc('roles', 'u1')).resolves.toBeNull();
    expect(a.calls).toEqual([]);
  });

  test('flag ON -> doc and missing-doc shapes', async () => {
    const a = fakeAdapter({ on: true, docs: { roles: { u1: { role: 'admin' } } } });
    seam.__setSupaAdapterForTests(a);
    await expect(seam.supaGetDoc('roles', 'u1')).resolves.toEqual({ exists: true, data: { role: 'admin' } });
    await expect(seam.supaGetDoc('roles', 'nope')).resolves.toEqual({ exists: false, data: undefined });
  });

  test('adapter error -> null (Firestore fallback signal), never throws', async () => {
    const a = fakeAdapter({ on: true, throwOnGet: true });
    seam.__setSupaAdapterForTests(a);
    await expect(seam.supaGetDoc('roles', 'u1')).resolves.toBeNull();
    await expect(seam.supaMirrorSet('roleDefinitions', 'x', {})).resolves.toBe(true);
  });
});

describe('hasServerPermission through the seam', () => {
  test('flag OFF: supa-only roleDefinitions grant is invisible, Firestore doc wins', async () => {
    const a = fakeAdapter({
      on: false,
      docs: { roleDefinitions: { member_basic: { permissions: ['canManageTasks'] } } },
    });
    seam.__setSupaAdapterForTests(a);
    // No Firestore doc: answer must be the static-config answer.
    const expected = await serverPerms.hasServerPermission('member_basic', 'canManageTasks');
    resetIdentityCache();
    seam.__setSupaAdapterForTests(a);
    await expect(serverPerms.hasServerPermission('member_basic', 'canManageTasks')).resolves.toBe(expected);
    expect(a.calls).toEqual([]);
  });

  test('flag ON: roleDefinitions (Supabase) is authoritative, walk stops there', async () => {
    const a = fakeAdapter({
      on: true,
      docs: { roleDefinitions: { member_basic: { permissions: ['canManageTasks'] } } },
    });
    seam.__setSupaAdapterForTests(a);
    fake.seed('permissions', 'member_basic', { canManageTasks: false });
    await expect(serverPerms.hasServerPermission('member_basic', 'canManageTasks')).resolves.toBe(true);
    // roleDefinitions hit means permissions tier read came from supa too,
    // but the array is authoritative so its false never overrides.
    expect(a.calls).toContain('getDoc:roleDefinitions/member_basic');
  });

  test('flag ON + supa error: falls back to Firestore permissions doc', async () => {
    const a = fakeAdapter({ on: true, throwOnGet: true });
    seam.__setSupaAdapterForTests(a);
    fake.seed('permissions', 'member_basic', { canManageTasks: true });
    await expect(serverPerms.hasServerPermission('member_basic', 'canManageTasks')).resolves.toBe(true);
  });

  test('founder blanket unchanged in both states (zero doc reads)', async () => {
    const a = fakeAdapter({ on: true, docs: {} });
    seam.__setSupaAdapterForTests(a);
    await expect(serverPerms.hasServerPermission('founder_patron', 'canManageRoles')).resolves.toBe(true);
    expect(a.calls).toEqual([]);
  });
});

describe('identity bundle through the seam', () => {
  test('flag ON: roles half AND users half from Supabase (users half re-homed 2026-10-29)', async () => {
    const a = fakeAdapter({
      on: true,
      docs: {
        roles: { u1: { role: 'chapter_president', chapterId: 'c1' } },
        users: { u1: { role: 'member_basic', isBanned: true } },
      },
    });
    seam.__setSupaAdapterForTests(a);
    // Firestore carries DIVERGENT stale values on purpose: if either
    // half read Firestore, the assertions below would see them.
    fake.seed('users', 'u1', { role: 'member_basic', isBanned: false });
    const identity = await serverPerms.resolveIdentityForAuth(fake.asDb(), 'u1');
    expect(identity.role).toBe('chapter_president');
    expect(identity.isBanned).toBe(true); // proves users half read Supabase, not Firestore
    expect(a.calls).toContain('getDoc:roles/u1');
    expect(a.calls).toContain('getDoc:users/u1');
  });

  test('flag OFF: roles half from Firestore exactly as before', async () => {
    const a = fakeAdapter({ on: false, docs: { roles: { u1: { role: 'chapter_president' } } } });
    seam.__setSupaAdapterForTests(a);
    fake.seed('roles', 'u1', { role: 'national_treasurer' });
    fake.seed('users', 'u1', { role: 'member_basic' });
    const identity = await serverPerms.resolveIdentityForAuth(fake.asDb(), 'u1');
    expect(identity.role).toBe('national_treasurer');
    expect(a.calls).toEqual([]);
  });

  test('flag ON + supa error: roles half falls back to Firestore', async () => {
    const a = fakeAdapter({ on: true, throwOnGet: true });
    seam.__setSupaAdapterForTests(a);
    fake.seed('roles', 'u1', { role: 'national_treasurer' });
    fake.seed('users', 'u1', {});
    const identity = await serverPerms.resolveIdentityForAuth(fake.asDb(), 'u1');
    expect(identity.role).toBe('national_treasurer');
  });
});
