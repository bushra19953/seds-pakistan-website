/**
 * @jest-environment node
 *
 * Consents mirror + seam (2026-10-30; census 15 G3–G8):
 *  - FLAG ON + Firestore POISONED (every entry point throws): every
 *    consent read entry point serves from the mirror — getRequest,
 *    listMyRequests (+ cursor), listInbox, listRegister,
 *    getDecidedConsent (service, by-id and by-matter), the lookup's
 *    getDecidedConsent / listDecidedConsentCandidates /
 *    listDecidedConsentsForAct (candidates + both filed arms), and
 *    the history read.
 *  - FLAG OFF: the seam is never consulted (zero adapter reads) and
 *    the Firestore path serves exactly as before.
 *  - listInbox's Firestore fallback carries the new limit(200) on
 *    BOTH arms (the census G4 unbounded fix).
 *  - DUAL-WRITE: createDraft / submitRequest / decideRequest mirror
 *    payloads equal the Firestore-bound docs (compared after the
 *    mirror serializer), and history appends mirror to
 *    fs_consent_requests_history; consumeConsent mirrors its stamp.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { FOUNDER_UID } from '@/lib/roles';
import { createFakeDb, type FakeDb } from './fake-firestore';
import { serializeForSupa } from '@/lib/applications-supa';
import {
  __resetConsentsHistoryClientForTests,
  __resetConsentsSupaAdapterForTests,
  __setConsentsHistoryClientForTests,
  __setConsentsSupaAdapterForTests,
  listConsentHistoryViaSeam,
  type ConsentsSupaAdapter,
} from '@/lib/server/consents-supa';
import {
  createDraft,
  decideRequest,
  getDecidedConsent as getDecidedConsentSvc,
  getRequest,
  listInbox,
  listMyRequests,
  listRegister,
  submitRequest,
} from '@/lib/server/consent-service';
import {
  consumeConsent,
  getDecidedConsent as getDecidedConsentLookup,
  listDecidedConsentCandidates,
  listDecidedConsentsForAct,
} from '@/lib/server/consent-lookup';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

/* ------------------------------------------------------------ fakes */

const ISO = (day: number) => new Date(Date.UTC(2026, 9, day, 10, 0, 0)).toISOString();

function compareVals(a: any, b: any): number {
  const ma = a instanceof Date ? a.getTime() : typeof a === 'string' ? Date.parse(a) || a : a;
  const mb = b instanceof Date ? b.getTime() : typeof b === 'string' ? Date.parse(b) || b : b;
  if (ma < mb) return -1;
  if (ma > mb) return 1;
  return 0;
}

interface FakeAdapter extends ConsentsSupaAdapter {
  store: Map<string, Record<string, any>>;
  calls: { getDoc: number; listDocs: number; setDoc: number; updateDoc: number; deleteDoc: number };
  setCalls: Array<{ id: string; data: any }>;
  updateCalls: Array<{ id: string; data: any }>;
}

