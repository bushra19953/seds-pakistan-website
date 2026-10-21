/**
 * @jest-environment node
 *
 * Tests for src/lib/server/role-holders.ts.
 *
 * Pins: holders are read from roles/{uid} -> { role: 'slug' } via
 * collection('roles').where('role','==',roleKey); vacancy returns [];
 * a failing query returns [] (never throws, never falls back to the
 * Founder); resolveUserRoleKey returns the role string or null.
 */

import { FOUNDER_UID } from '@/lib/roles';
import { resolveRoleHolders, resolveUserRoleKey } from '../role-holders';

type MockState = {
  holders: Array<{ id: string }>;
  roleDocs: Record<string, { role?: unknown } | undefined>;
  queryThrows: boolean;
  docThrows: boolean;
  lastWhere?: [string, string, unknown];
};

function makeDb(state: MockState): any {
  return {
    collection: (name: string) => {
      if (name !== 'roles') throw new Error(`unexpected collection ${name}`);
      return {
        where: (field: string, op: string, value: unknown) => {
          state.lastWhere = [field, op, value];
          return {
            get: async () => {
              if (state.queryThrows) throw new Error('firestore unavailable');
              return { docs: state.holders, empty: state.holders.length === 0 };
            },
          };
        },
        doc: (uid: string) => ({
          id: uid,
          get: async () => {
            if (state.docThrows) throw new Error('firestore unavailable');
            const data = state.roleDocs[uid];
            return {
              exists: data !== undefined,
              data: () => data,
            };
          },
        }),
      };
    },
  };
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    holders: [],
    roleDocs: {},
    queryThrows: false,
    docThrows: false,
    ...overrides,
  };
}

describe('resolveRoleHolders', () => {
  it('returns the uids of all holders of the role', async () => {
    const state = freshState({ holders: [{ id: 'uid-a' }, { id: 'uid-b' }] });
    const db = makeDb(state);

    const holders = await resolveRoleHolders(db, 'general_secretary_national');

    expect(holders).toEqual(['uid-a', 'uid-b']);
    expect(state.lastWhere).toEqual(['role', '==', 'general_secretary_national']);
  });

  it('returns [] for a vacant role', async () => {
    const db = makeDb(freshState({ holders: [] }));

    await expect(resolveRoleHolders(db, 'general_secretary_national')).resolves.toEqual([]);
  });

  it('returns [] (never throws, never the Founder) when the query fails', async () => {
    const db = makeDb(freshState({ queryThrows: true }));

    const holders = await resolveRoleHolders(db, 'general_secretary_national');

    expect(holders).toEqual([]);
    expect(holders).not.toContain(FOUNDER_UID);
  });
});

describe('resolveUserRoleKey', () => {
  it('returns the role string from roles/{uid}', async () => {
    const db = makeDb(freshState({ roleDocs: { 'uid-a': { role: 'chair_design' } } }));

    await expect(resolveUserRoleKey(db, 'uid-a')).resolves.toBe('chair_design');
  });

  it('returns null when the user has no role doc', async () => {
    const db = makeDb(freshState({ roleDocs: {} }));

    await expect(resolveUserRoleKey(db, 'missing-uid')).resolves.toBeNull();
  });

  it('returns null when the role doc has no role string', async () => {
    const db = makeDb(freshState({ roleDocs: { 'uid-a': {} } }));

    await expect(resolveUserRoleKey(db, 'uid-a')).resolves.toBeNull();
  });

  it('returns null (never throws) when the read fails', async () => {
    const db = makeDb(freshState({ docThrows: true }));

    await expect(resolveUserRoleKey(db, 'uid-a')).resolves.toBeNull();
  });
});
