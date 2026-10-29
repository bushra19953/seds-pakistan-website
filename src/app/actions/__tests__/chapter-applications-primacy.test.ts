/**
 * @jest-environment node
 *
 * Contract suite: chapter-application server actions under APPLICATIONS
 * write primacy (cutover, apps-1) — create / link-order / status /
 * delete-cleanup flows over `chapter_applications`, plus the approval
 * flow's fs_chapters write (exactly one writer, through the
 * applications seam's ChaptersWriterPort).
 *
 * Per flag state:
 * - PRIMARY: creates and the link update write the adapter FIRST
 *   (shared cross-store order log) and fail loudly ({ success: false },
 *   zero Firestore writes) when the Supa write fails; the multi-doc
 *   status/delete flows keep Firestore as the effect engine and the
 *   primary update is the commit gate (a gate failure reports
 *   { success: false }).
 * - DUAL-WRITE: Firestore first, mirror after — the pre-cutover order.
 * - OFF: the adapter is never written.
 *
 * Firestore and the consent gate are fakes/mocks, the adapter is an
 * in-memory fake — zero live reads/writes.
 */

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn(async () => undefined),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: async () => mockDbHolder.db,
  admin: {},
}));

import {
  createChapterApplication,
  linkOrderToApplication,
  updateChapterApplicationStatus,
  deleteChapterWithCleanup,
} from '@/app/actions/chapter-applications';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';
import {
  __setChaptersSupaAdapterForTests,
  __resetChaptersSupaAdapterForTests,
} from '@/lib/chapters-supa';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const order: string[] = [];

type SupaStore = Record<string, Map<string, Record<string, any>>>;

function makeAdapter(store: SupaStore, faults: { throwOnSetFor?: string } = {}) {
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
      if (faults.throwOnSetFor === collection) throw new Error(`fake adapter setDoc failure on ${collection}`);
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
      order.push(`supa:deleteDoc ${collection}/${id}`);
      store[collection]?.delete(id);
    },
  };
  return adapter;
}

const APP_DATA: Record<string, any> = {
  proposedChapterName: 'SEDS Test University',
  city: 'Lahore',
  country: 'Pakistan',
  universityName: 'Test University',
  applicantId: 'applicant-1',
  applicantEmail: 'lead@example.com',
  teamMembers: [],
  facultyAdvisor: null,
  orderId: null,
  status: 'pending_review',
};

function makeDb() {
  const writes = {
    adds: [] as Array<{ col: string; data: any }>,
    sets: [] as Array<{ col: string; id: string; data: any }>,
    updates: [] as Array<{ col: string; id: string; data: any }>,
    deletes: [] as Array<{ col: string; id: string }>,
  };
  let generated = 0;
  const docRef = (col: string, id: string): any => ({
    id,
    get: async () => {
      if (col === 'chapter_applications' && id === 'app-1') {
        return { exists: true, id, data: () => ({ ...APP_DATA }) };
      }
      if (col === 'chapters' && id === 'ch-1') {
        return { exists: true, id, data: () => ({ name: 'SEDS Test', applicationId: 'app-1' }) };
      }
      if (col === 'users') return { exists: true, id, data: () => ({ isBlacklisted: false }) };
      if (col === 'warningConfig') return { exists: true, id, data: () => ({ enforcementEnabled: true }) };
      return { exists: false, id, data: () => undefined };
    },
    set: async (data: any) => {
      order.push(`firestore:set ${col}/${id}`);
      writes.sets.push({ col, id, data });
    },
    update: async (data: any) => {
      order.push(`firestore:update ${col}/${id}`);
      writes.updates.push({ col, id, data });
    },
    delete: async () => {
      order.push(`firestore:delete ${col}/${id}`);
      writes.deletes.push({ col, id });
    },
  });
  const db = {
    __writes: writes,
    collection: (name: string) => ({
      doc: (id?: string) => docRef(name, id ?? `gen-${++generated}`),
      add: async (data: any) => {
        order.push(`firestore:add ${name}`);
        writes.adds.push({ col: name, data });
        return { id: `added-${writes.adds.length}` };
      },
      where: (..._args: any[]) => {
        const q: any = {
          where: (...a: any[]) => q,
          limit: (...a: any[]) => q,
          get: async () => ({ empty: true, docs: [] }),
        };
        return q;
      },
    }),
    batch: () => {
      throw new Error('batch not used by these fixtures (teamMembers is empty)');
    },
  };
  return db;
}

