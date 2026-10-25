/**
 * @jest-environment node
 *
 * Cluster G (skills) seam contracts — src/lib/server/skills-supa.ts.
 *
 * Pins:
 *  - flag OFF / client unconfigured -> reads return null/undefined (the
 *    "use Firestore" signal), mirrors no-op, adapter never called
 *  - flag ON -> admin list modes (all / slug / ids incl. empty ids),
 *    grant counts aggregated from fs_users.skillIds + fs_events
 *    .grantedSkillIds, holder lookup, slug probe tri-state
 *  - adapter error -> reads fall back (null/undefined), mirrors never throw
 *  - grant/revoke mirrors -> arrayUnion/arrayRemove semantics on the
 *    fs_users row; absent user row is skipped, never invented
 *
 * Everything is mocked: '@/lib/supa' is a fake adapter over in-memory
 * rows. Zero live reads.
 */

const mockSupa = {
  enabled: false,
  clientConfigured: true,
  fail: false,
  calls: [] as string[],
  tables: new Map<string, Map<string, Record<string, any>>>(),
};

function table(name: string) {
  if (!mockSupa.tables.has(name)) mockSupa.tables.set(name, new Map());
  return mockSupa.tables.get(name)!;
}

function fakeList(collection: string, options: any = {}) {
  mockSupa.calls.push(`listDocs:${collection}`);
  if (mockSupa.fail) throw new Error('simulated adapter failure');
  let rows = [...table(`fs_${collection}`).entries()].map(([id, data]) => ({ id, ...data }));
  for (const [field, op, value] of options.where ?? []) {
    if (op === '==') rows = rows.filter((r: any) => r[field] === value);
    else if (op === 'array-contains')
      rows = rows.filter((r: any) => Array.isArray(r[field]) && r[field].includes(value));
    else throw new Error(`fake adapter: unsupported op ${op}`);
  }
  if (typeof options.limit === 'number') rows = rows.slice(0, options.limit);
  return Promise.resolve(rows);
}

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => surface === 'skills' && mockSupa.enabled,
  getSupaClient: () => (mockSupa.clientConfigured ? {} : null),
  getSupaAdapter: () => ({
    listDocs: (col: string, options?: any) => fakeList(col, options),
    getDoc: async (col: string, id: string) => {
      mockSupa.calls.push(`getDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const data = table(`fs_${col}`).get(id);
      return data ? { id, ...data } : null;
    },
    setDoc: async (col: string, id: string, data: any, options?: any) => {
      mockSupa.calls.push(`setDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const t = table(`fs_${col}`);
      t.set(id, options?.merge ? { ...(t.get(id) ?? {}), ...data } : { ...data });
      return { id, ...data };
    },
    updateDoc: async (col: string, id: string, data: any) => {
      mockSupa.calls.push(`updateDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const t = table(`fs_${col}`);
      const existing = t.get(id);
      if (!existing) {
        const err: any = new Error('not found');
        err.code = 'not-found';
        throw err;
      }
      t.set(id, { ...existing, ...data });
      return { id, ...existing, ...data };
    },
    deleteDoc: async (col: string, id: string) => {
      mockSupa.calls.push(`deleteDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      table(`fs_${col}`).delete(id);
    },
    countDocs: async () => 0,
  }),
}));

import {
  mirrorSkillCreate,
  mirrorSkillDelete,
  mirrorSkillUpdate,
  mirrorUserSkillGrants,
  mirrorUserSkillRevoke,
  skillsSupaEnabled,
  supaFindSkillBySlug,
  supaListSkillHolders,
  supaListSkillsAdmin,
  supaSkillGrantCounts,
} from '@/lib/server/skills-supa';

function seed() {
  table('fs_skills').set('rocketry', { name: 'Rocketry', slug: 'rocketry', status: 'active' });
  table('fs_skills').set('avionics', { name: 'Avionics', slug: 'avionics', status: 'active' });
  table('fs_users').set('u1', { displayName: 'One', skillIds: ['rocketry', 'avionics'] });
  table('fs_users').set('u2', { displayName: 'Two', skillIds: ['avionics'] });
  table('fs_users').set('u3', { displayName: 'Three' });
  table('fs_events').set('e1', { title: 'Launch Day', grantedSkillIds: ['rocketry'] });
  table('fs_events').set('e2', { title: 'Workshop', grantedSkillIds: ['rocketry', 'avionics'] });
}

