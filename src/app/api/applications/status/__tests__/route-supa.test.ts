/**
 * Tests for /api/applications/status under the APPS-1 Supa seam.
 *
 * - Flag OFF: Firestore serves everything; the adapter is never used
 *   (the pre-existing route.test.ts pins this behavior in detail).
 * - Flag ON: GET/POST reads come from fs_applications through
 *   src/lib/applications-supa.ts (identical payload shape), the
 *   cadetship block comes through the APPS-4 port declared in the seam,
 *   and PATCH dual-writes its applications update into the fs mirror.
 * - Flag ON + adapter error: reads fall back to Firestore.
 *
 * Both stores are in-memory fakes — zero live reads.
 */

let mockDocs: Record<string, any> = {};
let mockTokens: Record<string, { uid: string }> = {};

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function setDotPath(target: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    const applied = isSentinel(value, 'serverTimestamp') ? new Date('2026-10-20T00:00:00.000Z') : value;
    if (key.includes('.')) setDotPath(next, key, applied);
    else next[key] = applied;
  }
  return next;
}

function makeDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      const base = opts?.merge ? (mockDocs[path] ?? {}) : {};
      mockDocs[path] = applyDataToDoc(base, data);
    },
    update: async (data: any) => {
      if (mockDocs[path] === undefined) throw new Error('not-found');
      mockDocs[path] = applyDataToDoc(mockDocs[path], data);
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => makeDocRef(`${name}/${id}`),
    where: (field: string, _op: string, value: any) => ({
      limit: (n: number) => ({
        get: async () => {
          const docs = Object.entries(mockDocs)
            .filter(([path, data]) => path.startsWith(`${name}/`) && data && data[field] === value)
            .slice(0, n)
            .map(([path, data]) => ({ id: path.split('/').pop(), data: () => data }));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const decoded = mockTokens[token];
        if (!decoded) throw new Error('invalid-token');
        return decoded;
      },
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) },
    },
  },
}));

import { GET, POST, PATCH } from '../route';
import { makeReferenceId } from '@/lib/applicant-status';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';

// --- Adapter fake -----------------------------------------------------------

type SupaStore = Record<string, Map<string, Record<string, any>>>;

function makeAdapter(store: SupaStore, faults: { throwOnGet?: boolean } = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const adapter: ApplicationsSupaAdapter = {
    async getDoc(collection, id) {
      calls.push({ method: 'getDoc', args: [collection, id] });
      if (faults.throwOnGet) throw new Error('fake adapter get failure');
      const data = store[collection]?.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(collection, options = {}) {
      calls.push({ method: 'listDocs', args: [collection, options] });
      let docs: Array<Record<string, any>> = Array.from(store[collection]?.entries() ?? []).map(
        ([id, data]) => ({ id, ...data }),
      );
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') docs = docs.filter((d) => d[field] === value);
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return docs;
    },
    async countDocs(collection) {
      return store[collection]?.size ?? 0;
    },
    async setDoc(collection, id, data) {
      calls.push({ method: 'setDoc', args: [collection, id, data] });
      if (!store[collection]) store[collection] = new Map();
      store[collection].set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(collection, id, updates) {
      calls.push({ method: 'updateDoc', args: [collection, id, updates] });
      const existing = store[collection]?.get(id);
      if (!existing) throw new Error('not-found');
      const next = { ...existing, ...updates };
      store[collection].set(id, next);
      return { id, ...next };
    },
    async deleteDoc(collection, id) {
      store[collection]?.delete(id);
    },
  };
  return { adapter, calls };
}

const ALICE_UID = 'aliceuid123456';
const ALICE_EMAIL = 'alice@example.com';

function bearerRequest(token: string | null): any {
  return {
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'authorization' && token) return `Bearer ${token}`;
        return null;
      },
    },
  };
}

function bodyRequest(body: any, token: string | null = null): any {
  return { ...bearerRequest(token), json: async () => body };
}

function seedFirestoreAlice() {
  mockDocs[`applications/${ALICE_UID}`] = {
    uid: ALICE_UID,
    email: ALICE_EMAIL,
    fullName: 'Alice Firestore',
    university: 'Institute of Space Technology',
    status: 'shortlisted',
    created_at: new Date('2026-10-10T09:00:00.000Z'),
    domainPreferences: ['propulsion'],
    onboardingMilestones: { cruciblePledge: null, whatsappJoined: null, starterRepoAccess: null },
  };
  mockDocs[`users/${ALICE_UID}`] = { displayName: 'Alice Firestore' };
  mockTokens['token-alice'] = { uid: ALICE_UID };
}

