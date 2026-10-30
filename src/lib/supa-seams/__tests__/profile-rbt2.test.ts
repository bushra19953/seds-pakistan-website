/* RBT2 seam unit tests for the profile section helpers in
 * src/lib/supa-seams/profile.ts (mocked adapter only, zero live reads).
 * Each helper is gated on its OWN surface token; flag OFF or adapter
 * error => { status: 'disabled' | 'error' } and the route falls back
 * to its Firestore leg. */
import {
  tryListProjectsForUser,
  tryListCertificatesForUser,
  tryListActiveChapters,
  tryGetSkillsByIds,
  setAdapterForTests,
  resetAdapterForTests,
  type SupaAdapter,
} from '../profile';

const projects = [
  { id: 'p1', title: 'New schema', teamMemberIds: ['u-1'] },
  { id: 'p2', title: 'Legacy', team: ['u-1'] },
  { id: 'p3', title: 'Other', teamMemberIds: ['someone'] },
];
const certificates = [
  { id: 'c1', userId: 'u-1', code: 'X1' },
  { id: 'c2', userId: 'other', code: 'X2' },
];
const chapters = [
  { id: 'ch1', name: 'IST', isActive: true },
  { id: 'ch2', name: 'Old', isActive: false },
];
const skills: Record<string, any> = {
  'sk-1': { id: 'sk-1', name: 'Welding', slug: 'welding', category: 'fab' },
};

function matchesWhere(doc: any, where: any[] = []): boolean {
  return where.every(([field, op, value]) => {
    const v = doc[field];
    if (op === '==') return v === value;
    if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
    if (op === 'in') return (value as any[]).includes(v);
    return true;
  });
}

function fakeAdapter(fail = false): SupaAdapter {
  const boom = async () => { throw new Error('supa down'); };
  return {
    getDoc: fail ? (boom as any) : async (coll: string, id: string) =>
      coll === 'skills' ? skills[id] ?? null : null,
    listDocs: fail ? (boom as any) : async (coll: string, opts: any) => {
      const all = coll === 'projects' ? projects
        : coll === 'certificates' ? certificates
        : coll === 'chapters' ? chapters : [];
      const matched = all.filter((d) => matchesWhere(d, opts?.where));
      return typeof opts?.limit === 'number' ? matched.slice(0, opts.limit) : matched;
    },
    countDocs: async () => 0,
    setDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    updateDoc: async (_c: string, id: string, data: any) => ({ id, ...data }),
    deleteDoc: async () => undefined,
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

describe('RBT2 profile section helpers', () => {
  it('each helper is disabled until its OWN surface token is set', async () => {
    process.env.SUPA_SURFACES = 'profile';
    setAdapterForTests(fakeAdapter());
    await expect(tryListProjectsForUser('u-1')).resolves.toEqual({ status: 'disabled' });
    await expect(tryListCertificatesForUser('u-1')).resolves.toEqual({ status: 'disabled' });
    await expect(tryListActiveChapters()).resolves.toEqual({ status: 'disabled' });
    await expect(tryGetSkillsByIds(['sk-1'])).resolves.toEqual({ status: 'disabled' });
  });

  it('projects: new-schema leg wins; legacy leg runs only when it is empty', async () => {
    process.env.SUPA_SURFACES = 'projects';
    setAdapterForTests(fakeAdapter());
    const r = await tryListProjectsForUser('u-1');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.value.docs.map((d) => d.id)).toEqual(['p1']);
    const legacyOnly = await tryListProjectsForUser('u-legacy');
    // No doc carries u-legacy in either field in this fixture, so both
    // legs ran and the result is empty (Firestore would behave the same).
    expect(legacyOnly.status).toBe('ok');
    if (legacyOnly.status === 'ok') expect(legacyOnly.value.docs).toEqual([]);
  });

  it('projects: legacy team leg is used when teamMemberIds leg is empty', async () => {
    process.env.SUPA_SURFACES = 'projects';
    const adapter = fakeAdapter();
    const origList = adapter.listDocs.bind(adapter);
    adapter.listDocs = async (coll: string, opts: any) => {
      if (coll === 'projects' && opts?.where?.[0]?.[0] === 'team') {
        return [{ id: 'p2', title: 'Legacy', team: ['u-9'] }] as any;
      }
      return origList(coll, opts);
    };
    setAdapterForTests(adapter);
    const r = await tryListProjectsForUser('u-9');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.value.docs.map((d) => d.id)).toEqual(['p2']);
  });

  it('certificates + chapters: filtered, snapshot shape preserved', async () => {
    process.env.SUPA_SURFACES = 'certificates,chapters';
    setAdapterForTests(fakeAdapter());
    const certs = await tryListCertificatesForUser('u-1');
    expect(certs.status).toBe('ok');
    if (certs.status === 'ok') {
      expect(certs.value.docs.map((d) => d.id)).toEqual(['c1']);
      expect(certs.value.docs[0].data().code).toBe('X1');
    }
    const chs = await tryListActiveChapters();
    expect(chs.status).toBe('ok');
    if (chs.status === 'ok') expect(chs.value.docs.map((d) => d.id)).toEqual(['ch1']);
  });

  it('skills by ids: missing ids absent (orphans survive downstream)', async () => {
    process.env.SUPA_SURFACES = 'skills';
    setAdapterForTests(fakeAdapter());
    const r = await tryGetSkillsByIds(['sk-1', 'ghost-skill']);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.value.docs.map((d) => d.id)).toEqual(['sk-1']);
      expect(r.value.docs[0].data().name).toBe('Welding');
    }
  });

  it('adapter error: status error (caller falls back to Firestore)', async () => {
    process.env.SUPA_SURFACES = 'projects,certificates,chapters,skills';
    setAdapterForTests(fakeAdapter(true));
    await expect(tryListProjectsForUser('u-1')).resolves.toMatchObject({ status: 'error' });
    await expect(tryListCertificatesForUser('u-1')).resolves.toMatchObject({ status: 'error' });
    await expect(tryListActiveChapters()).resolves.toMatchObject({ status: 'error' });
    await expect(tryGetSkillsByIds(['sk-1'])).resolves.toMatchObject({ status: 'error' });
  });
});