beforeEach(() => {
  mockSupa.enabled = false;
  mockSupa.clientConfigured = true;
  mockSupa.fail = false;
  mockSupa.calls = [];
  mockSupa.tables = new Map();
  seed();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('gate', () => {
  it('is OFF by default and reads signal Firestore fallback without adapter calls', async () => {
    expect(skillsSupaEnabled()).toBe(false);
    await expect(supaListSkillsAdmin({})).resolves.toBeNull();
    await expect(supaSkillGrantCounts()).resolves.toBeNull();
    await expect(supaListSkillHolders('avionics')).resolves.toBeNull();
    await expect(supaFindSkillBySlug('rocketry')).resolves.toBeUndefined();
    expect(mockSupa.calls).toEqual([]);
  });

  it('is OFF when the flag is on but no client is configured', async () => {
    mockSupa.enabled = true;
    mockSupa.clientConfigured = false;
    expect(skillsSupaEnabled()).toBe(false);
    await expect(supaListSkillsAdmin({})).resolves.toBeNull();
    expect(mockSupa.calls).toEqual([]);
  });
});

describe('flag ON reads', () => {
  beforeEach(() => {
    mockSupa.enabled = true;
  });

  it('lists all skills', async () => {
    const items = await supaListSkillsAdmin({});
    expect(items?.map((i) => i.id).sort()).toEqual(['avionics', 'rocketry']);
    expect(items?.find((i) => i.id === 'rocketry')?.name).toBe('Rocketry');
  });

  it('filters by slug', async () => {
    const items = await supaListSkillsAdmin({ slug: 'avionics' });
    expect(items).toHaveLength(1);
    expect(items?.[0].id).toBe('avionics');
  });

  it('resolves explicit ids and drops missing ones', async () => {
    const items = await supaListSkillsAdmin({ ids: ['avionics', 'missing'] });
    expect(items?.map((i) => i.id)).toEqual(['avionics']);
  });

  it('an empty ids list yields an empty result (Firestore parity)', async () => {
    await expect(supaListSkillsAdmin({ ids: [] })).resolves.toEqual([]);
  });

  it('aggregates grant counts from users.skillIds and events.grantedSkillIds', async () => {
    const counts = await supaSkillGrantCounts();
    expect(counts?.userCounts).toEqual({ rocketry: 1, avionics: 2 });
    expect(counts?.eventCounts).toEqual({ rocketry: 2, avionics: 1 });
  });

  it('lists holders via array-contains on skillIds', async () => {
    const holders = await supaListSkillHolders('avionics');
    expect(holders?.map((h) => h.id).sort()).toEqual(['u1', 'u2']);
  });

  it('slug probe is tri-state: doc / null / undefined-on-fallback', async () => {
    await expect(supaFindSkillBySlug('rocketry')).resolves.toMatchObject({ id: 'rocketry' });
    await expect(supaFindSkillBySlug('nope')).resolves.toBeNull();
    mockSupa.fail = true;
    await expect(supaFindSkillBySlug('rocketry')).resolves.toBeUndefined();
  });
});

describe('adapter error fallback', () => {
  beforeEach(() => {
    mockSupa.enabled = true;
    mockSupa.fail = true;
  });

  it('reads return the fallback signal instead of throwing', async () => {
    await expect(supaListSkillsAdmin({})).resolves.toBeNull();
    await expect(supaSkillGrantCounts()).resolves.toBeNull();
    await expect(supaListSkillHolders('avionics')).resolves.toBeNull();
  });

  it('mirrors never throw', async () => {
    await expect(mirrorSkillCreate('x', { name: 'X' })).resolves.toBeUndefined();
    await expect(mirrorSkillUpdate('x', { name: 'X' })).resolves.toBeUndefined();
    await expect(mirrorSkillDelete('x')).resolves.toBeUndefined();
    await expect(mirrorUserSkillGrants('u1', ['x'])).resolves.toBeUndefined();
    await expect(mirrorUserSkillRevoke('u1', 'x')).resolves.toBeUndefined();
  });
});

describe('mirrors (flag ON)', () => {
  beforeEach(() => {
    mockSupa.enabled = true;
  });

  it('create/update/delete copy the Firestore write into fs_skills', async () => {
    await mirrorSkillCreate('cad', { name: 'CAD', slug: 'cad' });
    expect(table('fs_skills').get('cad')).toEqual({ name: 'CAD', slug: 'cad' });
    await mirrorSkillUpdate('cad', { status: 'archived' });
    expect(table('fs_skills').get('cad')).toEqual({ name: 'CAD', slug: 'cad', status: 'archived' });
    await mirrorSkillDelete('cad');
    expect(table('fs_skills').has('cad')).toBe(false);
  });

  it('grant mirror unions without duplicating', async () => {
    await mirrorUserSkillGrants('u2', ['rocketry', 'avionics']);
    expect(table('fs_users').get('u2')?.skillIds).toEqual(['avionics', 'rocketry']);
  });

  it('grant mirror skips an absent user row instead of inventing one', async () => {
    await mirrorUserSkillGrants('ghost', ['rocketry']);
    expect(table('fs_users').has('ghost')).toBe(false);
  });

  it('revoke mirror removes only the named skill', async () => {
    await mirrorUserSkillRevoke('u1', 'rocketry');
    expect(table('fs_users').get('u1')?.skillIds).toEqual(['avionics']);
    await mirrorUserSkillRevoke('u1', 'not-held');
    expect(table('fs_users').get('u1')?.skillIds).toEqual(['avionics']);
  });

  it('mirrors are no-ops when the flag is OFF', async () => {
    mockSupa.enabled = false;
    await mirrorSkillCreate('cad', { name: 'CAD' });
    await mirrorUserSkillGrants('u1', ['cad']);
    await mirrorSkillDelete('rocketry');
    expect(mockSupa.calls).toEqual([]);
    expect(table('fs_skills').has('cad')).toBe(false);
    expect(table('fs_skills').has('rocketry')).toBe(true);
  });
});
