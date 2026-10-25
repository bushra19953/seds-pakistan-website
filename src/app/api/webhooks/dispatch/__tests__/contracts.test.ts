/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for POST /api/webhooks/dispatch —
 * companion to fresh-signup.test.ts in this folder (which pins the
 * signup regression, session failure and malformed-body arms through
 * the proxy). This file pins the proxy's security-relevant CURRENT
 * behaviour:
 *
 *  - H-12 (SECURITY FLAG): dispatch verifies only that the caller has
 *    SOME valid session. It never checks the caller's role, and it
 *    never binds the payload to the caller: any authenticated member
 *    can dispatch a `roles` event for ANY uid (including someone
 *    else's) with ANY role string, and the inner handler will set that
 *    role as a Firebase custom claim on the target account. Pinned as
 *    current behaviour, NOT fixed.
 *  - A session error the mapper does not recognise falls back to
 *    401 { error: 'Unauthorized' }.
 *
 * The inner firestore handler runs for real (same mock boundary as
 * fresh-signup.test.ts); zero live reads.
 */

const mockState = {
  userDocExists: true,
  calls: [] as Array<{ op: string; path: string; data?: any }>,
};

function mockDocRef(path: string): any {
  const id = path.split('/').pop() ?? 'generated-id';
  return {
    id,
    path,
    get: async () => {
      if (path.startsWith('users/') && path.split('/').length === 2) {
        return { exists: mockState.userDocExists, data: () => ({ chapterId: 'seds-ist-chapter' }) };
      }
      return { exists: true, data: () => ({}) };
    },
    update: async (data: any) => {
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
    fn({ get: async () => ({ data: () => null }), update: () => undefined, set: () => undefined }),
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
    // The caller is an ordinary member. verifySession returns only a
    // uid — dispatch performs no role lookup of its own (H-12).
    verifySession: jest.fn(async () => ({ uid: 'member-attacker-uid' })),
    toSessionErrorResponse: (err: any) => {
      if (err instanceof MockSessionError) {
        return { status: err.statusCode, json: async () => ({ error: err.message }) };
      }
      return null;
    },
  };
});

import { POST as dispatchPOST } from '../route';

const SECRET = 'test-webhook-secret';

function dispatchRequest(body: any): any {
  return new Request('http://localhost/api/webhooks/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer member-token' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.userDocExists = true;
  mockState.calls.length = 0;
  process.env.FIRESTORE_WEBHOOK_SECRET = SECRET;
});

describe('POST /api/webhooks/dispatch — H-12 forged role-claim contract', () => {
  // SECURITY FLAG H-12 (current behaviour, pinned not fixed): an
  // ordinary authenticated member dispatches a roles/create event
  // naming ANOTHER user's uid and an arbitrary privileged role. The
  // proxy checks nothing but the session, and the inner handler sets
  // the forged role as a custom claim on the victim account.
  it('SECURITY FLAG H-12: a member-forged roles event sets arbitrary role claims on a DIFFERENT uid', async () => {
    const res: any = await dispatchPOST(
      dispatchRequest({
        collection: 'roles',
        docId: 'victim-uid',
        eventType: 'create',
        before: null,
        after: { role: 'founder_patron' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const { getAuth } = require('firebase-admin/auth');
    expect(getAuth().setCustomUserClaims).toHaveBeenCalledWith('victim-uid', {
      role: 'founder_patron',
      chapter_id: 'seds-ist-chapter',
    });
  });

  it('SECURITY FLAG H-12 (self-escalation variant): a member can equally forge a privileged role onto their OWN uid', async () => {
    const res: any = await dispatchPOST(
      dispatchRequest({
        collection: 'roles',
        docId: 'member-attacker-uid',
        eventType: 'create',
        before: null,
        after: { role: 'super_admin' },
      }),
    );
    expect(res.status).toBe(200);
    const { getAuth } = require('firebase-admin/auth');
    expect(getAuth().setCustomUserClaims).toHaveBeenCalledWith('member-attacker-uid', {
      role: 'super_admin',
      chapter_id: 'seds-ist-chapter',
    });
  });

  it('an unrecognised session error (mapper returns null) falls back to 401 { error: "Unauthorized" }', async () => {
    const { verifySession } = require('@/lib/auth/verifySession');
    (verifySession as jest.Mock).mockRejectedValueOnce(new Error('totally unexpected'));
    const res: any = await dispatchPOST(
      dispatchRequest({ collection: 'roles', docId: 'x', eventType: 'create', before: null, after: { role: 'member' } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    const { getAuth } = require('firebase-admin/auth');
    expect(getAuth().setCustomUserClaims).not.toHaveBeenCalled();
  });
});
