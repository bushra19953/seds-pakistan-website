/**
 * Cadetship creation tests (spec F.1/F.2/F.6) against a small in-memory
 * Firestore fake. The properties under test: SAME-cohort allocation under
 * sequential first approvals (the transaction serialises them), cadetCount
 * increments, idempotent re-approval, supersede of a prior exited record,
 * and the batch variant queueing every write into the approval batch.
 */

jest.mock('firebase-admin', () => ({
  firestore: {
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
    FieldValue: {
      serverTimestamp: () => '__server_ts__',
      increment: (n: number) => ({ __increment: n }),
    },
  },
}));

import {
  allocateCohortAndCreateCadetship,
  queueCadetshipEnrolmentInBatch,
} from '../create';

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

class FakeBatch {
  ops: { ref: FakeDocRef; data: DocData; mode: 'set' | 'update'; merge?: boolean }[] = [];
  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) {
    this.ops.push({ ref, data, mode: 'set', merge: opts?.merge });
  }
  update(ref: FakeDocRef, data: DocData) {
    this.ops.push({ ref, data, mode: 'update' });
  }
  async commit() {
    for (const op of this.ops) {
      if (op.mode === 'set') await op.ref.set(op.data, { merge: op.merge });
      else await op.ref.update(op.data);
    }
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
  batch() {
    return new FakeBatch();
  }
  dump(collectionName: string): [string, DocData][] {
    return [...(this.store.get(collectionName) ?? new Map()).entries()];
  }
}

const baseInput = {
  applicationId: 'app-1',
  chapterId: 'seds-ist-chapter',
  createdVia: 'application_approval' as const,
  startedAt: new Date('2026-10-21T12:00:00Z'),
  openedBy: 'system',
};

describe('allocateCohortAndCreateCadetship (transaction version)', () => {
  it('two first approvals in the same FY land in the SAME cohort with cadetCount 2', async () => {
    const db = new FakeDb();
    const a = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });
    const b = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u2' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.cohortId).toBe('2027-cohort-1');
    expect(b.cohortId).toBe('2027-cohort-1');
    const cohorts = db.dump('cohorts');
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0][1].cadetCount).toBe(2);
    expect(db.dump('cadetships')).toHaveLength(2);
  });

  it('idempotent: re-approving the same person creates nothing new', async () => {
    const db = new FakeDb();
    const first = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });
    const second = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });
    expect(second.created).toBe(false);
    expect(second.cadetshipId).toBe(first.cadetshipId);
    expect(db.dump('cadetships')).toHaveLength(1);
    expect(db.dump('cohorts')[0][1].cadetCount).toBe(1);
  });

  it('a prior exited cadetship is superseded by the new enrolment', async () => {
    const db = new FakeDb();
    const coll = new Map<string, DocData>();
    coll.set('old-1', { personUid: 'u1', status: 'exited', cohortId: '2026-cohort-1' });
    db.store.set('cadetships', coll);
    const out = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });
    expect(out.created).toBe(true);
    const byId = new Map(db.dump('cadetships'));
    expect(byId.get('old-1')!.status).toBe('superseded');
    expect(byId.get(out.cadetshipId)!.status).toBe('active');
  });

  it('the cadetship doc carries the F.1 shape: 56-day window, empty checklist, open decision', async () => {
    const db = new FakeDb();
    const out = await allocateCohortAndCreateCadetship(db as any, { ...baseInput, personUid: 'u1' });
    const doc = new Map(db.dump('cadetships')).get(out.cadetshipId)!;
    expect(doc.status).toBe('active');
    expect(doc.probationEnd.toDate().toISOString()).toBe('2026-12-16T12:00:00.000Z');
    expect(doc.items.workshops.count).toBe(0);
    expect(doc.items.orientation.attestedBy).toBeNull();
    expect(doc.items.sprintTask.taskId).toBeNull();
    expect(doc.conduct.acknowledged).toBe(false);
    expect(doc.decision.outcome).toBeNull();
    expect(doc.decision.round).toBe(1);
    expect(doc.duesGate.status).toBe('not_checked');
    expect(doc.extensionUsed).toBe(false);
  });
});

describe('queueCadetshipEnrolmentInBatch (approval-batch version)', () => {
  it('queues cohort + counter + cadetship writes into the SAME batch', async () => {
    const db = new FakeDb();
    const batch = db.batch();
    const out = await queueCadetshipEnrolmentInBatch(db as any, batch as any, {
      ...baseInput,
      personUid: 'u1',
    });
    expect(out.created).toBe(true);
    expect(out.cohortId).toBe('2027-cohort-1');
    expect(batch.ops.length).toBeGreaterThanOrEqual(3);
    await batch.commit();
    expect(db.dump('cadetships')).toHaveLength(1);
    expect(db.dump('cohorts')[0][1].cadetCount).toBe(1);
  });

  it('returns the queued cadetship body as cadetshipData (for the caller post-commit mirror)', async () => {
    const db = new FakeDb();
    const batch = db.batch();
    const out = await queueCadetshipEnrolmentInBatch(db as any, batch as any, {
      ...baseInput,
      personUid: 'u1',
    });
    expect(out.created).toBe(true);
    // The returned body is exactly the body queued for cadetships/{id}:
    // the universal-review route mirrors THIS object after commit.
    const queued = batch.ops.find(
      (op) => op.ref.collectionName === 'cadetships' && op.ref.id === out.cadetshipId,
    );
    expect(queued).toBeDefined();
    expect(out.cadetshipData).toBe(queued!.data);
    expect(out.cadetshipData!.personUid).toBe('u1');
    expect(out.cadetshipData!.applicationId).toBe('app-1');
    expect(out.cadetshipData!.cohortId).toBe(out.cohortId);
    expect(out.cadetshipData!.status).toBe('active');
    expect(out.cadetshipData!.createdVia).toBe('application_approval');
  });

  it('idempotent re-queue (created: false) returns no cadetshipData', async () => {
    const db = new FakeDb();
    const batch1 = db.batch();
    const first = await queueCadetshipEnrolmentInBatch(db as any, batch1 as any, {
      ...baseInput,
      personUid: 'u1',
    });
    await batch1.commit();
    const batch2 = db.batch();
    const second = await queueCadetshipEnrolmentInBatch(db as any, batch2 as any, {
      ...baseInput,
      personUid: 'u1',
    });
    expect(second.created).toBe(false);
    expect(second.cadetshipId).toBe(first.cadetshipId);
    expect(second.cadetshipData).toBeUndefined();
  });
});