const savedSurfaces = process.env.SUPA_SURFACES;
const savedPrimary = process.env.SUPA_PRIMARY;

beforeEach(() => {
  order.length = 0;
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  __resetApplicationsSupaAdapterForTests();
  __resetChaptersSupaAdapterForTests();
  mockDbHolder.db = makeDb();
});

afterEach(() => {
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
  if (savedPrimary === undefined) delete process.env.SUPA_PRIMARY;
  else process.env.SUPA_PRIMARY = savedPrimary;
  __resetApplicationsSupaAdapterForTests();
  __resetChaptersSupaAdapterForTests();
});

function seedChapterApplication(store: SupaStore) {
  if (!store.chapter_applications) store.chapter_applications = new Map();
  store.chapter_applications.set('app-1', { ...APP_DATA });
}

const CREATE_INPUT: any = {
  applicantId: 'applicant-1',
  applicantName: 'Lead',
  applicantEmail: 'lead@example.com',
  universityName: 'Test University',
  proposedChapterName: 'SEDS Test University',
  city: 'Lahore',
  country: 'Pakistan',
  teamMembers: [
    { name: 'A', email: 'a@example.com', role: 'lead' },
    { name: 'B', email: 'b@example.com', role: 'member' },
    { name: 'C', email: 'c@example.com', role: 'member' },
    { name: 'D', email: 'd@example.com', role: 'member' },
    { name: 'E', email: 'e@example.com', role: 'member' },
  ],
  facultyAdvisor: { name: 'Prof', email: 'prof@example.com' },
  motivation: 'space',
  existingClubs: 'None',
  labFacilities: '',
  estimatedMemberCount: 20,
};

// ---------------------------------------------------------------------------
// createChapterApplication
// ---------------------------------------------------------------------------

