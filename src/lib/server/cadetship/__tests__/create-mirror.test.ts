/**
 * @jest-environment node
 *
 * G1 post-commit mirror tests for cadetship creation
 * (src/lib/server/cadetship/create.ts).
 *
 * The Firestore side runs against the same in-memory fake style as
 * create.test.ts; the Supabase side is the REAL hr-cadetships seam with
 * a fake adapter injected via setAdapterForTests, so the flag gate,
 * the serialization (Timestamp-like / serverTimestamp sentinel -> ISO)
 * and the never-throws mirror contract are all exercised end to end.
 * No live Firestore or Supabase calls.
 *
 * Properties under test (hr.md gap G1):
 * - flag ON: creating a cadetship mirrors the created doc, with its
 *   full F.1 shape, via mirrorCadetshipSet AFTER the transaction
 *   commits (adapter.setDoc on 'cadetships' only -- cohorts and
 *   cohort_counters are never mirrored);
 * - a mirror failure never fails the creation;
 * - flag OFF (or no adapter) = no mirror call, creation unchanged;
 * - an idempotent re-approval (created: false) mirrors nothing.
 */

jest.mock('firebase-admin', () => ({
  firestore: {
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
    FieldValue: {
      serverTimestamp: () => ({ _methodName: 'FieldValue.serverTimestamp' }),
      increment: (n: number) => ({ __increment: n }),
    },
  },
}));

import {
  allocateCohortAndCreateCadetship,
  createCadetshipFromLegacyInvite,
} from '../create';
import {
  resetAdapterForTests,
  setAdapterForTests,
  type SupaAdapter,
} from '@/lib/supa-seams/hr-cadetships';

// ------------------------------------------------------------ fake firestore
type DocData = Record<string, any>;

function applyData(existing: DocData | undefined, data: DocData): DocData {
  const out: DocData = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__increment' in v) {
      out[k] = (typeof out[k] === 'number' ? out[k] : 0) + (v as any).__increment;
    } else {
      out[k] = v;
    }
  }
  return out;
}

class FakeQuery {
  constructor(
    private store: Map<string, Map<string, DocData>>,
    private collectionName: string,
    private filters: { field: string; op: string; value: any }[] = [],
    private limitN?: number,
  ) {}
  where(field: string, op: string, value: any) {
    return new FakeQuery(this.store, this.collectionName, [...this.filters, { field, op, value }], this.limitN);
  }
  limit(n: number) {
    return new FakeQuery(this.store, this.collectionName, this.filters, n);
  }
  async get() {
    const coll = this.store.get(this.collectionName) ?? new Map();
    let docs = [...coll.entries()].map(([id, data]) => ({
      id,
      data: () => data,
      ref: new FakeDocRef(this.store, this.collectionName, id),
      exists: true,
    }));
    for (const f of this.filters) {
      docs = docs.filter((d) => {
        const v = d.data()[f.field];
        return f.op === 'in' ? (f.value as any[]).includes(v) : v === f.value;
      });
    }
    if (this.limitN) docs = docs.slice(0, this.limitN);
    return { empty: docs.length === 0, docs, forEach: (fn: any) => docs.forEach(fn) };
  }
}

class FakeDocRef {
  constructor(
    private store: Map<string, Map<string, DocData>>,
    public collectionName: string,
    public id: string,
  ) {}
  async get() {
    const data = this.store.get(this.collectionName)?.get(this.id);
    return { exists: data !== undefined, id: this.id, data: () => data };
  }
  async set(data: DocData, opts?: { merge?: boolean }) {
    const coll = this.store.get(this.collectionName) ?? new Map();
    this.store.set(this.collectionName, coll);
    coll.set(this.id, opts?.merge ? applyData(coll.get(this.id), data) : { ...data });
  }
  async update(data: DocData) {
    const coll = this.store.get(this.collectionName);
    if (!coll?.has(this.id)) throw new Error(`update on missing doc ${this.id}`);
    coll.set(this.id, applyData(coll.get(this.id), data));
  }
}

class FakeDb {
  store = new Map<string, Map<string, DocData>>();
  private autoId = 0;
  collection(name: string) {
    const self = this;
    return {
      doc: (id?: string) => new FakeDocRef(self.store, name, id ?? `auto-${++self.autoId}`),
      where: (field: string, op: string, value: any) => new FakeQuery(self.store, name).where(field, op, value),
    };
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (refOrQuery: any) => refOrQuery.get(),
      set: (ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) => ref.set(data, opts),
      update: (ref: FakeDocRef, data: DocData) => ref.update(data),
    };
    return fn(tx);
  }
  dump(collectionName: string): [string, DocData][] {
    return [...(this.store.get(collectionName) ?? new Map()).entries()];
  }
}