/** The fs_applications mirror of Alice, as jsonb would return it. */
function seedSupaAlice(store: SupaStore, overrides: Record<string, any> = {}) {
  if (!store.applications) store.applications = new Map();
  store.applications.set(ALICE_UID, {
    uid: ALICE_UID,
    email: ALICE_EMAIL,
    fullName: 'Alice Supa',
    university: 'Institute of Space Technology',
    status: 'shortlisted',
    created_at: '2026-10-10T09:00:00.000Z',
    updated_at: '2026-10-12T15:30:00.000Z',
    resume_url: 'https://drive.google.com/file/d/alice/view',
    domainPreferences: ['propulsion'],
    onboardingMilestones: { cruciblePledge: null, whatsappJoined: null, starterRepoAccess: null },
    ...overrides,
  });
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetApplicationsSupaAdapterForTests();
  mockDocs = {};
  mockTokens = {};
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  __resetApplicationsSupaAdapterForTests();
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('GET /api/applications/status supa flag states', () => {
  test('flag OFF: Firestore serves, adapter never consulted', async () => {
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.fullName).toBe('Alice Firestore');
    expect(calls).toHaveLength(0);
  });

  test('flag ON: payload built from fs_applications with identical shape', async () => {
    process.env[ENV_KEY] = 'applications';
    // No Firestore application doc at all: only the fs mirror exists.
    mockTokens['token-alice'] = { uid: ALICE_UID };
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.referenceId).toBe(makeReferenceId(ALICE_UID));
    expect(app.fullName).toBe('Alice Supa');
    expect(app.status).toBe('shortlisted');
    expect(app.currentStageIndex).toBe(2);
    expect(app.submittedAt).toBe('2026-10-10T09:00:00.000Z');
    expect(app.documents.resumeUrl).toBe('https://drive.google.com/file/d/alice/view');
    expect(app.email).toBeUndefined();
  });

  test('flag ON: no fs row means the same 404 as a missing Firestore doc', async () => {
    process.env[ENV_KEY] = 'applications';
    mockTokens['token-alice'] = { uid: ALICE_UID };
    const { adapter } = makeAdapter({});
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No application found for this account.');
  });

  test('flag ON + adapter error: falls back to the Firestore doc', async () => {
    process.env[ENV_KEY] = 'applications';
    seedFirestoreAlice();
    const { adapter } = makeAdapter({}, { throwOnGet: true });
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(200);
    expect((await res.json()).application.fullName).toBe('Alice Firestore');
  });

  test('flag ON: cadetship block comes through the APPS-4 port (fs_cadetships)', async () => {
    process.env[ENV_KEY] = 'applications';
    mockTokens['token-alice'] = { uid: ALICE_UID };
    const store: SupaStore = {};
    seedSupaAlice(store, { status: 'approved', cadetshipId: 'cad-1' });
    store.cadetships = new Map([
      [
        'cad-1',
        {
          personUid: ALICE_UID,
          cohortId: '2027-cohort-1',
          status: 'active',
          startedAt: '2026-10-01T00:00:00.000Z',
          probationEnd: '2026-11-26T00:00:00.000Z',
          items: { orientation: { done: true }, workshops: { count: 1 }, sprintTask: { taskId: 't-1' } },
          conduct: { acknowledged: true },
        },
      ],
    ]);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.cadetship).not.toBeNull();
    expect(app.cadetship.cohortId).toBe('2027-cohort-1');
    expect(app.cadetship.cohortLabel).toBe('FY2026-27 Cohort 1');
    expect(app.cadetship.items.orientation).toBe(true);
    expect(app.legacyApproved).toBe(false);
    expect(calls.some((c) => c.method === 'listDocs' && c.args[0] === 'cadetships')).toBe(true);
  });
});

describe('POST /api/applications/status supa flag states', () => {
  test('flag ON: reference + email lookup resolves through fs_applications', async () => {
    process.env[ENV_KEY] = 'applications';
    // Firestore holds nothing; only the fs mirror can match.
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await POST(
      bodyRequest({ referenceId: makeReferenceId(ALICE_UID), email: ALICE_EMAIL }) as any,
    );
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.fullName).toBe('Alice Supa');
    expect(app.canEdit).toBe(false);
  });

  test('flag ON: wrong email still returns the generic 404 (no oracle)', async () => {
    process.env[ENV_KEY] = 'applications';
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await POST(
      bodyRequest({ referenceId: makeReferenceId(ALICE_UID), email: 'stranger@example.com' }) as any,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No application matches that reference ID and email.');
  });
});

describe('PATCH /api/applications/status dual-write', () => {
  test('flag ON: the applications update is mirrored into fs_applications', async () => {
    process.env[ENV_KEY] = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);
    // Firestore primary landed (existing behavior, users mirror included).
    expect(mockDocs[`applications/${ALICE_UID}`].domainPreferences).toEqual(['gnc']);
    expect(mockDocs[`users/${ALICE_UID}`].domainPreferences).toEqual(['gnc']);
    // The fs mirror received the same update with a serialized timestamp.
    const mirrored = store.applications.get(ALICE_UID);
    expect(mirrored?.domainPreferences).toEqual(['gnc']);
    expect(typeof mirrored?.updated_at).toBe('string');
    expect(calls.some((c) => c.method === 'setDoc' && c.args[0] === 'applications')).toBe(true);
    // Response still reflects the write.
    expect((await res.json()).application.domainPreferences).toEqual(['gnc']);
  });

  test('flag OFF: no mirror write happens', async () => {
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === 'setDoc')).toHaveLength(0);
    expect(store.applications.get(ALICE_UID)?.domainPreferences).toEqual(['propulsion']);
  });
});
