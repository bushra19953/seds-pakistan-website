/**
 * @jest-environment node
 *
 * Unit tests for the APPS-1 Supabase seam (src/lib/applications-supa.ts).
 * Everything is mocked: the adapter is an in-memory fake, Firestore is
 * never touched, and no live Supabase call is possible (the real adapter
 * module does not exist in this tree; resolution is injection-only here).
 */

import {
  applicationsSupaEnabled,
  resolveApplicationsSupaAdapter,
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  serializeForSupa,
  SUPA_DELETE_FIELD,
  toSeamTimestamp,
  listChapterApplications,
  getChapterApplication,
  getApplicationRecord,
  findApplicationDocsByEmail,
  tryListCadetshipsForPerson,
  chapterExistsViaSupa,
  mirrorSetDoc,
  mirrorUpdateDoc,
  mirrorChapterSet,
  runInductionSubmitGate,
  mirrorInductionFlagClear,
  APPLICATIONS_COLLECTION,
  USERS_COLLECTION,
  type ApplicationsSupaAdapter,
} from '../applications-supa';

// ---------------------------------------------------------------------------
// In-memory fake adapter over fs_* shaped stores: collection -> id -> data
// ---------------------------------------------------------------------------

type Store = Record<string, Map<string, Record<string, any>>>;

