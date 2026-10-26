/**
 * Contract suite: PATCH /api/applications/status under APPLICATIONS
 * write primacy (cutover, apps-1).
 *
 * Exactly-one-writer assertions per flag state:
 * - PRIMARY (SUPA_SURFACES + SUPA_PRIMARY name 'applications'): the
 *   adapter write lands FIRST (shared cross-store call-order log), the
 *   Firestore update follows as the best-effort mirror; a failed Supa
 *   write fails the request (500) with ZERO Firestore writes; the
 *   pre-write read is primary-authoritative (fs-only doc is patchable,
 *   Firestore-only doc 404s).
 * - DUAL-WRITE (PRIMARY unset): Firestore lands first, the adapter
 *   write is the mirror after it — the pre-cutover order, unchanged.
 * - OFF: the adapter is never touched.
 *
 * Both stores are in-memory fakes — zero live reads.
 */

let mockDocs: Record<string, any> = {};
let mockTokens: Record<string, { uid: string }> = {};
const order: string[] = [];

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
      order.push(`firestore:set ${path}`);
      const base = opts?.merge ? (mockDocs[path] ?? {}) : {};
      mockDocs[path] = applyDataToDoc(base, data);
    },
    update: async (data: any) => {
      order.push(`firestore:update ${path}`);
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

import { PATCH } from '../route';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';

type SupaStore = Record<string, Map<string, Record<string, any>>>;

function makeAdapter(store: SupaStore, faults: { failSet?: boolean } = {}) {
  const adapter: ApplicationsSupaAdapter = {
    async getDoc(collection, id) {
      const data = store[collection]?.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(collection, options = {}) {
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
      order.push(`supa:setDoc ${collection}/${id}`);
      if (faults.failSet) throw new Error('fake adapter setDoc failure');
      if (!store[collection]) store[collection] = new Map();
      store[collection].set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(collection, id, updates) {
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
  return adapter;
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

function seedSupaAlice(store: SupaStore) {
  if (!store.applications) store.applications = new Map();
  store.applications.set(ALICE_UID, {
    uid: ALICE_UID,
    email: ALICE_EMAIL,
    fullName: 'Alice Supa',
    university: 'Institute of Space Technology',
    status: 'shortlisted',
    created_at: '2026-10-10T09:00:00.000Z',
    domainPreferences: ['propulsion'],
    onboardingMilestones: { cruciblePledge: null, whatsappJoined: null, starterRepoAccess: null },
  });
}

const savedSurfaces = process.env.SUPA_SURFACES;
const savedPrimary = process.env.SUPA_PRIMARY;

beforeEach(() => {
  mockDocs = {};
  mockTokens = {};
  order.length = 0;
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  __resetApplicationsSupaAdapterForTests();
});

afterEach(() => {
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
  if (savedPrimary === undefined) delete process.env.SUPA_PRIMARY;
  else process.env.SUPA_PRIMARY = savedPrimary;
  __resetApplicationsSupaAdapterForTests();
});

describe('PATCH /api/applications/status write primacy', () => {
  test('PRIMARY: adapter write lands FIRST, Firestore update is the mirror after it', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);

    const supaIdx = order.indexOf(`supa:setDoc applications/${ALICE_UID}`);
    const fsIdx = order.indexOf(`firestore:update applications/${ALICE_UID}`);
    expect(supaIdx).toBeGreaterThanOrEqual(0);
    expect(fsIdx).toBeGreaterThan(supaIdx);

    // Exactly one writer order: primary row holds the new value, and the
    // response is served from the primary store (fullName proves it).
    expect(store.applications.get(ALICE_UID)?.domainPreferences).toEqual(['gnc']);
    const payload = await res.json();
    expect(payload.application.fullName).toBe('Alice Supa');
    expect(payload.application.domainPreferences).toEqual(['gnc']);
    // The users mirror write is another cluster's and still lands.
    expect(mockDocs[`users/${ALICE_UID}`].domainPreferences).toEqual(['gnc']);
  });

  test('PRIMARY: a failed Supa write is a loud 500 and Firestore is NEVER written', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { failSet: true }));

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(500);
    expect(order.filter((o) => o.startsWith('firestore:update applications'))).toHaveLength(0);
    expect(store.applications.get(ALICE_UID)?.domainPreferences).toEqual(['propulsion']);
    expect(mockDocs[`applications/${ALICE_UID}`].domainPreferences).toEqual(['propulsion']);
  });

  test('PRIMARY: an fs-only application is patchable (pre-read is primary-authoritative)', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    mockTokens['token-alice'] = { uid: ALICE_UID };
    mockDocs[`users/${ALICE_UID}`] = { displayName: 'Alice' };
    const store: SupaStore = {};
    seedSupaAlice(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);
    expect(store.applications.get(ALICE_UID)?.domainPreferences).toEqual(['gnc']);
  });

  test('PRIMARY: a Firestore-only application 404s (no silent fallback to the mirror store)', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(404);
    expect(order.filter((o) => o.startsWith('firestore:update applications'))).toHaveLength(0);
  });

  test('DUAL-WRITE (PRIMARY unset): Firestore lands first, adapter write is the mirror after it', async () => {
    process.env.SUPA_SURFACES = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);
    const fsIdx = order.indexOf(`firestore:update applications/${ALICE_UID}`);
    const supaIdx = order.indexOf(`supa:setDoc applications/${ALICE_UID}`);
    expect(fsIdx).toBeGreaterThanOrEqual(0);
    expect(supaIdx).toBeGreaterThan(fsIdx);
    // Exactly one adapter write for the applications doc (the mirror).
    expect(order.filter((o) => o === `supa:setDoc applications/${ALICE_UID}`)).toHaveLength(1);
  });

  test('OFF: the adapter is never written', async () => {
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);
    expect(order.filter((o) => o.startsWith('supa:'))).toHaveLength(0);
    expect(store.applications.get(ALICE_UID)?.domainPreferences).toEqual(['propulsion']);
  });
});
