/**
 * @jest-environment node
 *
 * GAP-N1 closure — POST /api/webhooks/firestore notification writes (x2):
 *   tasks create            : per-assignee batch notifications
 *   tasks update->completed : reward-transaction notifications (tx.set)
 *
 * Both wrote users/{uid}/notifications with no mirror. The batch site is
 * now mirrored after batch.commit(); the transaction site collects its
 * notifications inside the transaction and mirrors them only after
 * runTransaction resolves (i.e. after the Firestore commit).
 *
 * Harness: same fake Firestore as contracts.test.ts.
 */

const mockState = {
  dbAvailable: true,
  userDocs: new Map<string, any>(),
  badges: [] as any[],
  positions: [] as Array<{ id: string; data: any }>,
  txTask: null as any,
  calls: [] as Array<{ op: string; path: string; data?: any; opts?: any }>,
  claims: [] as Array<{ uid: string; claims: any }>,
  customClaimsByUid: new Map<string, any>(),
  messages: [] as any[],
};

function mockDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const seg = path.split('/');
      if (seg[0] === 'users' && seg.length === 2) {
        const data = mockState.userDocs.get(seg[1]);
        return { exists: data !== undefined, data: () => data };
      }
      if (seg[0] === 'tasks' && seg.length === 2) {
        return { exists: mockState.txTask != null, data: () => mockState.txTask };
      }
      return { exists: true, data: () => ({}) };
    },
    update: async (data: any) => {
      mockState.calls.push({ op: 'update', path, data });
    },
    set: async (data: any, opts?: any) => {
      mockState.calls.push({ op: 'set', path, data, opts });
    },
    delete: async () => {
      mockState.calls.push({ op: 'delete', path });
    },
    collection: (sub: string) => ({
      add: async (data: any) => {
        mockState.calls.push({ op: 'add', path: `${path}/${sub}`, data });
        return { id: 'generated-sub-id' };
      },
      doc: (subId?: string) => mockDocRef(`${path}/${sub}/${subId ?? 'auto-id'}`),
    }),
  };
}

function mockQuery(rows: Array<{ id: string; data: any }>, collectionName: string, filters: Array<[string, any]> = []): any {
  return {
    where: (field: string, _op: string, value: any) => mockQuery(rows, collectionName, [...filters, [field, value]]),
    get: async () => {
      const matched = rows.filter((r) => filters.every(([f, v]) => r.data[f] === v));
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => r.data, ref: mockDocRef(`${collectionName}/${r.id}`) })),
      };
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => mockDocRef(`${name}/${id ?? 'auto-id'}`),
    add: async (data: any) => {
      mockState.calls.push({ op: 'add', path: name, data });
      return { id: 'generated-id' };
    },
    get: async () => {
      if (name === 'badges') return { docs: mockState.badges.map((d) => ({ data: () => d })) };
      return { docs: [] };
    },
    where: (field: string, op: string, value: any) => {
      if (name === 'positions') return mockQuery(mockState.positions, name).where(field, op, value);
      return { get: async () => ({ docs: [] }) };
    },
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => mockState.calls.push({ op: 'batch-set', path: ref.path, data, opts }),
    update: (ref: any, data: any) => mockState.calls.push({ op: 'batch-update', path: ref.path, data }),
    delete: (ref: any) => mockState.calls.push({ op: 'batch-delete', path: ref.path }),
    commit: async () => {
      mockState.calls.push({ op: 'batch-commit', path: '' });
    },
  }),
  runTransaction: async (fn: any) =>
    fn({
      get: async (ref: any) => {
        const seg = ref.path.split('/');
        if (seg[0] === 'tasks') return { data: () => mockState.txTask };
        const data = mockState.userDocs.get(seg[1]);
        return { data: () => data };
      },
      update: (ref: any, data: any) => mockState.calls.push({ op: 'tx-update', path: ref.path, data }),
      set: (ref: any, data: any, opts?: any) => mockState.calls.push({ op: 'tx-set', path: ref.path, data, opts }),
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
  admin: {},
  getDb: () => (mockState.dbAvailable ? mockDb : null),
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: mockState.customClaimsByUid.get(uid) ?? {} }),
    setCustomUserClaims: async (uid: string, claims: any) => {
      mockState.claims.push({ uid, claims });
    },
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    increment: (n: number) => ({ __fv: 'increment', n }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
  },
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({
    sendEachForMulticast: async (message: any) => {
      mockState.messages.push(message);
      return {};
    },
  }),
}));