describe('createChapterApplication primacy', () => {
  test('PRIMARY: adapter set lands FIRST under the pre-generated id; Firestore set is the mirror', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    const store: SupaStore = {};
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const result = await createChapterApplication(CREATE_INPUT);
    expect(result.success).toBe(true);
    expect(result.id).toBe('gen-1');

    const supaIdx = order.indexOf('supa:setDoc chapter_applications/gen-1');
    const fsIdx = order.indexOf('firestore:set chapter_applications/gen-1');
    expect(supaIdx).toBeGreaterThanOrEqual(0);
    expect(fsIdx).toBeGreaterThan(supaIdx);
    // The application doc itself is never .add()ed under primacy (the
    // audit_logs add is another cluster's write and still happens).
    expect(order.filter((o) => o === 'firestore:add chapter_applications')).toHaveLength(0);
    expect(store.chapter_applications.get('gen-1')?.status).toBe('pending_payment');
  });

  test('PRIMARY: a failed Supa write fails loudly — success:false and ZERO Firestore writes', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    const store: SupaStore = {};
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));

    const result = await createChapterApplication(CREATE_INPUT);
    expect(result.success).toBe(false);
    expect(order.filter((o) => o.startsWith('firestore:'))).toHaveLength(0);
  });

  test('DUAL-WRITE: Firestore .add() first, mirror after, result id is the Firestore id', async () => {
    process.env.SUPA_SURFACES = 'applications';
    const store: SupaStore = {};
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const result = await createChapterApplication(CREATE_INPUT);
    expect(result.success).toBe(true);
    expect(result.id).toBe('added-1');
    const fsIdx = order.indexOf('firestore:add chapter_applications');
    const supaIdx = order.indexOf('supa:setDoc chapter_applications/added-1');
    expect(fsIdx).toBeGreaterThanOrEqual(0);
    expect(supaIdx).toBeGreaterThan(fsIdx);
    expect(store.chapter_applications.get('added-1')?.status).toBe('pending_payment');
  });

  test('OFF: adapter never written', async () => {
    const store: SupaStore = {};
    __setApplicationsSupaAdapterForTests(makeAdapter(store));
    const result = await createChapterApplication(CREATE_INPUT);
    expect(result.success).toBe(true);
    expect(order.filter((o) => o.startsWith('supa:'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// linkOrderToApplication
// ---------------------------------------------------------------------------

describe('linkOrderToApplication primacy', () => {
  test('PRIMARY: adapter update first, Firestore after; failure is loud with zero Firestore writes', async () => {
    process.env.SUPA_SURFACES = 'applications';
    process.env.SUPA_PRIMARY = 'applications';
    const store: SupaStore = {};
    seedChapterApplication(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store));

    const ok = await linkOrderToApplication('app-1', 'order-9');
    expect(ok.success).toBe(true);
    const supaIdx = order.indexOf('supa:setDoc chapter_applications/app-1');
    const fsIdx = order.indexOf('firestore:update chapter_applications/app-1');
    expect(supaIdx).toBeGreaterThanOrEqual(0);
    expect(fsIdx).toBeGreaterThan(supaIdx);
    expect(store.chapter_applications.get('app-1')?.orderId).toBe('order-9');
    expect(store.chapter_applications.get('app-1')?.status).toBe('pending_review');

    // Failure arm.
    order.length = 0;
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));
    const bad = await linkOrderToApplication('app-1', 'order-10');
    expect(bad.success).toBe(false);
    expect(order.filter((o) => o.startsWith('firestore:'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateChapterApplicationStatus (multi-doc flow: commit gate)
// ---------------------------------------------------------------------------

describe('updateChapterApplicationStatus primacy gate', () => {
  test('PRIMARY approval: succeeds, fs row carries the new status, and the approval chapter is written to fs_chapters EXACTLY ONCE', async () => {
    process.env.SUPA_SURFACES = 'applications,chapters';
    process.env.SUPA_PRIMARY = 'applications';
    const store: SupaStore = {};
    seedChapterApplication(store);
    const adapter = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    __setChaptersSupaAdapterForTests(adapter as any);

    const result = await updateChapterApplicationStatus('app-1', 'approved', 'admin-1');
    expect(result.success).toBe(true);
    expect(result.chapterId).toBe('seds-test-university');
    expect(store.chapter_applications.get('app-1')?.status).toBe('approved');
    expect(store.chapter_applications.get('app-1')?.createdChapterId).toBe('seds-test-university');

    // fs_chapters single-writer: exactly one adapter write for the new
    // chapter, and it came through the applications port.
    const chapterWrites = order.filter((o) => o === 'supa:setDoc chapters/seds-test-university');
    expect(chapterWrites).toHaveLength(1);
    expect(store.chapters.get('seds-test-university')?.applicationId).toBe('app-1');
  });

  test('PRIMARY approval: a failing gate reports success:false (never success over stale primary state)', async () => {
    process.env.SUPA_SURFACES = 'applications,chapters';
    process.env.SUPA_PRIMARY = 'applications';
    const store: SupaStore = {};
    seedChapterApplication(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));
    __setChaptersSupaAdapterForTests(makeAdapter(store) as any);

    const result = await updateChapterApplicationStatus('app-1', 'rejected', 'admin-1');
    expect(result.success).toBe(false);
    // The Firestore effect engine already landed the update — the named
    // two-phase residual of the gate pattern.
    expect(order).toContain('firestore:update chapter_applications/app-1');
  });

  test('DUAL-WRITE approval: Firestore first, mirror after, success', async () => {
    process.env.SUPA_SURFACES = 'applications,chapters';
    const store: SupaStore = {};
    seedChapterApplication(store);
    const adapter = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    __setChaptersSupaAdapterForTests(adapter as any);

    const result = await updateChapterApplicationStatus('app-1', 'approved', 'admin-1');
    expect(result.success).toBe(true);
    const fsIdx = order.indexOf('firestore:update chapter_applications/app-1');
    const supaIdx = order.indexOf('supa:setDoc chapter_applications/app-1');
    expect(fsIdx).toBeGreaterThanOrEqual(0);
    expect(supaIdx).toBeGreaterThan(fsIdx);
    expect(store.chapter_applications.get('app-1')?.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// P1 MIRROR LOUDNESS — dual-write arms (adapter present, mirror fails)
// ---------------------------------------------------------------------------

describe('P1 mirror loudness — dual-write mirror failures are fatal', () => {
  test('DUAL create: a failing mirror set reports success:false (previously silent success)', async () => {
    process.env.SUPA_SURFACES = 'applications';
    const store: SupaStore = {};
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));

    const result = await createChapterApplication(CREATE_INPUT);
    expect(result.success).toBe(false);
    // Firestore .add() landed first (dual-write order); the failure is
    // in the mirror, and it is now reported instead of swallowed.
    expect(order).toContain('firestore:add chapter_applications');
  });

  test('DUAL link-order: a failing mirror update reports success:false', async () => {
    process.env.SUPA_SURFACES = 'applications';
    const store: SupaStore = {};
    seedChapterApplication(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));

    const result = await linkOrderToApplication('app-1', 'order-9');
    expect(result.success).toBe(false);
    expect(order).toContain('firestore:update chapter_applications/app-1');
  });

  test('DUAL status: a failing mirror update reports success:false', async () => {
    process.env.SUPA_SURFACES = 'applications';
    const store: SupaStore = {};
    seedChapterApplication(store);
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));

    const result = await updateChapterApplicationStatus('app-1', 'rejected', 'admin-1');
    expect(result.success).toBe(false);
    expect(order).toContain('firestore:update chapter_applications/app-1');
  });

  test('DUAL delete revert: a failing revert mirror reports success:false', async () => {
    process.env.SUPA_SURFACES = 'applications,chapters';
    const store: SupaStore = {};
    seedChapterApplication(store);
    if (!store.chapters) store.chapters = new Map();
    store.chapters.set('ch-1', { name: 'SEDS Test', applicationId: 'app-1' });
    __setApplicationsSupaAdapterForTests(makeAdapter(store, { throwOnSetFor: 'chapter_applications' }));
    __setChaptersSupaAdapterForTests(makeAdapter(store) as any);

    const result = await deleteChapterWithCleanup('ch-1', 'admin-1');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteChapterWithCleanup (revert gate)
// ---------------------------------------------------------------------------

describe('deleteChapterWithCleanup primacy gate', () => {
  test('PRIMARY: revert lands on the primary store and the chapter delete mirrors exactly once', async () => {
    process.env.SUPA_SURFACES = 'applications,chapters';
    process.env.SUPA_PRIMARY = 'applications';
    const store: SupaStore = {};
    seedChapterApplication(store);
    if (!store.chapters) store.chapters = new Map();
    store.chapters.set('ch-1', { name: 'SEDS Test', applicationId: 'app-1' });
    const adapter = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    __setChaptersSupaAdapterForTests(adapter as any);

    const result = await deleteChapterWithCleanup('ch-1', 'admin-1');
    expect(result.success).toBe(true);
    expect(store.chapter_applications.get('app-1')?.status).toBe('rejected');
    expect('createdChapterId' in (store.chapter_applications.get('app-1') ?? {})).toBe(false);
    expect(order.filter((o) => o === 'supa:deleteDoc chapters/ch-1')).toHaveLength(1);
    expect(store.chapters.has('ch-1')).toBe(false);
  });
});
