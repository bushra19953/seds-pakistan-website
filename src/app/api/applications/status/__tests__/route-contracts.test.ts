/**
 * @jest-environment node
 *
 * Route-level parity contracts for /api/applications/status that the
 * APPS-1 slice suites (route.test.ts, route-supa.test.ts) leave
 * UNPINNED. Only the gaps are pinned here; behavior already covered by
 * those suites is listed in
 * ~/workspace/supabase-migration/residual-sections/apps.md instead of
 * being duplicated.
 *
 * Gaps pinned:
 *  1. POST flag ON + adapter error: the reference+email lookup falls
 *     back to the Firestore query (route-supa pins the GET fallback and
 *     the POST happy path, not the POST fallback).
 *  2. GET flag ON with MULTIPLE cadetships through the APPS-4 port: the
 *     one with the LATEST startedAt wins (design-verify §6.2 value
 *     assertion; route-supa pins a single-cadetship payload only).
 *  3. PATCH flag ON + mirror write failure: the response still
 *     succeeds and reflects the Firestore write (the seam's
 *     never-throw mirror contract, pinned at route level).
 *
 * On the base tree (feat/integration-wave3 @ 4d5a1e16) the seam module
 * src/lib/applications-supa.ts does not exist and the route does not
 * import it, so the flag-state contracts skip with that reason. They
 * activate unchanged on the merged tree where APPS-1 has landed.
 */

import * as fs from 'fs';
import * as path from 'path';

const SEAM_WIRED =
  fs.existsSync(path.join(process.cwd(), 'src/lib/applications-supa.ts')) &&
  fs
    .readFileSync(
      path.join(process.cwd(), 'src/app/api/applications/status/route.ts'),
      'utf8',
    )
    .includes('applications-supa');

const seam: any = SEAM_WIRED ? require('@/lib/applications-supa') : null;
const testFlag = SEAM_WIRED ? test : test.skip;

// --- In-memory Firestore fake (same shape as route-supa.test.ts) -----------

