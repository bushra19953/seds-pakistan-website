/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACTS for GET /api/profile/[userId].
 *
 * There is no pre-existing suite for this route in this tree (only for
 * its telemetry subroute), so this file is the first pin of the public
 * profile contract: top-level + profile key sets, the not-found shape,
 * privacy gating of contact fields and warnings, the assignee-only
 * server-fed task list, timestamp serialisation, the sections split,
 * the 60s profile cache, and flag/fallback equivalence.
 *
 * SEAM ASSUMPTIONS (the seam does not exist in this tree yet):
 *  1. The migrated route consults the adapter through '@/lib/supa'
 *     (useSupa(surface) + getSupaClient() + getSupaAdapter()); the
 *     mock is registered via the relative specifier resolving to the
 *     same src/lib/supa location ('@/' is rewritten by the
 *     moduleNameMapper before virtual-mock resolution).
 *  2. The surface name is unknown; the mock answers from
 *     test-controlled state for ANY surface name.
 *  3. Adapter error or unconfigured client => Firestore fallback with
 *     a response identical to flag OFF.
 *
 * In THIS tree the route never imports the seam, so the mock is inert
 * and every scenario exercises the Firestore path being pinned.
 *
 * Fixture note: the route's profile cache is module-level and keyed by
 * `${userId}:${sections}` only, so each scenario uses its own userId.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

// Timestamp-like double, mirroring the Admin SDK shape the route calls
// (.toDate()) for certificates.issueDate and warnings timestamps.
const ts = (iso: string) => ({ toDate: () => new Date(iso) });

const mockSupa = { enabled: false, clientConfigured: true };