function makeFakeAdapter(store: Store, faults: { throwOn?: string } = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const maybeThrow = (method: string) => {
    if (faults.throwOn === method) throw new Error(`fake adapter ${method} failure`);
  };
  const adapter: ApplicationsSupaAdapter = {
    async getDoc(collection, id) {
      calls.push({ method: 'getDoc', args: [collection, id] });
      maybeThrow('getDoc');
      const data = store[collection]?.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(collection, options = {}) {
      calls.push({ method: 'listDocs', args: [collection, options] });
      maybeThrow('listDocs');
      let docs: Array<Record<string, any>> = Array.from(store[collection]?.entries() ?? []).map(
        ([id, data]) => ({ id, ...data }),
      );
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') docs = docs.filter((d) => d[field] === value);
      }
      const order = Array.isArray(options.orderBy) ? options.orderBy[0] : options.orderBy;
      if (order && typeof order === 'object') {
        const dir = order.direction === 'desc' ? -1 : 1;
        docs.sort((a, b) => (String(a[order.field]) < String(b[order.field]) ? -1 : 1) * dir);
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return docs;
    },
    async countDocs(collection, where) {
      calls.push({ method: 'countDocs', args: [collection, where] });
      return store[collection]?.size ?? 0;
    },
    async setDoc(collection, id, data) {
      calls.push({ method: 'setDoc', args: [collection, id, data] });
      maybeThrow('setDoc');
      if (!store[collection]) store[collection] = new Map();
      store[collection].set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(collection, id, updates) {
      calls.push({ method: 'updateDoc', args: [collection, id, updates] });
      maybeThrow('updateDoc');
      const existing = store[collection]?.get(id);
      if (!existing) throw new Error('not-found');
      const next = { ...existing, ...updates };
      store[collection].set(id, next);
      return { id, ...next };
    },
    async deleteDoc(collection, id) {
      calls.push({ method: 'deleteDoc', args: [collection, id] });
      maybeThrow('deleteDoc');
      store[collection]?.delete(id);
    },
  };
  return { adapter, calls };
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetApplicationsSupaAdapterForTests();
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

function flagOn() {
  process.env[ENV_KEY] = 'applications';
}

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

describe('applicationsSupaEnabled', () => {
  it('is OFF by default (unset, empty, other surfaces)', () => {
    expect(applicationsSupaEnabled({})).toBe(false);
    expect(applicationsSupaEnabled({ SUPA_SURFACES: '' })).toBe(false);
    expect(applicationsSupaEnabled({ SUPA_SURFACES: 'announcements,tasks' })).toBe(false);
  });

  it('is ON for the applications surface, case-insensitive, and for *', () => {
    expect(applicationsSupaEnabled({ SUPA_SURFACES: 'applications' })).toBe(true);
    expect(applicationsSupaEnabled({ SUPA_SURFACES: ' Applications ' })).toBe(true);
    expect(applicationsSupaEnabled({ SUPA_SURFACES: 'tasks,applications' })).toBe(true);
    expect(applicationsSupaEnabled({ SUPA_SURFACES: '*' })).toBe(true);
  });
});

describe('resolveApplicationsSupaAdapter', () => {
  it('returns null when the flag is OFF even with an adapter injected', async () => {
    const { adapter } = makeFakeAdapter({});
    __setApplicationsSupaAdapterForTests(adapter);
    expect(await resolveApplicationsSupaAdapter()).toBeNull();
  });

  it('returns the injected adapter when the flag is ON', async () => {
    flagOn();
    const { adapter } = makeFakeAdapter({});
    __setApplicationsSupaAdapterForTests(adapter);
    expect(await resolveApplicationsSupaAdapter()).toBe(adapter);
  });

  it('returns null when the flag is ON and absence is injected', async () => {
    flagOn();
    __setApplicationsSupaAdapterForTests(null);
    expect(await resolveApplicationsSupaAdapter()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Serialization (Firestore values -> jsonb values)
// ---------------------------------------------------------------------------

describe('serializeForSupa', () => {
  it('converts Dates and Timestamp-like values to ISO strings', () => {
    const out = serializeForSupa({
      a: new Date('2026-10-01T00:00:00.000Z'),
      b: { toDate: () => new Date('2026-10-02T00:00:00.000Z') },
      c: { _seconds: 1791000000, _nanoseconds: 500000000 },
      d: { seconds: 1791000000, nanoseconds: 0 },
    });
    expect(out.a).toBe('2026-10-01T00:00:00.000Z');
    expect(out.b).toBe('2026-10-02T00:00:00.000Z');
    expect(out.c).toBe(new Date(1791000000 * 1000 + 500).toISOString());
    expect(out.d).toBe(new Date(1791000000 * 1000).toISOString());
  });

  it('converts serverTimestamp sentinels (admin, web, and test-fake shapes) to ISO now', () => {
    const before = Date.now();
    const out = serializeForSupa({
      admin: { methodName: 'FieldValue.serverTimestamp' },
      web: { _methodName: 'serverTimestamp' },
      fake: { __fv: 'serverTimestamp' },
    });
    for (const key of ['admin', 'web', 'fake']) {
      const ms = Date.parse(out[key]);
      expect(Number.isNaN(ms)).toBe(false);
      expect(ms).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it('maps delete sentinels to SUPA_DELETE_FIELD and recurses into arrays/objects', () => {
    const out = serializeForSupa({
      gone: { methodName: 'FieldValue.delete' },
      nested: { list: [1, 'x', { at: new Date('2026-01-01T00:00:00.000Z') }] },
      plain: 42,
    });
    expect(out.gone).toBe(SUPA_DELETE_FIELD);
    expect(out.nested.list[2].at).toBe('2026-01-01T00:00:00.000Z');
    expect(out.plain).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Timestamp restore (jsonb values -> Timestamp-shaped values)
// ---------------------------------------------------------------------------

describe('toSeamTimestamp', () => {
  it('wraps ISO strings with toDate/toMillis/seconds', () => {
    const ts: any = toSeamTimestamp('2026-10-01T12:00:00.000Z');
    expect(ts.toDate().toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(ts.toMillis()).toBe(Date.parse('2026-10-01T12:00:00.000Z'));
    expect(ts.seconds).toBe(Math.floor(Date.parse('2026-10-01T12:00:00.000Z') / 1000));
  });

  it('wraps Admin dump objects and leaves nulls/non-dates untouched', () => {
    const ts: any = toSeamTimestamp({ _seconds: 1791000000, _nanoseconds: 0 });
    expect(ts.toMillis()).toBe(1791000000 * 1000);
    expect(toSeamTimestamp(null)).toBeNull();
    expect(toSeamTimestamp('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('chapter_applications reads', () => {
  function seedStore(): Store {
    return {
      chapter_applications: new Map([
        ['app-old', { status: 'approved', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }],
        ['app-new', { status: 'pending_review', createdAt: '2026-10-01T00:00:00.000Z', reviewedAt: { _seconds: 1791000000, _nanoseconds: 0 } }],
      ]),
    };
  }

  it('listChapterApplications orders desc, limits 100, and restores timestamps', async () => {
    const { adapter, calls } = makeFakeAdapter(seedStore());
    const docs = await listChapterApplications(adapter, null);
    expect(docs.map((d) => d.id)).toEqual(['app-new', 'app-old']);
    expect(calls[0].args[1]).toMatchObject({ limit: 100, orderBy: { field: 'createdAt', direction: 'desc' } });
    expect(docs[0].createdAt.toDate().toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(docs[0].reviewedAt.toMillis()).toBe(1791000000 * 1000);
    expect(docs[1].updatedAt.toDate().toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('listChapterApplications passes a status filter, and treats "all" as none', async () => {
    const { adapter, calls } = makeFakeAdapter(seedStore());
    const filtered = await listChapterApplications(adapter, 'approved');
    expect(filtered.map((d) => d.id)).toEqual(['app-old']);
    expect(calls[0].args[1].where).toEqual([['status', '==', 'approved']]);

    const { adapter: adapter2, calls: calls2 } = makeFakeAdapter(seedStore());
    await listChapterApplications(adapter2, 'all');
    expect(calls2[0].args[1].where).toBeUndefined();
  });

  it('getChapterApplication returns the doc or null', async () => {
    const { adapter } = makeFakeAdapter(seedStore());
    const doc = await getChapterApplication(adapter, 'app-old');
    expect(doc?.id).toBe('app-old');
    expect(doc?.createdAt.toDate().toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(await getChapterApplication(adapter, 'missing')).toBeNull();
  });
});

describe('applications reads', () => {
  it('getApplicationRecord returns raw data without the id, or null', async () => {
    const store: Store = {
      applications: new Map([['uid-1', { status: 'shortlisted', created_at: '2026-10-10T09:00:00.000Z' }]]),
    };
    const { adapter } = makeFakeAdapter(store);
    const record = await getApplicationRecord(adapter, 'uid-1');
    expect(record).toEqual({ status: 'shortlisted', created_at: '2026-10-10T09:00:00.000Z' });
    expect(await getApplicationRecord(adapter, 'nobody')).toBeNull();
  });

  it('findApplicationDocsByEmail queries email with limit 5', async () => {
    const store: Store = {
      applications: new Map([
        ['uid-1', { email: 'a@example.com' }],
        ['uid-2', { email: 'b@example.com' }],
      ]),
    };
    const { adapter, calls } = makeFakeAdapter(store);
    const docs = await findApplicationDocsByEmail(adapter, 'a@example.com');
    expect(docs.map((d) => d.id)).toEqual(['uid-1']);
    expect(calls[0].args[1]).toEqual({ where: [['email', '==', 'a@example.com']], limit: 5 });
  });
});

// ---------------------------------------------------------------------------
// Cross-seam ports
// ---------------------------------------------------------------------------

describe('cadetships read port (APPS-4 seam, local interface)', () => {
  it('returns cadetship data with startedAt restored for toMillis sorting', async () => {
    flagOn();
    const store: Store = {
      cadetships: new Map([
        ['cad-1', { personUid: 'uid-1', cohortId: '2027-cohort-1', startedAt: '2026-10-01T00:00:00.000Z', status: 'active' }],
        ['cad-2', { personUid: 'someone-else', startedAt: '2026-10-01T00:00:00.000Z' }],
      ]),
    };
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    const docs = await tryListCadetshipsForPerson('uid-1');
    expect(docs).toHaveLength(1);
    expect(docs?.[0].cohortId).toBe('2027-cohort-1');
    expect(docs?.[0].startedAt.toMillis()).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
    expect(calls[0].args[0]).toBe('cadetships');
    expect(calls[0].args[1]).toEqual({ where: [['personUid', '==', 'uid-1']], limit: 5 });
  });

  it('returns null (Firestore fallback signal) when flag OFF or adapter errors', async () => {
    const store: Store = { cadetships: new Map() };
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    expect(await tryListCadetshipsForPerson('uid-1')).toBeNull(); // flag OFF

    flagOn();
    const { adapter: broken } = makeFakeAdapter(store, { throwOn: 'listDocs' });
    __setApplicationsSupaAdapterForTests(broken);
    expect(await tryListCadetshipsForPerson('uid-1')).toBeNull(); // adapter error
  });
});

describe('chapters writer port (APPS-3 seam, local interface)', () => {
  it('chapterExistsViaSupa answers from fs_chapters and nulls on error', async () => {
    flagOn();
    const store: Store = { chapters: new Map([['seds-ist', { name: 'SEDS IST' }]]) };
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    expect(await chapterExistsViaSupa('seds-ist')).toBe(true);
    expect(await chapterExistsViaSupa('nope')).toBe(false);

    const { adapter: broken } = makeFakeAdapter(store, { throwOn: 'getDoc' });
    __setApplicationsSupaAdapterForTests(broken);
    expect(await chapterExistsViaSupa('seds-ist')).toBeNull();
  });

  it('mirrorChapterSet writes the serialized chapter through the port', async () => {
    flagOn();
    const store: Store = {};
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    const ok = await mirrorChapterSet('seds-new', {
      name: 'SEDS New',
      createdAt: { methodName: 'FieldValue.serverTimestamp' },
    });
    expect(ok).toBe(true);
    const setCall = calls.find((c) => c.method === 'setDoc');
    expect(setCall?.args[0]).toBe('chapters');
    expect(setCall?.args[1]).toBe('seds-new');
    expect(setCall?.args[2].name).toBe('SEDS New');
    expect(typeof setCall?.args[2].createdAt).toBe('string');
    expect(store.chapters.get('seds-new')?.name).toBe('SEDS New');
  });
});

// ---------------------------------------------------------------------------
// Mirror writes
// ---------------------------------------------------------------------------

describe('mirror writes', () => {
  it('mirrorSetDoc serializes and no-ops (false) when the flag is OFF', async () => {
    const store: Store = {};
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    expect(await mirrorSetDoc('chapter_applications', 'a1', { x: 1 })).toBe(false);
    expect(calls).toHaveLength(0);

    flagOn();
    expect(
      await mirrorSetDoc('chapter_applications', 'a1', {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        gone: { methodName: 'FieldValue.delete' },
      }),
    ).toBe(true);
    expect(store.chapter_applications.get('a1')).toEqual({ createdAt: '2026-10-01T00:00:00.000Z' });
  });

  it('mirrorUpdateDoc applies dot-paths, sentinels, and deletes via read-modify-write', async () => {
    flagOn();
    const store: Store = {
      applications: new Map([
        ['uid-1', { status: 'shortlisted', onboardingMilestones: { cruciblePledge: null, whatsappJoined: null } }],
      ]),
    };
    const { adapter } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    const ok = await mirrorUpdateDoc('applications', 'uid-1', {
      domainPreferences: ['gnc'],
      updated_at: { __fv: 'serverTimestamp' },
      'onboardingMilestones.cruciblePledge': { __fv: 'serverTimestamp' },
    });
    expect(ok).toBe(true);
    const stored = store.applications.get('uid-1');
    expect(stored?.domainPreferences).toEqual(['gnc']);
    expect(typeof stored?.updated_at).toBe('string');
    expect(typeof stored?.onboardingMilestones.cruciblePledge).toBe('string');
    expect(stored?.onboardingMilestones.whatsappJoined).toBeNull();

    const okDelete = await mirrorUpdateDoc('applications', 'uid-1', {
      domainPreferences: SUPA_DELETE_FIELD,
    });
    expect(okDelete).toBe(true);
    expect('domainPreferences' in (store.applications.get('uid-1') ?? {})).toBe(false);
  });

  it('mirrorUpdateDoc writes nothing and returns false for a missing row or adapter error', async () => {
    flagOn();
    const store: Store = { applications: new Map() };
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);
    expect(await mirrorUpdateDoc('applications', 'ghost', { x: 1 })).toBe(false);
    expect(calls.filter((c) => c.method === 'setDoc')).toHaveLength(0);

    const { adapter: broken } = makeFakeAdapter(store, { throwOn: 'getDoc' });
    __setApplicationsSupaAdapterForTests(broken);
    expect(await mirrorUpdateDoc('applications', 'ghost', { x: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Induction submit gate (tx_applications_submit_gate) + flag-clear mirror
//
// The gate resolver checks the INJECTED adapter first, so these tests
// need no SUPA_SURFACES flag: beforeEach above leaves it unset. The
// flag-clear mirror goes through mirrorMergeSetDoc, whose resolver
// does honor the flag, so its test turns the flag on explicitly.
// ---------------------------------------------------------------------------

describe('runInductionSubmitGate', () => {
  const applicationData = {
    fullName: 'User One',
    status: 'pending',
    created_at: { __fv: 'serverTimestamp' },
    updated_at: { methodName: 'FieldValue.serverTimestamp' },
  };

  it('collection constants name the fs tables the gate reads', () => {
    expect(APPLICATIONS_COLLECTION).toBe('applications');
    expect(USERS_COLLECTION).toBe('users');
  });

  it('makes exactly one tx call named tx_applications_submit_gate with p_uid and the serialized application', async () => {
    const tx = jest.fn(async () => ({
      outcome: 'created',
      applied: true,
      existing_status: null,
      prior_app: null,
      prior_user: null,
    }));
    const { adapter } = makeFakeAdapter({});
    (adapter as any).tx = tx;
    __setApplicationsSupaAdapterForTests(adapter);

    const before = Date.now();
    const result = await runInductionSubmitGate('uid-1', applicationData);

    expect(tx).toHaveBeenCalledTimes(1);
    const [fnName, args] = tx.mock.calls[0] as unknown as [string, any];
    expect(fnName).toBe('tx_applications_submit_gate');
    expect(Object.keys(args).sort()).toEqual(['p_application', 'p_uid']);
    expect(args.p_uid).toBe('uid-1');
    expect(args.p_application.fullName).toBe('User One');
    expect(args.p_application.status).toBe('pending');
    // serverTimestamp sentinels (both fake shapes used in this repo)
    // reach the tx as ISO strings, never as sentinel objects.
    for (const key of ['created_at', 'updated_at']) {
      expect(typeof args.p_application[key]).toBe('string');
      const ms = Date.parse(args.p_application[key]);
      expect(Number.isNaN(ms)).toBe(false);
      expect(ms).toBeGreaterThanOrEqual(before - 1000);
    }
    // Raw snake_case result maps to the camelCase gate result.
    expect(result).toEqual({
      outcome: 'created',
      applied: true,
      existingStatus: null,
      priorApp: null,
      priorUser: null,
    });
  });

  it('maps an already_applied raw result through, including existing_status and the priors', async () => {
    const tx = jest.fn(async () => ({
      outcome: 'already_applied',
      applied: false,
      existing_status: 'approved',
      prior_app: { status: 'approved', fullName: 'Original' },
      prior_user: { hasApplied: true, applicationStatus: 'approved' },
    }));
    const { adapter } = makeFakeAdapter({});
    (adapter as any).tx = tx;
    __setApplicationsSupaAdapterForTests(adapter);

    const result = await runInductionSubmitGate('uid-1', applicationData);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: 'already_applied',
      applied: false,
      existingStatus: 'approved',
      priorApp: { status: 'approved', fullName: 'Original' },
      priorUser: { hasApplied: true, applicationStatus: 'approved' },
    });
  });

  it('throws when the injected adapter has no tx primitive', async () => {
    const { adapter } = makeFakeAdapter({});
    __setApplicationsSupaAdapterForTests(adapter);
    await expect(runInductionSubmitGate('uid-1', applicationData)).rejects.toThrow();
  });

  it('throws when the injected adapter is null (absence)', async () => {
    __setApplicationsSupaAdapterForTests(null);
    await expect(runInductionSubmitGate('uid-1', applicationData)).rejects.toThrow();
  });
});

describe('mirrorInductionFlagClear', () => {
  it('merge-writes hasApplied:false, applicationStatus:null and an ISO updatedAt onto the fs_users row', async () => {
    flagOn();
    const store: Store = {
      users: new Map([
        ['uid-1', { hasApplied: true, applicationStatus: 'rejected', displayName: 'User One' }],
      ]),
    };
    const { adapter, calls } = makeFakeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    await mirrorInductionFlagClear('uid-1');

    const row = store.users.get('uid-1');
    expect(row?.hasApplied).toBe(false);
    expect(row?.applicationStatus).toBeNull();
    expect(typeof row?.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(row?.updatedAt))).toBe(false);
    // Merge semantics: unrelated fields on the row survive.
    expect(row?.displayName).toBe('User One');
    // The write went through the adapter's getDoc/setDoc pair over
    // the users collection (read-modify-write).
    expect(calls.filter((c) => c.method === 'getDoc').map((c) => c.args)).toEqual([['users', 'uid-1']]);
    const setCall = calls.find((c) => c.method === 'setDoc');
    expect(setCall?.args[0]).toBe('users');
    expect(setCall?.args[1]).toBe('uid-1');
  });
});
