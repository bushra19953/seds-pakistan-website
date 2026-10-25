/**
 * @jest-environment node
 *
 * Cluster G (skills) route contracts for:
 *   GET/POST/PATCH/DELETE /api/skills
 *   POST /api/skills/assign-bulk (the grant path)
 *
 * Pins:
 *  - flag OFF -> Firestore serves/mutates exactly as before; the adapter
 *    is never called
 *  - flag ON  -> GET is served from fs_skills with counts aggregated from
 *    fs_users.skillIds / fs_events.grantedSkillIds (Firestore skills read
 *    never runs); writes stay Firestore-primary and are mirrored
 *  - adapter error on GET -> Firestore fallback, response unchanged
 *  - adapter error on a mirror -> the Firestore-backed response still
 *    succeeds (mirrors never throw)
 *  - assign-bulk -> Firestore batch commits first, grant mirrors union the
 *    skill onto each holder's fs_users row
 *
 * Everything is mocked (fake adapter + FakeFirestore). Zero live reads.
 */

/* ------------------------------------------------------------ supa fake */
const mockSupa = {
  enabled: false,
  fail: false,
  calls: [] as string[],
  tables: new Map<string, Map<string, Record<string, any>>>(),
};
function supaTable(name: string) {
  if (!mockSupa.tables.has(name)) mockSupa.tables.set(name, new Map());
  return mockSupa.tables.get(name)!;
}
jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => surface === 'skills' && mockSupa.enabled,
  getSupaClient: () => ({}),
  getSupaAdapter: () => ({
    listDocs: async (col: string, options: any = {}) => {
      mockSupa.calls.push(`listDocs:${col}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      let rows = [...supaTable(`fs_${col}`).entries()].map(([id, data]) => ({ id, ...data }));
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') rows = rows.filter((r: any) => r[field] === value);
        else if (op === 'array-contains')
          rows = rows.filter((r: any) => Array.isArray(r[field]) && r[field].includes(value));
        else throw new Error(`fake adapter: unsupported op ${op}`);
      }
      if (typeof options.limit === 'number') rows = rows.slice(0, options.limit);
      return rows;
    },
    getDoc: async (col: string, id: string) => {
      mockSupa.calls.push(`getDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const data = supaTable(`fs_${col}`).get(id);
      return data ? { id, ...data } : null;
    },
    setDoc: async (col: string, id: string, data: any, options?: any) => {
      mockSupa.calls.push(`setDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const t = supaTable(`fs_${col}`);
      t.set(id, options?.merge ? { ...(t.get(id) ?? {}), ...data } : { ...data });
      return { id, ...data };
    },
    updateDoc: async (col: string, id: string, data: any) => {
      mockSupa.calls.push(`updateDoc:${col}/${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      const t = supaTable(`fs_${col}`);
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
      supaTable(`fs_${col}`).delete(id);
    },
    countDocs: async () => 0,
  }),
}));

/* -------------------------------------------------------- firestore fake */
const mockFs = {
  calls: [] as string[],
  batchOps: [] as Array<Record<string, any>>,
  skills: new Map<string, Record<string, any>>(),
  users: new Map<string, Record<string, any>>(),
  events: new Map<string, Record<string, any>>(),
  addCounter: 0,
};

function docSnap(col: string, id: string, data: Record<string, any> | undefined) {
  return {
    id,
    exists: data !== undefined,
    ref: { __path: `${col}/${id}` },
    data: () => data,
  };
}
function snapOf(entries: Array<[string, Record<string, any>]>, col: string) {
  return { docs: entries.map(([id, data]) => docSnap(col, id, data)), empty: entries.length === 0 };
}
function filterEntries(
  map: Map<string, Record<string, any>>,
  field: string,
  op: string,
  value: any,
): Array<[string, Record<string, any>]> {
  const all = [...map.entries()];
  if (field === '__name__' && op === 'in') return all.filter(([id]) => (value as string[]).includes(id));
  if (op === '==') return all.filter(([, d]) => d[field] === value);
  if (op === 'array-contains') return all.filter(([, d]) => Array.isArray(d[field]) && d[field].includes(value));
  throw new Error(`fake firestore: unsupported ${field} ${op}`);
}