jest.mock(
  '../../../../../lib/supa',
  () => ({
    useSupa: jest.fn(() => mockSupa.enabled),
    parseSupaSurfaces: jest.fn(() => new Set()),
    getSupaClient: jest.fn(() => (mockSupa.clientConfigured ? { __mockSupaClient: true } : null)),
    getSupaAdapter: jest.fn(() => {
      const fail = async () => {
        throw new Error('mock adapter failure (Supabase unavailable)');
      };
      return { getDoc: fail, listDocs: fail, countDocs: fail, setDoc: fail, updateDoc: fail, deleteDoc: fail };
    }),
    createSupaAdapter: jest.fn(() => {
      throw new Error('mock adapter failure (Supabase unavailable)');
    }),
    resetSupaClientForTests: jest.fn(),
    SupaAdapterError: class SupaAdapterError extends Error {},
    SupaUnavailableError: class SupaUnavailableError extends Error {},
  }),
  { virtual: true },
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const state = {
  authResult: { authenticated: false } as any,
  userDocGets: 0,
  userDocSets: [] as Array<{ id: string; data: any }>,
};

const users: Row[] = [
  {
    id: 'shape-1',
    data: {
      displayName: 'Shape User', bio: 'bio', githubUrl: 'gh', linkedinUrl: 'li',
      university: 'IST', fieldOfStudy: 'CS', photoURL: 'https://x/p.jpg', bannerURL: null,
      points: 120, badges: ['badge-a'], skillIds: ['skill-x', 'rocket-science'],
      chapterId: 'ch-ist', tasksAssignedCount: 3, tasksCompletedOnTimeCount: 2, totalHoursWorked: 11,
      // NB: termsAccepted is derived from agreedToTermsAt, while the
      // termsAcceptedAt output field prefers termsAcceptedAt - both are
      // present on real user docs, so both are fixtured here.
      termsAcceptedAt: '2026-01-15T00:00:00.000Z', agreedToTermsAt: '2026-01-15T00:00:00.000Z', agreedToTermsVersion: 'v3',
      eventsAttended: ['ev-1'], displayRole: 'member', role: 'member', username: 'shape-user',
      publicDirectoryOptIn: true,
      email: 'shape@example.com', whatsappNumber: '03001112222',
      createdAt: ts('2025-06-01T10:00:00.000Z'), lastLogin: ts('2026-10-20T10:00:00.000Z'),
    },
  },
  { id: 'priv-1', data: { displayName: 'Private Person', email: 'priv@example.com', whatsappNumber: '03003334444', displayRole: 'member', role: 'member', chapterId: 'ch-ist' } },
  { id: 'own-1', data: { displayName: 'Owner Person', email: 'own@example.com', whatsappNumber: '03005556666', displayRole: 'member', role: 'member' } },
  { id: 'adm-1', data: { displayName: 'Admin Viewed', email: 'adm@example.com', whatsappNumber: '03007778888', displayRole: 'member', role: 'member' } },
  { id: 'leak-1', data: { displayName: 'Leak Person', email: 'leak@example.com', whatsappNumber: '03009990000', displayRole: 'member', role: 'member' } },
  { id: 'tasks-1', data: { displayName: 'Task Person', displayRole: 'member', role: 'member' } },
  { id: 'sec-1', data: { displayName: 'Section Person', displayRole: 'member', role: 'member' } },
  { id: 'cert-1', data: { displayName: 'Cert Person', displayRole: 'member', role: 'member' } },
  { id: 'cache-1', data: { displayName: 'Cache Person', displayRole: 'member', role: 'member', points: 5 } },
  { id: 'flag-1', data: { displayName: 'Flag Person', displayRole: 'member', role: 'member', points: 7, email: 'flag@example.com' } },
];

const roles: Row[] = [
  { id: 'admin-1', data: { role: 'president_chapter' } },
];

const projects: Row[] = [
  { id: 'p-1', data: { title: 'CubeSat', teamMemberIds: ['shape-1'] } },
  { id: 'p-2', data: { title: 'Other Project', teamMemberIds: ['someone-else'] } },
];

const tasks: Row[] = [
  { id: 't-singular', data: { title: 'Singular', assigneeId: 'tasks-1', status: 'pending', createdAt: '2026-09-01T00:00:00.000Z' } },
  { id: 't-array', data: { title: 'Array', assigneeIds: ['tasks-1', 'other-1'], status: 'pending' } },
  { id: 't-both', data: { title: 'Both forms', assigneeId: 'tasks-1', assigneeIds: ['tasks-1'], status: 'pending' } },
  { id: 't-other', data: { title: 'Not yours', assigneeId: 'someone-else', assigneeIds: ['someone-else'], status: 'pending' } },
  { id: 't-sec', data: { title: 'Section task', assigneeId: 'sec-1', status: 'pending' } },
];

const certificates: Row[] = [
  { id: 'c-1', data: { userId: 'cert-1', title: 'Fin Builder', issueDate: ts('2026-05-01T00:00:00.000Z') } },
  { id: 'c-2', data: { userId: 'cert-1', title: 'Undated' } },
  { id: 'c-3', data: { userId: 'someone-else', title: 'Not yours', issueDate: ts('2026-05-01T00:00:00.000Z') } },
];

const chapters: Row[] = [
  { id: 'ch-ist', data: { name: 'IST Chapter', isActive: true } },
  { id: 'ch-dead', data: { name: 'Dead Chapter', isActive: false } },
];

const badges: Row[] = [
  { id: 'b-1', data: { slug: 'badge-a', name: 'Trailblazer', imageUrl: 'https://x/b.png', internalNote: 'must not leak' } },
];

const skills: Row[] = [
  { id: 'skill-x', data: { name: 'Soldering', slug: 'soldering', category: 'Hardware' } },
];

const warningsByUser: Record<string, Row[]> = {
  'priv-1': [
    { id: 'w-active', data: { reason: 'Missed deadline', createdAt: ts('2026-10-01T00:00:00.000Z'), expiresAt: ts('2027-01-01T00:00:00.000Z') } },
  ],
  'own-1': [
    { id: 'w-active', data: { reason: 'Missed deadline', createdAt: ts('2026-10-01T00:00:00.000Z'), expiresAt: ts('2027-01-01T00:00:00.000Z') } },
    { id: 'w-expired', data: { reason: 'Old offence', createdAt: ts('2025-01-01T00:00:00.000Z'), expiresAt: ts('2025-06-01T00:00:00.000Z') } },
  ],
  'adm-1': [
    { id: 'w-active', data: { reason: 'Missed deadline', createdAt: ts('2026-10-01T00:00:00.000Z'), expiresAt: ts('2027-01-01T00:00:00.000Z') } },
  ],
};

const collections: Record<string, Row[]> = {
  users, roles, projects, tasks, certificates, chapters, badges, skills,
  reporting_relationships: [],
};

// ---------------------------------------------------------------------------
// Fake Firestore chain (mirrors the query shapes this route issues)
// ---------------------------------------------------------------------------
function matches(data: Row, field: string, op: string, value: any): boolean {
  if (field === '__name__') {
    if (op === 'in') return (value as string[]).includes(data.id);
    return data.id === value;
  }
  const v = data.data[field];
  if (op === '==') return v === value;
  if (op === 'in') return (value as any[]).includes(v);
  if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
  return true;
}

function makeChain(coll: string, filters: Array<[string, string, any]> = [], limitVal: number | null = null): any {
  const chain: any = {
    where: (f: string, op: string, v: any) => makeChain(coll, [...filters, [f, op, v]], limitVal),
    limit: (n: number) => makeChain(coll, filters, n),
    get: async () => {
      let matched = (collections[coll] || []).filter((r) => filters.every(([f, op, v]) => matches(r, f, op, v)));
      if (limitVal !== null) matched = matched.slice(0, limitVal);
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
  return chain;
}

const mockDb = {
  collection: (name: string) => {
    const chain = makeChain(name);
    return {
      ...chain,
      doc: (id: string) => ({
        set: async (data: any) => { state.userDocSets.push({ id, data }); },
        get: async () => {
          if (name === 'users') state.userDocGets++;
          const r = (collections[name] || []).find((x) => x.id === id);
          return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
        },
        collection: (sub: string) => {
          const getSub = async () => {
            const docs = (sub === 'warnings' ? warningsByUser[id] || [] : []).map((r) => ({ id: r.id, data: () => ({ ...r.data }) }));
            return { docs, size: docs.length, empty: docs.length === 0 };
          };
          return {
            get: getSub,
            // Read-bleed bound: the route reads warnings via
            // .limit(50).get() (no orderBy — formal warnings lack createdAt).
            orderBy: () => ({
              limit: () => ({ get: getSub }),
              get: getSub,
            }),
            limit: () => ({ get: getSub }),
          };
        },
      }),
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
  admin: { firestore: { FieldPath: { documentId: () => '__name__' } } },
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ toDate: () => new Date() }) },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/identity-cache', () => ({
  bustIdentity: jest.fn(),
}));
// Contact doorway (contact-gating fix): owner/admin contact fields are
// served from users/{uid}/private/contact via the doorway, not from the
// public user doc. The mock serves the fixtures' contact values (kept on
// the rows for shape) through the doorway instead.
jest.mock('@/lib/server/user-contact', () => {
  const actual = jest.requireActual('@/lib/user-contact-shared');
  const rowOf = (uid: string) => users.find((u: any) => u.id === uid)?.data || {};
  return {
    ...actual,
    resolveUserEmail: jest.fn(async (_db: any, uid: string) => rowOf(uid)?.email ?? null),
    resolveUserEmails: jest.fn(async (_db: any, uids: string[]) => {
      const m = new Map<string, string>();
      for (const uid of uids) if (rowOf(uid)?.email) m.set(uid, rowOf(uid).email);
      return m;
    }),
    getUserContact: jest.fn(async (_db: any, uid: string) => {
      const c = actual.pickContactFields(rowOf(uid));
      return Object.keys(c).length ? c : null;
    }),
    getUserContacts: jest.fn(async (_db: any, uids: string[]) => {
      const m = new Map<string, any>();
      for (const uid of uids) {
        const c = actual.pickContactFields(rowOf(uid));
        if (Object.keys(c).length) m.set(uid, c);
      }
      return m;
    }),
    setUserContact: jest.fn(async (_db: any, uid: string, partial: any) => {
      const row = users.find((u: any) => u.id === uid);
      if (row && typeof partial?.whatsappNumber === 'string') {
        row.data.whatsappNumber = partial.whatsappNumber;
        row.data.whatsapp = partial.whatsappNumber;
      }
    }),
    clearUserContact: jest.fn(async () => undefined),
  };
});