// ------------------------------------------------------------ fake adapter

function makeAdapter(overrides: Partial<SupaAdapter> = {}): SupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  resetAdapterForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  resetAdapterForTests();
  jest.restoreAllMocks();
});

const baseInput = {
  applicationId: 'app-1',
  chapterId: 'seds-ist-chapter',
  createdVia: 'application_approval' as const,
  startedAt: new Date('2026-10-21T12:00:00Z'),
  openedBy: 'system',
};

describe('G1 post-commit cadetship mirror', () => {
  it('mirror fires on success with the created doc full shape (flag ON)', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const db = new FakeDb();

    const out = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });

    expect(out.created).toBe(true);
    // Exactly one mirror write, on the cadetships collection only:
    // cohorts / cohort_counters stay Firestore-only per G1.
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    const [collection, id, data] = (adapter.setDoc as jest.Mock).mock.calls[0] as [
      string,
      string,
      Record<string, any>,
    ];
    expect(collection).toBe('cadetships');
    expect(id).toBe(out.cadetshipId);

    // Full F.1 shape, serialized for Supa (dates as ISO strings).
    expect(data.personUid).toBe('u1');
    expect(data.applicationId).toBe('app-1');
    expect(data.cohortId).toBe('2027-cohort-1');
    expect(data.chapterId).toBe('seds-ist-chapter');
    expect(data.createdVia).toBe('application_approval');
    expect(data.status).toBe('active');
    expect(data.startedAt).toBe('2026-10-21T12:00:00.000Z');
    expect(data.probationEnd).toBe('2026-12-16T12:00:00.000Z');
    expect(data.extendedTo).toBeNull();
    expect(data.extensionUsed).toBe(false);
    expect(data.reviewDue).toBe(false);
    expect(data.items.workshops.count).toBe(0);
    expect(data.items.orientation.attestedBy).toBeNull();
    expect(data.items.sprintTask.taskId).toBeNull();
    expect(data.conduct).toEqual({ acknowledged: false, acknowledgedAt: null });
    expect(data.duesGate.status).toBe('not_checked');
    expect(data.decision.outcome).toBeNull();
    expect(data.decision.round).toBe(1);
    expect(data.membershipClassWritePending).toBe(false);
    expect(data.evaluationReminderSentAt).toBeNull();
    expect(data.updatedBy).toBe('system');
    // serverTimestamp sentinels became ISO strings, never objects.
    expect(typeof data.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.createdAt))).toBe(false);
    expect(typeof data.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.updatedAt))).toBe(false);
  });

  it('legacy-invite creation mirrors too, stamped shortlist_redirect', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const db = new FakeDb();

    const out = await createCadetshipFromLegacyInvite(db as any, {
      personUid: 'u9',
      applicationId: baseInput.applicationId,
      chapterId: baseInput.chapterId,
      startedAt: baseInput.startedAt,
      openedBy: baseInput.openedBy,
    });

    expect(out.created).toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    const [, , data] = (adapter.setDoc as jest.Mock).mock.calls[0] as [
      string,
      string,
      Record<string, any>,
    ];
    expect(data.createdVia).toBe('shortlist_redirect');
    expect(data.personUid).toBe('u9');
  });

  it('mirror failure does not fail creation', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter({
      setDoc: jest.fn(async () => {
        throw new Error('supa down');
      }),
    });
    setAdapterForTests(adapter);
    const db = new FakeDb();

    const out = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });

    expect(out.created).toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    // Firestore remains primary and holds the created doc.
    expect(db.dump('cadetships')).toHaveLength(1);
    expect(new Map(db.dump('cadetships')).get(out.cadetshipId)!.status).toBe('active');
  });

  it('flag OFF = no mirror call, creation unchanged', async () => {
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const db = new FakeDb();

    const out = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });

    expect(out.created).toBe(true);
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(db.dump('cadetships')).toHaveLength(1);
  });

  it('flag ON but no adapter = no mirror call, creation unchanged', async () => {
    process.env[ENV_KEY] = 'cadetships';
    setAdapterForTests(null);
    const db = new FakeDb();

    const out = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });

    expect(out.created).toBe(true);
    expect(db.dump('cadetships')).toHaveLength(1);
  });

  it('idempotent re-approval (created: false) mirrors nothing new', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const db = new FakeDb();

    const first = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });
    const second = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.cadetshipId).toBe(first.cadetshipId);
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
  });
});