import { POST } from '../route';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

const SECRET = 'test-webhook-secret';

function whRequest(body: any): any {
  return new Request('http://localhost/api/webhooks/firestore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify(body),
  });
}

function makeAdapter(fail = false) {
  const calls = { setDoc: [] as any[], updateDoc: [] as any[], deleteDoc: [] as any[] };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => {
      calls.setDoc.push(args);
      if (fail) throw new Error('supa down');
    },
    updateDoc: async (...args: any[]) => { calls.updateDoc.push(args); },
    deleteDoc: async (...args: any[]) => { calls.deleteDoc.push(args); },
    listDocs: async () => [],
  };
  return { adapter, calls };
}

const CREATE_EVENT = {
  collection: 'tasks',
  docId: 'task-1',
  eventType: 'create',
  before: null,
  after: { title: 'Build Rover', createdBy: 'creator-1', assigneeIds: ['u-1', 'u-2'], status: 'pending' },
};

function seedCompletion() {
  mockState.txTask = {
    title: 'Tx Task',
    points: 30,
    hoursWorked: 2,
    completionBadgeId: 'badge-1',
    assigneeIds: ['u-1'],
    deadline: { toDate: () => new Date(Date.now() + 86400000) },
  };
}

const COMPLETE_EVENT = {
  collection: 'tasks',
  docId: 'task-1',
  eventType: 'update',
  before: { status: 'in-progress' },
  after: { status: 'completed', title: 'Tx Task', assigneeIds: ['u-1'] },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockState.dbAvailable = true;
  mockState.userDocs = new Map();
  mockState.badges = [];
  mockState.positions = [];
  mockState.txTask = null;
  mockState.calls = [];
  mockState.claims = [];
  mockState.customClaimsByUid = new Map();
  mockState.messages = [];
  process.env.FIRESTORE_WEBHOOK_SECRET = SECRET;
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

describe('GAP-N1: webhooks tasks-create notifications', () => {
  it('flag ON: one mirror per assignee with that user\'s path', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(whRequest(CREATE_EVENT));
    expect(res.status).toBe(200);
    expect(calls.setDoc).toHaveLength(2);
    expect(calls.setDoc.map((c) => c[0]).sort()).toEqual([
      'users/u-1/notifications',
      'users/u-2/notifications',
    ]);
    for (const c of calls.setDoc) {
      expect(c[2]).toMatchObject({ type: 'task-assigned', taskId: 'task-1' });
    }
  });

  it('flag OFF: batch notifications written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const res: any = await POST(whRequest(CREATE_EVENT));
    expect(res.status).toBe(200);
    expect(mockState.calls.filter((c) => c.op === 'batch-set' && c.path.includes('/notifications/'))).toHaveLength(2);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: webhook still returns success', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(whRequest(CREATE_EVENT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});

describe('GAP-N1: webhooks completion-transaction notifications', () => {
  it('flag ON: transaction notification mirrored after commit', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    seedCompletion();
    const res: any = await POST(whRequest(COMPLETE_EVENT));
    expect(res.status).toBe(200);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('users/u-1/notifications');
    expect(calls.setDoc[0][2]).toMatchObject({ type: 'task-complete', taskId: 'task-1', points: 30 });
  });

  it('flag OFF: transaction notification written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    seedCompletion();
    const res: any = await POST(whRequest(COMPLETE_EVENT));
    expect(res.status).toBe(200);
    expect(mockState.calls.filter((c) => c.op === 'tx-set' && c.path.includes('/notifications/'))).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: webhook still returns success', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    seedCompletion();
    const res: any = await POST(whRequest(COMPLETE_EVENT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});
