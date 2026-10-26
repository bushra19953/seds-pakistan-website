/**
 * @jest-environment node
 *
 * Contract suite for APPLICATIONS write primacy (cutover, apps-1):
 *
 * - Flag law: isApplicationsSupaPrimary is true iff 'applications' is in
 *   BOTH SUPA_SURFACES and SUPA_PRIMARY; parser parity with the canonical
 *   src/lib/supa/flags.ts isSupaPrimary is pinned over the same inputs.
 * - OFF / dual-write (SUPA_PRIMARY unset): every *PrimaryFirst helper
 *   returns false and the adapter sees ZERO writes — byte-identical to
 *   the pre-cutover behavior.
 * - PRIMARY: the adapter write lands, serialized exactly like the mirror
 *   (sentinels -> ISO strings, dot-paths applied, delete markers remove
 *   keys); a failed Supa write THROWS (loud, never a silent fallback);
 *   a primary update on a missing row throws (Firestore update parity);
 *   a primary merge-set creates the row (Firestore set-merge parity).
 * - Mirror completeness helpers: mirrorApplicationSet /
 *   mirrorApplicationMergeSet never throw; the merge-set creates the fs
 *   row iff the mirrored Firestore set-merge would create the doc.
 * - fs_chapters single-writer invariant: per flow exactly one writer
 *   module, and no third adapter writer of the chapters collection
 *   exists anywhere under src/.
 *
 * Everything is mocked (in-memory adapter fake); zero live reads/writes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSupaPrimary } from '../supa/flags';
import {
  isApplicationsSupaPrimary,
  applicationsPrimaryActive,
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  setApplicationPrimaryFirst,
  updateApplicationPrimaryFirst,
  mergeSetApplicationPrimaryFirst,
  setChapterApplicationPrimaryFirst,
  updateChapterApplicationPrimaryFirst,
  mirrorApplicationSet,
  mirrorApplicationMergeSet,
  mirrorApplicationUpdate,
  SUPA_DELETE_FIELD,
  type ApplicationsSupaAdapter,
} from '../applications-supa';
import {
  __setChaptersSupaAdapterForTests,
  __resetChaptersSupaAdapterForTests,
  mirrorChapterCreate as chaptersMirrorChapterCreate,
  type ChaptersSupaAdapter,
} from '../chapters-supa';
import { mirrorChapterSet as appsMirrorChapterSet } from '../applications-supa';

// ---------------------------------------------------------------------------
// In-memory fake adapter (same shape as applications-supa.test.ts)
// ---------------------------------------------------------------------------

type Store = Record<string, Map<string, Record<string, any>>>;

function makeFakeAdapter(store: Store, faults: { throwOnSetFor?: string } = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const adapter: ApplicationsSupaAdapter & ChaptersSupaAdapter = {
    async getDoc(collection, id) {
      calls.push({ method: 'getDoc', args: [collection, id] });
      const data = store[collection]?.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(collection) {
      calls.push({ method: 'listDocs', args: [collection] });
      return Array.from(store[collection]?.entries() ?? []).map(([id, data]) => ({ id, ...data }));
    },
    async countDocs(collection) {
      return store[collection]?.size ?? 0;
    },
    async setDoc(collection, id, data) {
      calls.push({ method: 'setDoc', args: [collection, id, data] });
      if (faults.throwOnSetFor === collection) throw new Error(`fake adapter setDoc failure on ${collection}`);
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
      calls.push({ method: 'deleteDoc', args: [collection, id] });
      store[collection]?.delete(id);
    },
  };
  return { adapter, calls };
}

const savedSurfaces = process.env.SUPA_SURFACES;
const savedPrimary = process.env.SUPA_PRIMARY;

function setFlags(surfaces?: string, primary?: string) {
  if (surfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = surfaces;
  if (primary === undefined) delete process.env.SUPA_PRIMARY;
  else process.env.SUPA_PRIMARY = primary;
}

beforeEach(() => {
  __resetApplicationsSupaAdapterForTests();
  __resetChaptersSupaAdapterForTests();
});

afterEach(() => {
  setFlags(savedSurfaces, savedPrimary);
  __resetApplicationsSupaAdapterForTests();
  __resetChaptersSupaAdapterForTests();
});

// ---------------------------------------------------------------------------
// Flag law + parser parity
// ---------------------------------------------------------------------------

describe('flag law: isApplicationsSupaPrimary', () => {
  const cases: Array<[string | undefined, string | undefined, boolean]> = [
    [undefined, undefined, false],
    ['applications', undefined, false],
    [undefined, 'applications', false],
    ['applications', 'applications', true],
    ['applications', 'tasks', false],
    ['tasks', 'applications', false],
    ['*', 'applications', true],
    ['applications', '*', true],
    ['*', '*', true],
    [' Applications , Tasks ', ' APPLICATIONS ', true],
    ['', '', false],
    ['applications', '', false],
  ];

  for (const [surfaces, primary, expected] of cases) {
    test(`SUPA_SURFACES=${JSON.stringify(surfaces)} SUPA_PRIMARY=${JSON.stringify(primary)} -> ${expected} (parity with flags.ts)`, () => {
      setFlags(surfaces, primary);
      expect(isApplicationsSupaPrimary()).toBe(expected);
      // Parser parity with the canonical implementation.
      expect(isSupaPrimary('applications')).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// OFF / dual-write: primary helpers are inert
// ---------------------------------------------------------------------------

describe('dual-write state (SURFACES on, PRIMARY off): primary helpers inert', () => {
  test('all *PrimaryFirst helpers return false with ZERO adapter writes', async () => {
    setFlags('applications', undefined);
    const store: Store = { applications: new Map([['u1', { status: 'pending' }]]) };
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(applicationsPrimaryActive()).resolves.toBe(false);
    await expect(setApplicationPrimaryFirst('u2', { status: 'pending' })).resolves.toBe(false);
    await expect(updateApplicationPrimaryFirst('u1', { status: 'approved' })).resolves.toBe(false);
    await expect(mergeSetApplicationPrimaryFirst('u1', { cadetshipOutcome: 'confirmed' })).resolves.toBe(false);
    await expect(setChapterApplicationPrimaryFirst('c1', { status: 'pending_payment' })).resolves.toBe(false);
    await expect(updateChapterApplicationPrimaryFirst('c1', { status: 'x' })).resolves.toBe(false);

    expect(calls.filter((c) => c.method === 'setDoc' || c.method === 'updateDoc' || c.method === 'deleteDoc')).toHaveLength(0);
    expect(store.applications.get('u1')?.status).toBe('pending');
    expect(store.applications.has('u2')).toBe(false);
  });

  test('PRIMARY token alone (SURFACES off) is equally inert', async () => {
    setFlags(undefined, 'applications');
    const store: Store = {};
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(applicationsPrimaryActive()).resolves.toBe(false);
    await expect(setApplicationPrimaryFirst('u1', { a: 1 })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('primacy flags on but adapter absent: inactive, helpers return false (flip prereq: adapter configured)', async () => {
    setFlags('applications', 'applications');
    __setApplicationsSupaAdapterForTests(null);
    await expect(applicationsPrimaryActive()).resolves.toBe(false);
    await expect(setApplicationPrimaryFirst('u1', { a: 1 })).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PRIMARY state
// ---------------------------------------------------------------------------

describe('primary state (both flags on)', () => {
  test('set lands on the adapter, serialized like the mirror (sentinel -> ISO string)', async () => {
    setFlags('applications', 'applications');
    const store: Store = {};
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(applicationsPrimaryActive()).resolves.toBe(true);
    const written = await setChapterApplicationPrimaryFirst('c1', {
      status: 'pending_payment',
      createdAt: { __fv: 'serverTimestamp' },
    });
    expect(written).toBe(true);
    const row = store.chapter_applications.get('c1');
    expect(row?.status).toBe('pending_payment');
    expect(typeof row?.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(row?.createdAt))).toBe(false);
  });

  test('update is read-modify-write: dot-paths applied, delete markers remove keys', async () => {
    setFlags('applications', 'applications');
    const store: Store = {
      applications: new Map([
        ['u1', { status: 'pending', onboardingMilestones: { a: null, b: null }, stale: 'x' }],
      ]),
    };
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const written = await updateApplicationPrimaryFirst('u1', {
      status: 'shortlisted',
      'onboardingMilestones.a': '2026-10-26T00:00:00.000Z',
      stale: SUPA_DELETE_FIELD,
    });
    expect(written).toBe(true);
    const row = store.applications.get('u1');
    expect(row?.status).toBe('shortlisted');
    expect(row?.onboardingMilestones).toEqual({ a: '2026-10-26T00:00:00.000Z', b: null });
    expect('stale' in (row ?? {})).toBe(false);
  });

  test('a failed Supa write THROWS (loud error, never a silent fallback)', async () => {
    setFlags('applications', 'applications');
    const store: Store = { applications: new Map([['u1', { status: 'pending' }]]) };
    const { adapter } = makeFakeAdapter(store, { throwOnSetFor: 'applications' });
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(setApplicationPrimaryFirst('u2', { status: 'pending' })).rejects.toThrow(/setDoc failure/);
    await expect(updateApplicationPrimaryFirst('u1', { status: 'approved' })).rejects.toThrow(/setDoc failure/);
    await expect(mergeSetApplicationPrimaryFirst('u1', { cadetshipOutcome: 'exited' })).rejects.toThrow(/setDoc failure/);
  });

  test('primary update on a missing row throws (Firestore update parity / mirror-completeness precondition)', async () => {
    setFlags('applications', 'applications');
    const store: Store = {};
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(updateApplicationPrimaryFirst('missing', { status: 'approved' })).rejects.toThrow(/missing document/);
    expect(store.applications?.has('missing') ?? false).toBe(false);
  });

  test('primary merge-set creates the row when absent and merges when present (set-merge parity)', async () => {
    setFlags('applications', 'applications');
    const store: Store = { applications: new Map([['u1', { status: 'approved' }]]) };
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(mergeSetApplicationPrimaryFirst('u1', { cadetshipOutcome: 'confirmed' })).resolves.toBe(true);
    expect(store.applications.get('u1')).toEqual({ status: 'approved', cadetshipOutcome: 'confirmed' });

    await expect(mergeSetApplicationPrimaryFirst('u-new', { cadetshipOutcome: 'exited' })).resolves.toBe(true);
    expect(store.applications.get('u-new')).toEqual({ cadetshipOutcome: 'exited' });
  });
});

// ---------------------------------------------------------------------------
// Mirror completeness helpers (dual-write closures A6/A7)
// ---------------------------------------------------------------------------

describe('mirror completeness helpers', () => {
  test('mirrorApplicationSet writes the fs row and never throws on adapter failure', async () => {
    setFlags('applications', undefined);
    const store: Store = {};
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    await expect(mirrorApplicationSet('lead-1', { type: 'rover_starter_lead', status: 'pending' })).resolves.toBe(true);
    expect(store.applications.get('lead-1')).toEqual({ type: 'rover_starter_lead', status: 'pending' });

    const failing = makeFakeAdapter({}, { throwOnSetFor: 'applications' });
    __setApplicationsSupaAdapterForTests(failing.adapter);
    await expect(mirrorApplicationSet('lead-2', { type: 'rover_starter_lead' })).resolves.toBe(false);
  });

  test('mirrorApplicationMergeSet creates iff absent, merges iff present, never throws', async () => {
    setFlags('applications', undefined);
    const store: Store = { applications: new Map([['u1', { status: 'approved' }]]) };
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await expect(mirrorApplicationMergeSet('u1', { cadetshipOutcome: 'confirmed' })).resolves.toBe(true);
    expect(store.applications.get('u1')).toEqual({ status: 'approved', cadetshipOutcome: 'confirmed' });
    await expect(mirrorApplicationMergeSet('u-new', { cadetshipOutcome: 'exited' })).resolves.toBe(true);
    expect(store.applications.get('u-new')).toEqual({ cadetshipOutcome: 'exited' });

    const failing = makeFakeAdapter({}, { throwOnSetFor: 'applications' });
    __setApplicationsSupaAdapterForTests(failing.adapter);
    await expect(mirrorApplicationMergeSet('u1', { cadetshipOutcome: 'x' })).resolves.toBe(false);
  });

  test('mirrorApplicationUpdate on a missing row stays a silent no-write (pre-existing pin)', async () => {
    setFlags('applications', undefined);
    const store: Store = {};
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    await expect(mirrorApplicationUpdate('ghost', { status: 'approved' })).resolves.toBe(false);
    expect(calls.filter((c) => c.method === 'setDoc')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fs_chapters single-writer invariant
// ---------------------------------------------------------------------------

describe('fs_chapters single-writer invariant', () => {
  test('behavioral: the application-approval port and the chapters seam each write a chapter exactly once, through their own module only', async () => {
    setFlags('applications,chapters', undefined);
    const store: Store = {};
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter as ApplicationsSupaAdapter);
    __setChaptersSupaAdapterForTests(adapter as ChaptersSupaAdapter);

    // Application-driven create (H1) goes through the applications port.
    await appsMirrorChapterSet('seds-test', { name: 'SEDS Test', slug: 'seds-test' });
    const afterPort = calls.filter((c) => c.method === 'setDoc' && c.args[0] === 'chapters');
    expect(afterPort).toHaveLength(1);
    expect(store.chapters.get('seds-test')?.name).toBe('SEDS Test');

    // Admin-driven create (H3) goes through the chapters seam.
    await chaptersMirrorChapterCreate('seds-admin', { name: 'SEDS Admin', slug: 'seds-admin' });
    const afterAdmin = calls.filter((c) => c.method === 'setDoc' && c.args[0] === 'chapters');
    expect(afterAdmin).toHaveLength(2);
    expect(store.chapters.get('seds-admin')?.name).toBe('SEDS Admin');
  });

  test('source pin: chapter-application flows import the port from applications-supa and never chapters-supa; admin chapters routes import chapters-supa and never applications-supa', () => {
    const root = path.join(process.cwd(), 'src');
    const action = fs.readFileSync(path.join(root, 'app/actions/chapter-applications.ts'), 'utf8');
    expect(action).toMatch(/from '@\/lib\/applications-supa'/);
    expect(action).not.toMatch(/from '@\/lib\/chapters-supa'/);

    for (const rel of ['app/api/admin/chapters/route.ts', 'app/api/admin/chapters/[id]/route.ts']) {
      const route = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(route).toMatch(/from '@\/lib\/chapters-supa'/);
      expect(route).not.toMatch(/from '@\/lib\/applications-supa'/);
    }
  });

  test('source pin: no third adapter writer of the chapters collection exists under src/', () => {
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];
    const pattern = /(?:setDoc|updateDoc|deleteDoc)\(\s*(?:CHAPTERS_COLLECTION|'chapters'|"chapters")/;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (pattern.test(text)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(['lib/applications-supa.ts', 'lib/chapters-supa.ts']);
  });
});