function collectionApi(name: string) {
  const map = name === 'skills' ? mockFs.skills : name === 'users' ? mockFs.users : mockFs.events;
  return {
    get: async () => {
      mockFs.calls.push(`get:${name}`);
      return snapOf([...map.entries()], name);
    },
    select: (..._fields: string[]) => ({
      get: async () => {
        mockFs.calls.push(`get:${name}`);
        return snapOf([...map.entries()], name);
      },
    }),
    where: (field: string, op: string, value: any) => ({
      get: async () => {
        mockFs.calls.push(`where:${name}`);
        return snapOf(filterEntries(map, field, op, value), name);
      },
      limit: (_n: number) => ({
        get: async () => {
          mockFs.calls.push(`where:${name}`);
          return snapOf(filterEntries(map, field, op, value).slice(0, _n), name);
        },
      }),
    }),
    add: async (data: Record<string, any>) => {
      mockFs.calls.push(`add:${name}`);
      const id = `added-${++mockFs.addCounter}`;
      map.set(id, { ...data });
      return { id };
    },
    doc: (id: string) => ({
      __path: `${name}/${id}`,
      get: async () => docSnap(name, id, map.get(id)),
      set: async (data: Record<string, any>, opts?: any) => {
        mockFs.calls.push(`set:${name}/${id}`);
        map.set(id, opts?.merge ? { ...(map.get(id) ?? {}), ...data } : { ...data });
      },
      delete: async () => {
        mockFs.calls.push(`delete:${name}/${id}`);
        map.delete(id);
      },
    }),
  };
}

const mockDb = {
  collection: (name: string) => collectionApi(name),
  batch: () => {
    const ops: Array<Record<string, any>> = [];
    return {
      set: (ref: any, data: any, opts?: any) => ops.push({ op: 'set', ref: ref.__path, data, opts }),
      delete: (ref: any) => ops.push({ op: 'delete', ref: ref.__path }),
      commit: async () => {
        mockFs.calls.push('batch:commit');
        mockFs.batchOps.push(...ops);
        for (const op of ops) {
          const [col, id] = String(op.ref).split('/');
          const map = col === 'skills' ? mockFs.skills : mockFs.users;
          if (op.op === 'delete') map.delete(id);
          else if (op.data?.skillIds?.__arrayRemove) {
            const cur = map.get(id) ?? {};
            map.set(id, {
              ...cur,
              skillIds: (cur.skillIds ?? []).filter((s: string) => s !== op.data.skillIds.__arrayRemove),
            });
          } else if (op.data?.skillIds?.__arrayUnion) {
            const cur = map.get(id) ?? {};
            const ids: string[] = cur.skillIds ?? [];
            if (!ids.includes(op.data.skillIds.__arrayUnion)) ids.push(op.data.skillIds.__arrayUnion);
            map.set(id, { ...cur, skillIds: ids });
          }
        }
      },
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: {
    auth: () => ({
      verifyIdToken: async () => ({ uid: 'admin-1', manageSkills: true }),
    }),
    firestore: {
      FieldPath: { documentId: () => '__name__' },
      FieldValue: {
        arrayUnion: (v: string) => ({ __arrayUnion: v }),
        arrayRemove: (v: string) => ({ __arrayRemove: v }),
      },
    },
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: async () => true,
}));

import { DELETE, GET, PATCH, POST } from '@/app/api/skills/route';
import { POST as assignBulkPOST } from '@/app/api/skills/assign-bulk/route';
import { NextRequest } from 'next/server';

function req(path: string, init?: any) {
  return new NextRequest(path, {
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...init,
  });
}

function seedAll() {
  const skills: Array<[string, any]> = [
    ['rocketry', { name: 'Rocketry', slug: 'rocketry', status: 'active' }],
    ['avionics', { name: 'Avionics', slug: 'avionics', status: 'active' }],
  ];
  const users: Array<[string, any]> = [
    ['u1', { skillIds: ['rocketry', 'avionics'] }],
    ['u2', { skillIds: ['avionics'] }],
  ];
  const events: Array<[string, any]> = [
    ['e1', { grantedSkillIds: ['rocketry'] }],
    ['e2', { grantedSkillIds: ['rocketry', 'avionics'] }],
  ];
  for (const [id, d] of skills) {
    mockFs.skills.set(id, { ...d });
    supaTable('fs_skills').set(id, { ...d });
  }
  for (const [id, d] of users) {
    mockFs.users.set(id, JSON.parse(JSON.stringify(d)));
    supaTable('fs_users').set(id, JSON.parse(JSON.stringify(d)));
  }
  for (const [id, d] of events) {
    mockFs.events.set(id, JSON.parse(JSON.stringify(d)));
    supaTable('fs_events').set(id, JSON.parse(JSON.stringify(d)));
  }
}

beforeEach(() => {
  mockSupa.enabled = false;
  mockSupa.fail = false;
  mockSupa.calls = [];
  mockSupa.tables = new Map();
  mockFs.calls = [];
  mockFs.batchOps = [];
  mockFs.skills = new Map();
  mockFs.users = new Map();
  mockFs.events = new Map();
  mockFs.addCounter = 0;
  seedAll();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('GET /api/skills', () => {
  it('flag OFF: Firestore serves with aggregated counts; adapter untouched', async () => {
    const res = await GET(req('http://localhost/api/skills'));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.items).toHaveLength(2);
    const rocketry = body.items.find((i: any) => i.id === 'rocketry');
    expect(rocketry.assignedUserCount).toBe(1);
    expect(rocketry.linkedEventCount).toBe(2);
    expect(mockSupa.calls).toEqual([]);
    expect(mockFs.calls).toContain('get:skills');
  });

  it('flag ON: Supabase serves list + counts; Firestore skills read never runs', async () => {
    mockSupa.enabled = true;
    const res = await GET(req('http://localhost/api/skills'));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.items).toHaveLength(2);
    const avionics = body.items.find((i: any) => i.id === 'avionics');
    expect(avionics.assignedUserCount).toBe(2);
    expect(avionics.linkedEventCount).toBe(1);
    expect(mockFs.calls).not.toContain('get:skills');
    expect(mockSupa.calls).toContain('listDocs:skills');
  });

  it('flag ON + slug mode serves the single skill from Supabase', async () => {
    mockSupa.enabled = true;
    const res = await GET(req('http://localhost/api/skills?slug=avionics'));
    const body = await res!.json();
    expect(body.items.map((i: any) => i.id)).toEqual(['avionics']);
  });

  it('flag ON + adapter error: falls back to Firestore, response unchanged', async () => {
    mockSupa.enabled = true;
    mockSupa.fail = true;
    const res = await GET(req('http://localhost/api/skills'));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.find((i: any) => i.id === 'rocketry').assignedUserCount).toBe(1);
    expect(mockFs.calls).toContain('get:skills');
  });
});