function makeAdapter(seed: Array<{ id: string; data: Record<string, any> }> = []): FakeAdapter {
  const store = new Map(seed.map((s) => [s.id, { ...s.data }]));
  const calls = { getDoc: 0, listDocs: 0, setDoc: 0, updateDoc: 0, deleteDoc: 0 };
  const setCalls: Array<{ id: string; data: any }> = [];
  const updateCalls: Array<{ id: string; data: any }> = [];
  return {
    store,
    calls,
    setCalls,
    updateCalls,
    async getDoc(_c: string, id: string) {
      calls.getDoc += 1;
      const data = store.get(id);
      return data ? { id, ...JSON.parse(JSON.stringify(data)) } : null;
    },
    async listDocs(_c: string, options: any = {}) {
      calls.listDocs += 1;
      let docs = [...store.entries()].map(([id, data]) => ({ id, ...data }));
      for (const [field, op, value] of options.where ?? []) {
        docs = docs.filter((d) => {
          const v = (d as any)[field];
          switch (op) {
            case '==': return v === value;
            case 'in': return Array.isArray(value) && value.includes(v);
            case '>=': return compareVals(v, value) >= 0;
            case '<=': return compareVals(v, value) <= 0;
            default: throw new Error(`fake adapter: op ${op}`);
          }
        });
      }
      const order = Array.isArray(options.orderBy) ? options.orderBy[0] : options.orderBy;
      if (order && typeof order === 'object') {
        docs = docs.filter((d) => (d as any)[order.field] !== undefined);
        docs.sort((a, b) => {
          const c = compareVals((a as any)[order.field], (b as any)[order.field]);
          return order.direction === 'desc' ? -c : c;
        });
      }
      if (options.startAfter !== undefined) {
        const cursorMs =
          typeof options.startAfter?.toMillis === 'function'
            ? options.startAfter.toMillis()
            : Date.parse(String(options.startAfter));
        const field = order?.field ?? 'createdAt';
        docs = docs.filter((d) => {
          const ms = Date.parse(String((d as any)[field]));
          return order?.direction === 'desc' ? ms < cursorMs : ms > cursorMs;
        });
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return JSON.parse(JSON.stringify(docs));
    },
    async setDoc(_c: string, id: string, data: Record<string, any>) {
      calls.setDoc += 1;
      setCalls.push({ id, data: JSON.parse(JSON.stringify(data)) });
      store.set(id, JSON.parse(JSON.stringify(data)));
      return { id, ...data };
    },
    async updateDoc(_c: string, id: string, updates: Record<string, any>) {
      calls.updateDoc += 1;
      updateCalls.push({ id, data: JSON.parse(JSON.stringify(updates)) });
      const existing = store.get(id);
      if (!existing) throw new Error(`fake adapter: update on missing ${id}`);
      const next = { ...existing, ...updates };
      store.set(id, next);
      return { id, ...next };
    },
    async deleteDoc(_c: string, id: string) {
      calls.deleteDoc += 1;
      store.delete(id);
    },
  };
}

function makeHistoryClient() {
  const rows = new Map<string, Record<string, any>>();
  const upserts: Array<{ row: any; opts: any }> = [];
  const key = (parent: string, id: string) => `${parent}|${id}`;
  const client = {
    from(_table: string) {
      return {
        select() {
          const filters: Record<string, any> = {};
          const chain: any = {
            eq(col: string, val: any) { filters[col] = val; return chain; },
            limit() { return chain; },
            then(resolve: any, reject: any) {
              const data = [...rows.values()]
                .filter((r) => r.parent_path === filters.parent_path)
                .map((r) => ({ id: r.id, data: r.data }));
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            },
          };
          return chain;
        },
        async upsert(row: any, opts: any) {
          upserts.push({ row: JSON.parse(JSON.stringify(row)), opts });
          rows.set(key(row.parent_path, row.id), JSON.parse(JSON.stringify(row)));
          return { error: null };
        },
        delete() {
          return {
            async eq(col: string, val: any) {
              for (const [k, r] of [...rows.entries()]) {
                if ((r as any)[col] === val) rows.delete(k);
              }
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { client, rows, upserts, key };
}

const poisonedDb: any = {
  collection: () => {
    throw new Error('Firestore poisoned: RESOURCE_EXHAUSTED');
  },
};

const OFFICER = 'officer-1';
const D = (day: number) => new Date(2026, 9, day, 10, 0, 0);

let savedSurfaces: string | undefined;
beforeEach(() => {
  savedSurfaces = process.env.SUPA_SURFACES;
  process.env.SUPA_SURFACES = 'consents';
});
afterEach(() => {
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
  __resetConsentsSupaAdapterForTests();
  __resetConsentsHistoryClientForTests();
});

/* ------------------------------------------------- mirror-first reads */

describe('flag ON, Firestore poisoned: reads serve from the mirror', () => {
  function seededAdapter(): FakeAdapter {
    return makeAdapter([
      {
        id: 'r-pending',
        data: {
          status: 'pending', requestedByUid: OFFICER, requesterName: 'Officer One',
          matterKey: 'role_catalog', proposedAct: 'Delete role definition x',
          createdAt: ISO(3), updatedAt: ISO(3), decisionDeadlineAt: ISO(20), isUrgent: true,
          subjectRef: { type: 'role_definition', slug: 'x', action: 'delete' },
          consumedAt: null, decidedAtSort: ISO(3),
        },
      },
      {
        id: 'r-info',
        data: {
          status: 'further_information_requested', requestedByUid: OFFICER,
          createdAt: ISO(2), updatedAt: ISO(4), decisionDeadlineAt: ISO(21),
        },
      },
      {
        id: 'r-decided-new',
        data: {
          status: 'consented', requestedByUid: OFFICER, requesterName: 'Officer One',
          matterKey: 'role_catalog', proposedAct: 'Delete role definition x',
          requestNumber: 'FC-2026-0050',
          createdAt: ISO(1), updatedAt: ISO(5), decidedAtSort: ISO(5),
          subjectRef: { type: 'role_definition', slug: 'x', action: 'delete' },
          consumedAt: null,
        },
      },
      {
        id: 'r-decided-old',
        data: {
          status: 'conditional', requestedByUid: 'officer-2',
          matterKey: 'role_catalog', proposedAct: 'Other act',
          requestNumber: 'FC-2026-0040',
          createdAt: ISO(1), updatedAt: ISO(2), decidedAtSort: ISO(2),
          consumedAt: null,
        },
      },
      {
        id: 'r-filed',
        data: {
          status: 'consented', requestedByUid: OFFICER,
          matterKey: 'amend_layer1_documents', gateMatterKey: 'role_catalog',
          proposedAct: 'Delete role definition x', requestNumber: 'FC-2026-0051',
          createdAt: ISO(1), updatedAt: ISO(6), decidedAtSort: ISO(6),
          subjectRef: { type: 'role_definition', slug: 'x', action: 'delete' },
          consumedAt: null,
        },
      },
    ]);
  }

  it('getRequest serves the mirror doc', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const doc: any = await getRequest(poisonedDb, 'r-decided-new');
    expect(doc.id).toBe('r-decided-new');
    expect(doc.status).toBe('consented');
    expect(doc.requestNumber).toBe('FC-2026-0050');
  });

  it('listMyRequests serves the mirror, newest first, with cursor paging', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const mine: any[] = await listMyRequests(poisonedDb, OFFICER, {});
    // createdAt desc; the two Oct-1 docs tie and fall to the adapter's
    // document-id-ascending tiebreak (r-decided-new before r-filed).
    expect(mine.map((d) => d.id)).toEqual(['r-pending', 'r-info', 'r-decided-new', 'r-filed']);
    const page2: any[] = await listMyRequests(poisonedDb, OFFICER, { cursor: 'r-info' });
    expect(page2.map((d) => d.id)).toEqual(['r-decided-new', 'r-filed']);
  });

  it('listInbox serves both arms from the mirror', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const inbox = await listInbox(poisonedDb);
    expect(inbox.awaitingDecision.map((d: any) => d.id)).toEqual(['r-pending']);
    expect(inbox.awaitingInformation.map((d: any) => d.id)).toEqual(['r-info']);
  });

  it('listRegister serves decided rows newest-first and honors q', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const rows: any[] = await listRegister(poisonedDb, {});
    expect(rows.map((d) => d.id)).toEqual(['r-filed', 'r-decided-new', 'r-decided-old']);
    const filtered: any[] = await listRegister(poisonedDb, { q: 'fc-2026-0040' });
    expect(filtered.map((d) => d.id)).toEqual(['r-decided-old']);
  });

  it('service getDecidedConsent serves by id and by matter', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const byId: any = await getDecidedConsentSvc(poisonedDb, {
      matterKey: 'role_catalog',
      requestId: 'r-decided-new',
    });
    expect(byId?.id).toBe('r-decided-new');
    const wrongMatter = await getDecidedConsentSvc(poisonedDb, {
      matterKey: 'other_reserved',
      requestId: 'r-decided-new',
    });
    expect(wrongMatter).toBeNull();
    const byMatter: any = await getDecidedConsentSvc(poisonedDb, { matterKey: 'role_catalog' });
    expect(byMatter?.id).toBe('r-decided-new');
  });

  it('lookup getDecidedConsent + candidates serve from the mirror', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const doc = await getDecidedConsentLookup(poisonedDb, 'r-pending');
    expect(doc?.id).toBe('r-pending');
    const missing = await getDecidedConsentLookup(poisonedDb, 'nope').catch(() => 'threw');
    // A mirror miss falls back to Firestore — which is poisoned, so the
    // lookup surfaces the Firestore error rather than inventing a doc.
    expect(missing).toBe('threw');
    const candidates = await listDecidedConsentCandidates(poisonedDb, 'role_catalog');
    expect(candidates.map((d) => d.id)).toEqual(['r-decided-new', 'r-decided-old']);
  });

  it('listDecidedConsentsForAct finds gate-shaped + filed records in the mirror', async () => {
    __setConsentsSupaAdapterForTests(seededAdapter());
    const subject: ConsentSubjectRef = { type: 'role_definition', slug: 'x', action: 'delete' };
    const found = await listDecidedConsentsForAct(poisonedDb, 'role_catalog', subject);
    expect(found.map((d) => d.id).sort()).toEqual(['r-decided-new', 'r-filed']);
  });

  it('history serves from fs_consent_requests_history, oldest first', async () => {
    const hist = makeHistoryClient();
    hist.rows.set(hist.key('consent_requests/r-pending', 'h2'), {
      id: 'h2', parent_path: 'consent_requests/r-pending',
      data: { event: 'submitted', createdAt: ISO(3) },
    });
    hist.rows.set(hist.key('consent_requests/r-pending', 'h1'), {
      id: 'h1', parent_path: 'consent_requests/r-pending',
      data: { event: 'draft_created', createdAt: ISO(2) },
    });
    __setConsentsSupaAdapterForTests(seededAdapter());
    __setConsentsHistoryClientForTests(hist.client as any);
    const entries = await listConsentHistoryViaSeam('r-pending');
    expect(entries?.map((e) => e.id)).toEqual(['h1', 'h2']);
    expect(entries?.[1].event).toBe('submitted');
  });
});

/* --------------------------------------------------------- flag OFF */

describe('flag OFF: the seam is never consulted', () => {
  it('getRequest serves Firestore with zero adapter reads', async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = makeAdapter([
      { id: 'r1', data: { status: 'consented', marker: 'mirror-copy' } },
    ]);
    __setConsentsSupaAdapterForTests(adapter);
    const db = createFakeDb();
    db.seed('consent_requests', 'r1', { status: 'pending', marker: 'firestore-copy' });
    const doc: any = await getRequest(db as any, 'r1');
    expect(doc.marker).toBe('firestore-copy');
    expect(adapter.calls.getDoc).toBe(0);
    expect(adapter.calls.listDocs).toBe(0);
  });

  it('listInbox fallback carries limit(200) on BOTH arms', async () => {
    delete process.env.SUPA_SURFACES;
    __setConsentsSupaAdapterForTests(null);
    const limits: number[] = [];
    const query = (): any => {
      const q: any = {
        where: () => q,
        orderBy: () => q,
        limit: (n: number) => { limits.push(n); return q; },
        get: async () => ({ docs: [] }),
      };
      return q;
    };
    const recordingDb: any = { collection: () => query() };
    await listInbox(recordingDb);
    expect(limits).toEqual([200, 200]);
  });
});

