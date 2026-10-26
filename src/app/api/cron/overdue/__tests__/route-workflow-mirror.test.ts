/**
 * @jest-environment node
 *
 * F3 (2026-10-26 workflow-invisibility fix): the overdue cron's
 * writes for workflow-linked tasks must pass through the union
 * gate — overdue status, step unflagging (isCurrentStep false) and
 * step release (releasedAt / isCurrentStep true) — so the mirror
 * the workflow readers consult does not serve stale step state
 * after the nightly run.
 *
 * The mirror module is REAL; a fake Supabase adapter is injected
 * through its loader hook under the LIVE flag set (workflows ON,
 * tasks OFF). Firestore is an in-memory fake whose batch commits
 * apply updates to the store, so the mirror fetchers read true
 * post-commit state.
 */

import { NextRequest } from 'next/server';

// ---------- in-memory Firestore fake ----------
type DocData = Record<string, any>;

const fsStore = new Map<string, Map<string, DocData>>();

function col(name: string): Map<string, DocData> {
  if (!fsStore.has(name)) fsStore.set(name, new Map());
  return fsStore.get(name)!;
}

function makeRef(collection: string, id: string) {
  return { _col: collection, _id: id, id, path: `${collection}/${id}` };
}

function snapDoc(collection: string, id: string) {
  const data = col(collection).get(id);
  return {
    id,
    ref: makeRef(collection, id),
    exists: data !== undefined,
    data: () => data,
  };
}

function makeQuery(collection: string, clauses: Array<[string, string, any]> = [], limitN?: number) {
  const q: any = {
    where: (field: string, op: string, value: any) => makeQuery(collection, [...clauses, [field, op, value]], limitN),
    limit: (n: number) => makeQuery(collection, clauses, n),
    get: async () => {
      let docs = Array.from(col(collection).keys()).map((id) => snapDoc(collection, id));
      docs = docs.filter((d) => {
        const data = d.data() as DocData;
        return clauses.every(([field, op, value]) => {
          if (op === '==') return data[field] === value;
          if (op === 'in') return Array.isArray(value) && value.includes(data[field]);
          if (op === '!=') return data[field] !== value && data[field] !== undefined;
          return false;
        });
      });
      if (limitN != null) docs = docs.slice(0, limitN);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  return q;
}

function makeBatch() {
  const updates: Array<{ ref: any; fields: DocData }> = [];
  return {
    update: (ref: any, fields: DocData) => {
      updates.push({ ref, fields });
    },
    set: () => {},
    commit: async () => {
      for (const u of updates) {
        const existing = col(u.ref._col).get(u.ref._id) ?? {};
        col(u.ref._col).set(u.ref._id, { ...existing, ...u.fields });
      }
    },
  };
}

const fakeDb: any = {
  collection: (name: string) => {
    if (name === 'settings') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: true, data: () => ({ releaseOnOverdue: true }) }),
        }),
      };
    }
    const q = makeQuery(name);
    return {
      ...q,
      doc: (id: string) => ({
        id,
        get: async () => snapDoc(name, id),
      }),
    };
  },
  batch: () => makeBatch(),
};

jest.mock('@/lib/server/cron/g3-data', () => ({
  getG3Db: () => fakeDb,
}));

jest.mock('@/lib/server/bug4-proof-guards', () => ({
  taskHasProofUploaded: () => false,
}));

import { GET } from '../route';
import {
  __setWorkflowWriteMirrorLoaderForTests,
} from '@/lib/server/workflow-write-mirror';

// ---------- fake Supabase adapter (mirror target) ----------
const mirrorStore = new Map<string, Map<string, DocData>>();

function mirrorCol(name: string): Map<string, DocData> {
  if (!mirrorStore.has(name)) mirrorStore.set(name, new Map());
  return mirrorStore.get(name)!;
}

function injectFakeSupa() {
  __setWorkflowWriteMirrorLoaderForTests(async () => ({
    useSupa: (surface: string) => ['announcements', 'workflows'].includes(surface), // LIVE: workflows ON, tasks OFF
    getSupaClient: () => ({ fake: true }),
    getSupaAdapter: () => ({
      getDoc: async (collection: string, id: string) => {
        const doc = mirrorCol(collection).get(id);
        return doc ? { id, ...doc } : null;
      },
      listDocs: async () => [],
      countDocs: async () => 0,
      setDoc: async (collection: string, id: string, data: DocData) => {
        mirrorCol(collection).set(id, { ...data });
        return { id, ...data };
      },
      updateDoc: async () => ({ id: '' }),
      deleteDoc: async (collection: string, id: string) => {
        mirrorCol(collection).delete(id);
      },
    }),
  }));
}

const SECRET = 'test-cron-secret';
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

beforeEach(() => {
  fsStore.clear();
  mirrorStore.clear();
  injectFakeSupa();
  process.env.CRON_SECRET = SECRET;
  col('tasks').set('step-a', {
    workflowId: 'wf_cron_test', sequenceIndex: 0, isCurrentStep: true, status: 'pending', deadline: PAST,
  });
  col('tasks').set('step-b', {
    workflowId: 'wf_cron_test', sequenceIndex: 1, isCurrentStep: false, status: 'pending', deadline: FUTURE,
  });
  col('tasks').set('plain-1', { status: 'pending', deadline: PAST });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setWorkflowWriteMirrorLoaderForTests(null);
  delete process.env.CRON_SECRET;
  jest.restoreAllMocks();
});

describe('cron overdue union gate', () => {
  it('mirrors overdue + unflag + release state for workflow steps; plain tasks untouched', async () => {
    const req = new NextRequest('http://localhost/api/cron/overdue', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newlyMarked).toBe(2); // step-a + plain-1
    expect(body.stepsReleased).toBe(1); // step-b

    const mirroredA = mirrorCol('tasks').get('step-a');
    expect(mirroredA).toBeDefined();
    expect(mirroredA!.status).toBe('overdue');
    expect(mirroredA!.isCurrentStep).toBe(false); // unflagged after release

    const mirroredB = mirrorCol('tasks').get('step-b');
    expect(mirroredB).toBeDefined();
    expect(mirroredB!.isCurrentStep).toBe(true);
    expect(mirroredB!.releasedAt).toBeDefined();

    // The plain task went overdue in Firestore but is NOT mirrored
    // by the union gate (non-workflow tasks are untouched).
    expect(col('tasks').get('plain-1')!.status).toBe('overdue');
    expect(mirrorCol('tasks').has('plain-1')).toBe(false);
  });
});