import { GET, PATCH } from '@/app/api/profile/[userId]/route';
import { setUserContact } from '@/lib/server/user-contact';

function req(userId: string, qs = '') {
  return new NextRequest(`http://localhost/api/profile/${userId}${qs}`);
}

async function getProfile(userId: string, qs = '') {
  const res = await GET(req(userId, qs), { params: Promise.resolve({ userId }) });
  return { res, body: await res.json() };
}

function asAnon() {
  state.authResult = { authenticated: false };
}
function asUser(uid: string, role = 'member') {
  state.authResult = { authenticated: true, user: { userId: uid, role } };
}

beforeEach(() => {
  asAnon();
  state.userDocGets = 0;
  mockSupa.enabled = false;
  mockSupa.clientConfigured = true;
  jest.clearAllMocks();
});

describe('GET /api/profile/[userId] migration contracts: shape', () => {
  it('top-level body carries exactly the pinned section keys', async () => {
    const { res, body } = await getProfile('shape-1');
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      ['badges', 'certificates', 'chapter', 'myTeam', 'profile', 'projects', 'sectionStatuses', 'skills', 'tasks', 'warnings'].sort(),
    );
    expect(res.headers.get('cache-control')).toBe('private, max-age=30, stale-while-revalidate=60');
  });

  it('the anonymous profile object carries exactly the pinned public keys (no email/whatsapp)', async () => {
    const { body } = await getProfile('shape-1');
    expect(Object.keys(body.profile).sort()).toEqual(
      [
        'agreedToToTermsVersion', 'badges', 'bannerURL', 'bio', 'chapterId', 'displayName',
        'eventsAttended', 'fieldOfStudy', 'githubUrl', 'linkedinUrl', 'photoURL', 'points',
        'publicDirectoryOptIn', 'role', 'skillIds', 'tasksAssignedCount', 'tasksCompletedOnTimeCount',
        'termsAccepted', 'termsAcceptedAt', 'totalHoursWorked', 'uid', 'university', 'username',
      ].sort(),
    );
    expect(body.profile.uid).toBe('shape-1');
    expect(body.profile.role).toBe('member');
    expect(body.profile.points).toBe(120);
    expect(body.profile.termsAccepted).toBe(true);
    expect(body.profile.termsAcceptedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(body.profile.publicDirectoryOptIn).toBe(true);
    expect(body.profile.username).toBe('shape-user');
  });

  it('TIMESTAMPS: users.createdAt and users.lastLogin never leave the API on the profile object (dropped, not serialised)', async () => {
    const { body } = await getProfile('shape-1');
    expect('createdAt' in body.profile).toBe(false);
    expect('lastLogin' in body.profile).toBe(false);
    expect(JSON.stringify(body.profile)).not.toContain('2025-06-01');
    expect(JSON.stringify(body.profile)).not.toContain('2026-10-20');
  });

  it('projects are the raw docs ({id, ...data}) for teamMemberIds matches only; chapter resolves name + active list', async () => {
    const { body } = await getProfile('shape-1');
    expect(body.projects).toEqual([{ id: 'p-1', title: 'CubeSat', teamMemberIds: ['shape-1'] }]);
    expect(body.chapter.id).toBe('ch-ist');
    expect(body.chapter.name).toBe('IST Chapter');
    expect(body.chapter.allChapters).toEqual([{ id: 'ch-ist', name: 'IST Chapter' }]);
  });

  it('badges project to exactly {slug, name, imageUrl}; skills link by doc id and orphans surface unlinked with a humanised name', async () => {
    const { body } = await getProfile('shape-1');
    expect(body.badges).toEqual([{ slug: 'badge-a', name: 'Trailblazer', imageUrl: 'https://x/b.png' }]);
    expect(body.skills).toEqual([
      { id: 'skill-x', name: 'Soldering', slug: 'soldering', category: 'Hardware' },
      { id: 'rocket-science', name: 'Rocket Science', slug: 'rocket-science', category: '', unlinked: true },
    ]);
  });
});