/* -------------------------------------------------------- dual-write */

describe('dual-write: mirror payloads equal the Firestore-bound docs', () => {
  const FILING = {
    matterKey: 'appoint_remove_national_officer',
    proposedAct: 'Appoint Jane Doe as National Treasurer',
    proposedActDate: '2026-12-01',
    amountPkr: null,
    materialFacts: 'The Treasurer seat has been vacant since September.',
    isUrgent: false,
  };
  const T0 = new Date(2026, 9, 1, 10, 0, 0);

  function seededDb(): FakeDb {
    const db = createFakeDb();
    db.seed('users', OFFICER, {
      displayName: 'Officer One', chapterId: 'seds-ist-chapter', role: 'member',
    });
    db.seed('roles', OFFICER, { role: 'national_treasurer' });
    db.seed('users', FOUNDER_UID, { displayName: 'The Founder' });
    return db;
  }

  it('createDraft + submit + decide mirror the post-write docs and history', async () => {
    const adapter = makeAdapter();
    const hist = makeHistoryClient();
    __setConsentsSupaAdapterForTests(adapter);
    __setConsentsHistoryClientForTests(hist.client as any);
    const db = seededDb();

    const draft: any = await createDraft(db as any, OFFICER, FILING);
    const storedDraft = db.read('consent_requests', draft.id);
    const draftMirror = adapter.setCalls.filter((c) => c.id === draft.id).pop();
    expect(draftMirror).toBeDefined();
    expect(draftMirror!.data).toEqual(serializeForSupa(storedDraft));

    const submitted = await submitRequest(db as any, draft.id, OFFICER, T0);
    expect(submitted.requestNumber).toMatch(/^FC-\d{4}-0001$/);
    const storedSubmitted = db.read('consent_requests', draft.id);
    const submitMirror = adapter.setCalls.filter((c) => c.id === draft.id).pop();
    expect(submitMirror!.data).toEqual(serializeForSupa(storedSubmitted));
    expect(submitMirror!.data.status).toBe('pending');

    const fsHistory = db.all(`consent_requests/${draft.id}/history`);
    expect(fsHistory).toHaveLength(1);
    expect(hist.upserts).toHaveLength(1);
    expect(hist.upserts[0].row.parent_path).toBe(`consent_requests/${draft.id}`);
    expect(hist.upserts[0].row.id).toBe(fsHistory[0].id);
    expect(hist.upserts[0].row.data).toEqual(serializeForSupa(fsHistory[0].data));

    await decideRequest(
      db as any, draft.id, FOUNDER_UID, { action: 'consent_given' }, D(5),
    );
    const storedDecided = db.read('consent_requests', draft.id);
    const decideMirror = adapter.setCalls.filter((c) => c.id === draft.id).pop();
    expect(decideMirror!.data).toEqual(serializeForSupa(storedDecided));
    expect(decideMirror!.data.status).toBe('consented');
    expect(hist.upserts).toHaveLength(2);
    expect(hist.upserts[1].row.data.event).toBe('consent_given');
  });

  it('consumeConsent mirrors the consumption stamp', async () => {
    const adapter = makeAdapter([
      { id: 'c1', data: { status: 'consented', consumedAt: null } },
    ]);
    __setConsentsSupaAdapterForTests(adapter);
    const db = createFakeDb();
    db.seed('consent_requests', 'c1', { status: 'consented', consumedAt: null });
    const outcome = await consumeConsent(db as any, 'c1', 'actor-1', 'roles/actor-1');
    expect(outcome).toBe('consumed');
    expect(adapter.updateCalls).toHaveLength(1);
    expect(adapter.updateCalls[0].id).toBe('c1');
    expect(adapter.updateCalls[0].data.consumedBy).toBe('actor-1');
    expect(adapter.updateCalls[0].data.consumedActRef).toBe('roles/actor-1');
    expect(typeof adapter.updateCalls[0].data.consumedAt).toBe('string');
  });
});
