/**
 * @jest-environment node
 *
 * Regression tests for the 500-on-every-new-signup in /api/webhooks/dispatch.
 *
 * Root cause (Team 5 proof + Team 1 route map): at signup the client wrapper
 * dispatches `users` / `create` with `after = { email, ... }` and NO
 * `email_lowercase`, so the email-lowercase sync in `handleUserWritten`
 * (src/app/api/webhooks/firestore/route.ts) ALWAYS fires. A fresh signup may
 * reach the handler with no `users/{uid}` doc yet (signup profile creation
 * is best-effort, cf. commits abaa7c8/120b149). The old code ran an
 * UNGUARDED `.update()` there: `update()` on a missing doc throws
 * NOT_FOUND, the outer catch converted ANY throw to HTTP 500, and every
 * new signup's webhook returned 500.
 *
 * Fix under test: skip-if-missing email sync (NOT_FOUND swallowed, no
 * skeleton doc created), plus null/type guards on every other handler so a
 * missing doc or malformed field can never produce a 500.
 *
 * Coverage:
 * (a) fresh-signup payload (no users doc, no email_lowercase) -> 200,
 *     via BOTH the inner handler and the dispatch proxy.
 * (b) existing-user payload still works -> 200.
 * (c) malformed / unauthorized payload -> 400 / 401, never 500.
 * Plus sibling guards: roles-create with missing users doc, tasks-create
 * with null `after`, positions-delete with null `before`.
 */

// Mutable per-test fake-Firestore state. The `mock` prefix is required for
// variables referenced inside jest.mock factories.
const mockState = {
  userDocExists: true,
  userUpdateError: null as any,
  calls: [] as Array<{ op: string; path: string; data?: any }>,
};

function mockDocRef(path: string): any {
  const id = path.split('/').pop() ?? 'generated-id';
  return {
    id,
    path,
    get: async () => {
      if (path.startsWith('users/') && path.split('/').length === 2) {
        return {
          exists: mockState.userDocExists,
          data: () => ({ chapterId: 'seds-ist-chapter' }),
        };
      }
      return { exists: true, data: () => ({}) };
    },
    update: async (data: any) => {
      if (path.startsWith('users/') && mockState.userUpdateError) {
        throw mockState.userUpdateError;
      }
      mockState.calls.push({ op: 'update', path, data });
    },
    set: async (data: any, opts?: any) => {
      mockState.calls.push({ op: 'set', path, data });
    },
    delete: async () => {
      mockState.calls.push({ op: 'delete', path });
    },
    collection: (sub: string) => ({
      add: async (data: any) => {
        mockState.calls.push({ op: 'add', path: `${path}/${sub}`, data });
        return { id: 'generated-sub-id' };
      },
      doc: (subId?: string) => mockDocRef(`${path}/${sub}/${subId ?? 'generated-sub-id'}`),
    }),
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => mockDocRef(`${name}/${id ?? 'generated-id'}`),
    add: async (data: any) => {
      mockState.calls.push({ op: 'add', path: name, data });
      return { id: 'generated-id' };
    },
    get: async () => ({ docs: [] }),
    where: () => ({ get: async () => ({ docs: [] }) }),
  }),
  batch: () => ({
    set: (ref: any, data: any) => mockState.calls.push({ op: 'batch-set', path: ref.path, data }),
    update: (ref: any, data: any) => mockState.calls.push({ op: 'batch-update', path: ref.path, data }),
    delete: (ref: any) => mockState.calls.push({ op: 'batch-delete', path: ref.path }),
    commit: async () => undefined,
  }),
  runTransaction: async (fn: any) =>
    fn({
      get: async () => ({ data: () => null }),
      update: () => undefined,
      set: () => undefined,
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
  getDb: () => mockDb,
}));

jest.mock('firebase-admin/auth', () => {
  const authMock = {
    getUser: jest.fn().mockRejectedValue(new Error('no such user')),
    setCustomUserClaims: jest.fn().mockResolvedValue(undefined),
  };
  return { getAuth: () => authMock };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    increment: (n: number) => ({ __fv: 'increment', n }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
  },
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ sendEachForMulticast: jest.fn().mockResolvedValue({}) }),
}));

jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError: MockSessionError,
    verifySession: jest.fn(async () => ({ uid: 'test-uid' })),
    toSessionErrorResponse: (err: any) => {
      if (err instanceof MockSessionError) {
        return { status: err.statusCode, json: async () => ({ error: err.message }) };
      }
      return null;
    },
  };
});

import { POST as firestorePOST } from '../../firestore/route';
import { POST as dispatchPOST } from '../route';

const SECRET = 'test-webhook-secret';