describe('GET /api/profile/[userId] migration contracts: not found + privacy', () => {
  it('unknown user: HTTP 200 (not 404), profile null, sectionStatuses.profile carries profile_not_found, all sections empty', async () => {
    const { res, body } = await getProfile('ghost-1');
    expect(res.status).toBe(200);
    expect(body.profile).toBeNull();
    expect(body.sectionStatuses.profile).toEqual({ success: false, error: 'User not found', errorCode: 'profile_not_found' });
    expect(body.projects).toEqual([]);
    expect(body.tasks).toEqual([]);
    expect(body.certificates).toEqual([]);
    expect(body.warnings).toEqual([]);
    expect(body.myTeam).toEqual([]);
    expect(body.chapter.name).toBeNull();
  });

  it('anonymous viewer: no email/whatsappNumber keys, and warnings are emptied even though warnings exist', async () => {
    const { body } = await getProfile('priv-1');
    expect(body.profile.displayName).toBe('Private Person');
    expect('email' in body.profile).toBe(false);
    expect('whatsappNumber' in body.profile).toBe(false);
    expect(body.warnings).toEqual([]);
    expect(body.sectionStatuses.warnings).toEqual({ success: true });
  });

  it('owner viewer: email + whatsappNumber are added, active warnings surface with ISO-serialised timestamps, expired warnings are filtered out', async () => {
    asUser('own-1');
    const { body } = await getProfile('own-1');
    expect(body.profile.email).toBe('own@example.com');
    expect(body.profile.whatsappNumber).toBe('03005556666');
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].id).toBe('w-active');
    expect(body.warnings[0].createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(body.warnings[0].expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('chapter-president requester (roles doc) is an admin viewer: contact fields + warnings visible on another user', async () => {
    asUser('admin-1', 'president_chapter');
    const { body } = await getProfile('adm-1');
    expect(body.profile.email).toBe('adm@example.com');
    expect(body.profile.whatsappNumber).toBe('03007778888');
    expect(body.warnings.map((w: any) => w.id)).toEqual(['w-active']);
  });

  it('plain member requester viewing another user gets the anonymous treatment', async () => {
    asUser('some-member', 'member');
    const { body } = await getProfile('priv-1', '?sections=extended');
    // extended-only call: profile section is not loaded (see sections
    // contract below), so assert on the warnings gate directly.
    expect(body.warnings).toEqual([]);
  });
});

describe('GET /api/profile/[userId] migration contracts: assignee-only task list', () => {
  it('tasks contain ONLY tasks assigned to the profile user (either form), deduped across both forms, with raw fields passed through untouched', async () => {
    const { body } = await getProfile('tasks-1');
    const ids = body.tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual(['t-array', 't-both', 't-singular']);
    const singular = body.tasks.find((t: any) => t.id === 't-singular');
    expect(singular).toEqual({
      id: 't-singular', title: 'Singular', assigneeId: 'tasks-1', status: 'pending',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(body.sectionStatuses.tasks).toEqual({ success: true });
  });

  it('SURPRISE (pinned current behaviour): the task list is served to anonymous viewers too - only warnings and contact fields are privacy-gated', async () => {
    asAnon();
    const { body } = await getProfile('tasks-1', '?sections=extended');
    expect(body.tasks.map((t: any) => t.id).sort()).toEqual(['t-array', 't-both', 't-singular']);
  });
});

describe('GET /api/profile/[userId] migration contracts: certificates + sections + cache', () => {
  it('certificates: issueDate Timestamp serialises to an ISO string; a missing issueDate becomes null; other users excluded', async () => {
    const { body } = await getProfile('cert-1');
    expect(body.certificates).toHaveLength(2);
    const dated = body.certificates.find((c: any) => c.id === 'c-1');
    expect(dated.issueDate).toBe('2026-05-01T00:00:00.000Z');
    const undated = body.certificates.find((c: any) => c.id === 'c-2');
    expect(undated.issueDate).toBeNull();
  });

  it('sections=core: extended sections come back empty while the profile loads', async () => {
    const { body } = await getProfile('sec-1', '?sections=core');
    expect(body.profile.displayName).toBe('Section Person');
    expect(body.tasks).toEqual([]);
    expect(body.certificates).toEqual([]);
    expect(body.warnings).toEqual([]);
    expect(body.myTeam).toEqual([]);
  });

  it('SURPRISE (pinned current behaviour): sections=extended reports sectionStatuses.profile as profile_not_found even though the user exists, while tasks still load', async () => {
    const { body } = await getProfile('sec-1', '?sections=extended');
    expect(body.profile).toBeNull();
    expect(body.sectionStatuses.profile).toEqual({ success: false, error: 'User not found', errorCode: 'profile_not_found' });
    expect(body.tasks.map((t: any) => t.id)).toEqual(['t-sec']);
  });

  it('the 60s cache serves the second identical call without re-reading the user doc, byte-identical', async () => {
    const first = await getProfile('cache-1');
    const getsAfterFirst = state.userDocGets;
    expect(getsAfterFirst).toBeGreaterThan(0);
    const second = await getProfile('cache-1');
    expect(state.userDocGets).toBe(getsAfterFirst);
    expect(second.body).toEqual(first.body);
  });

  it('SURPRISE (pinned current behaviour): the cache key has no requester component - an owner-primed cache entry is served verbatim to an anonymous viewer, contact fields included', async () => {
    asUser('leak-1');
    const ownerView = await getProfile('leak-1');
    expect(ownerView.body.profile.email).toBe('leak@example.com');

    asAnon();
    const anonView = await getProfile('leak-1');
    expect(anonView.body).toEqual(ownerView.body);
    expect(anonView.body.profile.email).toBe('leak@example.com');
  });
});

describe('GET /api/profile/[userId] migration contracts: flag / fallback equivalence', () => {
  const scenarios: Array<[string, () => void]> = [
    ['flag OFF (Firestore serves)', () => { mockSupa.enabled = false; }],
    ['flag ON + adapter error (Firestore fallback)', () => { mockSupa.enabled = true; }],
    ['flag ON + Supabase client unconfigured (Firestore fallback)', () => { mockSupa.enabled = true; mockSupa.clientConfigured = false; }],
  ];

  for (const [label, setup] of scenarios) {
    it(`${label}: response is identical to the pinned baseline`, async () => {
      setup();
      const { res, body } = await getProfile('flag-1');
      expect(res.status).toBe(200);
      expect(body.profile.uid).toBe('flag-1');
      expect(body.profile.displayName).toBe('Flag Person');
      expect(body.profile.points).toBe(7);
      expect(body.sectionStatuses.profile).toEqual({ success: true });
      expect(Object.keys(body).sort()).toEqual(
        ['badges', 'certificates', 'chapter', 'myTeam', 'profile', 'projects', 'sectionStatuses', 'skills', 'tasks', 'warnings'].sort(),
      );
    });
  }
});

describe('PATCH /api/profile/[userId] contact-gating', () => {
  it('writes whatsappNumber to the gated contact record, never to the user doc', async () => {
    asUser('own-1');
    state.userDocSets.length = 0;
    (setUserContact as jest.Mock).mockClear();
    const request = new NextRequest('http://localhost/api/profile/own-1', {
      method: 'PATCH',
      body: JSON.stringify({ whatsappNumber: '03009998888', bio: 'fresh bio' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(request, { params: Promise.resolve({ userId: 'own-1' }) });
    expect(res.status).toBe(200);
    // The doorway received the whatsapp value for the contact record.
    expect(setUserContact).toHaveBeenCalledWith(expect.anything(), 'own-1', { whatsappNumber: '03009998888' });
    // The user-doc write carries the bio but no contact field at all.
    expect(state.userDocSets).toHaveLength(1);
    const written = state.userDocSets[0].data;
    expect(written.bio).toBe('fresh bio');
    for (const k of ['whatsappNumber', 'whatsapp', 'email', 'email_lowercase', 'phone', 'phoneNumber', 'contactNumber', 'cnic', 'address']) {
      expect(k in written).toBe(false);
    }
    // The response profile's whatsappNumber is re-read from the contact
    // record (the doorway mock now holds the new number).
    const body = await res.json();
    expect(body.profile.whatsappNumber).toBe('03009998888');
    expect(body.profile.email).toBe('own@example.com');
  });
});