describe('writes', () => {
  it('POST: Firestore-primary, mirrored to fs_skills when ON', async () => {
    mockSupa.enabled = true;
    const res = await POST(
      req('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: 'CAD Modeling', category: 'Software & Simulation' }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(mockFs.skills.get(body.id)).toMatchObject({ name: 'CAD Modeling', slug: 'cad-modeling' });
    expect(supaTable('fs_skills').get(body.id)).toMatchObject({ name: 'CAD Modeling' });
  });

  it('POST: mirror failure cannot fail the Firestore-backed create', async () => {
    mockSupa.enabled = true;
    mockSupa.fail = true;
    const res = await POST(
      req('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: 'Propulsion' }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(mockFs.skills.get(body.id)).toMatchObject({ name: 'Propulsion' });
  });

  it('PATCH: Firestore set-merge mirrored as upsert when ON', async () => {
    mockSupa.enabled = true;
    const res = await PATCH(
      req('http://localhost/api/skills', {
        method: 'PATCH',
        body: JSON.stringify({ id: 'rocketry', status: 'archived' }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(mockFs.skills.get('rocketry')?.status).toBe('archived');
    expect(supaTable('fs_skills').get('rocketry')?.status).toBe('archived');
  });

  it('DELETE: detaches holders + deletes in Firestore, mirrors both when ON', async () => {
    mockSupa.enabled = true;
    const res = await DELETE(
      req('http://localhost/api/skills', {
        method: 'DELETE',
        body: JSON.stringify({ id: 'avionics' }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(mockFs.skills.has('avionics')).toBe(false);
    expect(mockFs.users.get('u1')?.skillIds).toEqual(['rocketry']);
    expect(mockFs.users.get('u2')?.skillIds).toEqual([]);
    expect(supaTable('fs_skills').has('avionics')).toBe(false);
    expect(supaTable('fs_users').get('u1')?.skillIds).toEqual(['rocketry']);
    expect(supaTable('fs_users').get('u2')?.skillIds).toEqual([]);
  });

  it('flag OFF: POST writes Firestore only, adapter untouched', async () => {
    const res = await POST(
      req('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: 'Guidance' }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(mockSupa.calls).toEqual([]);
  });
});

describe('POST /api/skills/assign-bulk (grant path)', () => {
  it('flag ON: batch commits in Firestore, grants mirrored onto fs_users', async () => {
    mockSupa.enabled = true;
    const res = await assignBulkPOST(
      req('http://localhost/api/skills/assign-bulk', {
        method: 'POST',
        body: JSON.stringify({ skillId: 'rocketry', userIds: ['u2'] }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.updated).toBe(1);
    expect(mockFs.users.get('u2')?.skillIds).toEqual(['avionics', 'rocketry']);
    expect(supaTable('fs_users').get('u2')?.skillIds).toEqual(['avionics', 'rocketry']);
  });

  it('flag OFF: Firestore only, adapter untouched', async () => {
    const res = await assignBulkPOST(
      req('http://localhost/api/skills/assign-bulk', {
        method: 'POST',
        body: JSON.stringify({ skillId: 'rocketry', userIds: ['u2'] }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(mockFs.users.get('u2')?.skillIds).toEqual(['avionics', 'rocketry']);
    expect(mockSupa.calls).toEqual([]);
  });

  it('mirror failure cannot fail the committed grant', async () => {
    mockSupa.enabled = true;
    mockSupa.fail = true;
    const res = await assignBulkPOST(
      req('http://localhost/api/skills/assign-bulk', {
        method: 'POST',
        body: JSON.stringify({ skillId: 'rocketry', userIds: ['u2'] }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(mockFs.users.get('u2')?.skillIds).toEqual(['avionics', 'rocketry']);
  });
});