let mockDocs: Record<string, any> = {};
let mockTokens: Record<string, { uid: string }> = {};

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function setDotPath(target: Record<string, any>, pathStr: string, value: any): void {
  const parts = pathStr.split('.');
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

function makeDocRef(docPath: string): any {
  return {
    id: docPath.split('/').pop(),
    path: docPath,
    get: async () => {
      const data = mockDocs[docPath];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      const base = opts?.merge ? (mockDocs[docPath] ?? {}) : {};
      mockDocs[docPath] = applyDataToDoc(base, data);
    },
    update: async (data: any) => {
      if (mockDocs[docPath] === undefined) throw new Error('not-found');
      mockDocs[docPath] = applyDataToDoc(mockDocs[docPath], data);
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
            .filter(([p, data]) => p.startsWith(`${name}/`) && data && data[field] === value)
            .slice(0, n)
            .map(([p, data]) => ({ id: p.split('/').pop(), data: () => data }));
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

// --- Adapter fake -----------------------------------------------------------

type SupaStore = Record<string, Map<string, Record<string, any>>>;

function makeAdapter(
  store: SupaStore,
  faults: { throwOnList?: boolean; throwOnGet?: boolean; throwOnWrite?: boolean } = {},
) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const adapter = {
    async getDoc(collection: string, id: string) {
      calls.push({ method: 'getDoc', args: [collection, id] });
      if (faults.throwOnGet) throw new Error('fake adapter get failure');
      const data = store[collection]?.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(collection: string, options: any = {}) {
      calls.push({ method: 'listDocs', args: [collection, options] });
      if (faults.throwOnList) throw new Error('fake adapter list failure');
      let docs: Array<Record<string, any>> = Array.from(store[collection]?.entries() ?? []).map(
        ([id, data]) => ({ id, ...data }),
      );
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') docs = docs.filter((d) => d[field] === value);
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return docs;
    },
    async countDocs(collection: string) {
      return store[collection]?.size ?? 0;
    },
    async setDoc(collection: string, id: string, data: any) {
      calls.push({ method: 'setDoc', args: [collection, id, data] });
      if (faults.throwOnWrite) throw new Error('fake adapter write failure');
      if (!store[collection]) store[collection] = new Map();
      store[collection].set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(collection: string, id: string, updates: any) {
      calls.push({ method: 'updateDoc', args: [collection, id, updates] });
      if (faults.throwOnWrite) throw new Error('fake adapter write failure');
      const existing = store[collection]?.get(id);
      if (!existing) throw new Error('not-found');
      const next = { ...existing, ...updates };
      store[collection].set(id, next);
      return { id, ...next };
    },
    async deleteDoc(collection: string, id: string) {
      store[collection]?.delete(id);
    },
  };
  return { adapter, calls };
}

const ALICE_UID = 'aliceuid123456';
const ALICE_EMAIL = 'alice@example.com';
const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

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

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  seam?.__resetApplicationsSupaAdapterForTests();
  mockDocs = {};
  mockTokens = {};
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  seam?.__resetApplicationsSupaAdapterForTests();
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('contracts: /api/applications/status unpinned flag behavior', () => {
  testFlag('POST flag ON + adapter error: reference+email lookup falls back to Firestore', async () => {
    process.env[ENV_KEY] = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store); // would answer 'Alice Supa' if wrongly served
    // Both adapter reads fail: the email lookup (listDocs) AND the
    // payload read (getDoc) must each fall back to Firestore.
    const { adapter } = makeAdapter(store, { throwOnList: true, throwOnGet: true });
    seam.__setApplicationsSupaAdapterForTests(adapter);

    const res: any = await POST(
      bodyRequest({ referenceId: makeReferenceId(ALICE_UID), email: ALICE_EMAIL }) as any,
    );
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.fullName).toBe('Alice Firestore');
    expect(app.canEdit).toBe(false);
  });

  testFlag('GET flag ON: with multiple cadetships the LATEST startedAt wins', async () => {
    process.env[ENV_KEY] = 'applications';
    mockTokens['token-alice'] = { uid: ALICE_UID };
    const store: SupaStore = {};
    seedSupaAlice(store, { status: 'approved' });
    const cadetBase = {
      personUid: ALICE_UID,
      status: 'active',
      probationEnd: '2026-11-26T00:00:00.000Z',
      items: { orientation: { done: true }, workshops: { count: 1 }, sprintTask: { taskId: 't-1' } },
      conduct: { acknowledged: true },
    };
    // Older doc inserted FIRST: only the startedAt sort can pick the newer one.
    store.cadetships = new Map([
      ['cad-old', { ...cadetBase, cohortId: '2026-cohort-2', startedAt: '2025-09-01T00:00:00.000Z' }],
      ['cad-new', { ...cadetBase, cohortId: '2027-cohort-1', startedAt: '2026-10-01T00:00:00.000Z' }],
    ]);
    const { adapter } = makeAdapter(store);
    seam.__setApplicationsSupaAdapterForTests(adapter);

    const res: any = await GET(bearerRequest('token-alice'));
    expect(res.status).toBe(200);
    const app = (await res.json()).application;
    expect(app.cadetship).not.toBeNull();
    expect(app.cadetship.cohortId).toBe('2027-cohort-1');
    expect(app.cadetship.cohortLabel).toBe('FY2026-27 Cohort 1');
  });

  testFlag('PATCH flag ON + mirror write failure: response still succeeds with the Firestore write', async () => {
    process.env[ENV_KEY] = 'applications';
    seedFirestoreAlice();
    const store: SupaStore = {};
    seedSupaAlice(store);
    const { adapter } = makeAdapter(store, { throwOnWrite: true });
    seam.__setApplicationsSupaAdapterForTests(adapter);

    const res: any = await PATCH(bodyRequest({ domainPreferences: ['gnc'] }, 'token-alice') as any);
    expect(res.status).toBe(200);
    expect(mockDocs[`applications/${ALICE_UID}`].domainPreferences).toEqual(['gnc']);
    expect((await res.json()).application.domainPreferences).toEqual(['gnc']);
    // The failed mirror must not have half-applied: fs copy unchanged.
    expect(store.applications.get(ALICE_UID)?.domainPreferences).toEqual(['propulsion']);
  });
});