function firestoreRequest(body: any, secret: string | null = SECRET): any {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['x-webhook-secret'] = secret;
  return new Request('http://localhost/api/webhooks/firestore', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dispatchRequest(body: any): any {
  return new Request('http://localhost/api/webhooks/dispatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const FRESH_SIGNUP_PAYLOAD = {
  collection: 'users',
  docId: 'new-uid',
  eventType: 'create',
  before: null,
  // Exactly what the signup wrapper sends: email present, NO email_lowercase,
  // so the email-lowercase sync always fires for a fresh signup.
  after: { uid: 'new-uid', email: 'new@example.com', displayName: 'New User' },
};

const EXISTING_USER_PAYLOAD = {
  collection: 'users',
  docId: 'existing-uid',
  eventType: 'update',
  before: { points: 0, email: 'old@example.com', email_lowercase: 'old@example.com', chapterId: 'seds-ist-chapter' },
  after: { points: 10, email: 'old@example.com', email_lowercase: 'old@example.com', chapterId: 'seds-ist-chapter', badges: [] },
};

describe('POST /api/webhooks/firestore (inner handler)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.userDocExists = true;
    mockState.userUpdateError = null;
    mockState.calls.length = 0;
    process.env.FIRESTORE_WEBHOOK_SECRET = SECRET;
  });

  test('(a) fresh-signup payload with NO users doc returns 200, not 500', async () => {
    mockState.userDocExists = false;
    mockState.userUpdateError = { code: 5, message: '5 NOT_FOUND: No document to update' };
    const res: any = await firestorePOST(firestoreRequest(FRESH_SIGNUP_PAYLOAD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // The webhook must NOT create a skeleton users doc out of a side-effect.
    expect(mockState.calls.filter((c) => c.op === 'set' && c.path === 'users/new-uid')).toHaveLength(0);
  });

  test('(a) fresh-signup payload where the doc vanishes mid-sync still returns 200', async () => {
    mockState.userDocExists = true;
    mockState.userUpdateError = { code: 'not-found', message: 'NOT_FOUND' };
    const res: any = await firestorePOST(firestoreRequest(FRESH_SIGNUP_PAYLOAD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  test('(b) existing-user payload still works and syncs email_lowercase', async () => {
    const payload = {
      ...EXISTING_USER_PAYLOAD,
      after: { ...EXISTING_USER_PAYLOAD.after, email_lowercase: undefined, email: 'Old@Example.com' },
    };
    delete (payload.after as any).email_lowercase;
    const res: any = await firestorePOST(firestoreRequest(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const sync = mockState.calls.find(
      (c) => c.op === 'update' && c.path === 'users/existing-uid' && c.data?.email_lowercase === 'old@example.com',
    );
    expect(sync).toBeDefined();
  });

  test('roles create with missing users doc returns 200 and still syncs claims', async () => {
    mockState.userDocExists = false;
    const res: any = await firestorePOST(
      firestoreRequest({ collection: 'roles', docId: 'new-uid', eventType: 'create', before: null, after: { role: 'member' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // No users-doc mirror write attempted on the missing doc.
    expect(mockState.calls.filter((c) => c.op === 'update' && c.path === 'users/new-uid')).toHaveLength(0);
    const { getAuth } = require('firebase-admin/auth');
    expect(getAuth().setCustomUserClaims).toHaveBeenCalledWith('new-uid', { role: 'member' });
  });

  test('tasks create with null after returns 200 (null guard)', async () => {
    const res: any = await firestorePOST(
      firestoreRequest({ collection: 'tasks', docId: 'task-1', eventType: 'create', before: null, after: null }),
    );
    expect(res.status).toBe(200);
  });

  test('positions delete with null before returns 200 (null guard)', async () => {
    const res: any = await firestorePOST(
      firestoreRequest({ collection: 'positions', docId: 'pos-1', eventType: 'delete', before: null, after: null }),
    );
    expect(res.status).toBe(200);
  });

  test('(c) wrong webhook secret is rejected with 401, not 500', async () => {
    const res: any = await firestorePOST(firestoreRequest(FRESH_SIGNUP_PAYLOAD, 'wrong-secret'));
    expect(res.status).toBe(401);
  });

  test('(c) missing secret is rejected with 401, not 500', async () => {
    const res: any = await firestorePOST(firestoreRequest(FRESH_SIGNUP_PAYLOAD, null));
    expect(res.status).toBe(401);
  });

  test('(c) missing payload fields are rejected with 400, not 500', async () => {
    const res: any = await firestorePOST(firestoreRequest({ collection: 'users' }));
    expect(res.status).toBe(400);
  });

  test('(c) non-string collection is rejected with 400, not 500', async () => {
    const res: any = await firestorePOST(
      firestoreRequest({ collection: 123, docId: 'x', eventType: 'create', before: null, after: {} }),
    );
    expect(res.status).toBe(400);
  });

  test('(c) malformed JSON is rejected with 400, not 500', async () => {
    const res: any = await firestorePOST(firestoreRequest('{not-json'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/webhooks/dispatch (proxy, end to end through the inner handler)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.userDocExists = true;
    mockState.userUpdateError = null;
    mockState.calls.length = 0;
    process.env.FIRESTORE_WEBHOOK_SECRET = SECRET;
  });

  test('(a) fresh-signup payload through the proxy returns 200, not 500', async () => {
    mockState.userDocExists = false;
    mockState.userUpdateError = { code: 5, message: '5 NOT_FOUND: No document to update' };
    const res: any = await dispatchPOST(dispatchRequest(FRESH_SIGNUP_PAYLOAD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  test('(b) existing-user payload through the proxy returns 200', async () => {
    const res: any = await dispatchPOST(dispatchRequest(EXISTING_USER_PAYLOAD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  test('(c) failed session verification is rejected with 401, not 500', async () => {
    const { verifySession, SessionError } = require('@/lib/auth/verifySession');
    (verifySession as jest.Mock).mockRejectedValueOnce(new SessionError('Unauthorized: invalid or expired token', 401));
    const res: any = await dispatchPOST(dispatchRequest(FRESH_SIGNUP_PAYLOAD));
    expect(res.status).toBe(401);
  });

  test('(c) malformed JSON through the proxy is rejected with 400, not 500', async () => {
    const res: any = await dispatchPOST(dispatchRequest('{not-json'));
    expect(res.status).toBe(400);
  });

  test('unconfigured server secret fails closed with 500 (server misconfiguration, not a payload error)', async () => {
    delete process.env.FIRESTORE_WEBHOOK_SECRET;
    const res: any = await dispatchPOST(dispatchRequest(FRESH_SIGNUP_PAYLOAD));
    expect(res.status).toBe(500);
  });
});
