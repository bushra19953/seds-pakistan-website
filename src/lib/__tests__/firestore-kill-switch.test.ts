/**
 * @jest-environment node
 *
 * W5 kill-switch contracts — FIRESTORE_DATA_DISABLED /
 * NEXT_PUBLIC_FIRESTORE_DATA_DISABLED.
 *
 * Pins:
 *  - OFF (unset / any non-ON value) is byte-identical: the gate is a
 *    no-op, the REAL getDb() in src/lib/server/firebase-admin.ts returns
 *    the db it always returned, and the REAL client wrapper delegates
 *    to the Firestore SDK exactly as before.
 *  - ON: every gated boundary throws FirestoreDataDisabledError (name +
 *    code 'firestore-data-disabled'), loudly — never a silent null,
 *    empty result, or fallback. The client proxy throws on any touch.
 *  - Auth exemption: the gate module touches no auth API, and the
 *    server boundary's auth surface (admin.auth) is not routed through
 *    getDb — asserted structurally below (the mocked admin app still
 *    exposes auth while getDb throws).
 *
 * Zero live reads/writes: firebase-admin and the client Firestore SDK
 * are mocked at the module boundary.
 */

const ENV_KEYS = [
  'FIRESTORE_DATA_DISABLED',
  'NEXT_PUBLIC_FIRESTORE_DATA_DISABLED',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function setKillEnv(v: string | undefined) {
  for (const k of ENV_KEYS) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/* ------------------------------------------------------------ mocks */

const fakeDb = { __fakeDb: true, collection: jest.fn(() => ({})) };

jest.mock('firebase-admin', () => {
  const app = { options: { projectId: 'test-project' } };
  return {
    __esModule: true,
    default: {
      apps: [] as unknown[],
      app: () => app,
      initializeApp: () => app,
      credential: {
        cert: jest.fn(() => ({})),
        applicationDefault: jest.fn(() => ({})),
      },
      auth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }),
      storage: () => null,
    },
  };
});

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => fakeDb,
}));

const sdkCalls: string[] = [];
jest.mock('firebase/firestore', () => ({
  setDoc: async () => {
    sdkCalls.push('setDoc');
  },
  updateDoc: async () => {
    sdkCalls.push('updateDoc');
  },
  addDoc: async () => {
    sdkCalls.push('addDoc');
    return { id: 'new-id', path: 'blogs/new-id' };
  },
  deleteDoc: async () => {
    sdkCalls.push('deleteDoc');
  },
  getDoc: async () => ({ exists: () => false, data: () => undefined }),
}));

jest.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: null }),
}));

/* ------------------------------------------------------------ imports */

import {
  FIRESTORE_DATA_DISABLED_CODE,
  FirestoreDataDisabledError,
  assertFirestoreDataEnabled,
  createDisabledFirestoreProxy,
  isFirestoreDataDisabled,
  isFirestoreDataDisabledError,
} from '@/lib/firestore-kill-switch';

describe('flag parsing', () => {
  it('unset / empty / non-ON values are OFF (byte-identical default)', () => {
    expect(isFirestoreDataDisabled({})).toBe(false);
    expect(isFirestoreDataDisabled({ FIRESTORE_DATA_DISABLED: '' })).toBe(false);
    expect(isFirestoreDataDisabled({ FIRESTORE_DATA_DISABLED: '0' })).toBe(false);
    expect(isFirestoreDataDisabled({ FIRESTORE_DATA_DISABLED: 'false' })).toBe(false);
    expect(isFirestoreDataDisabled({ FIRESTORE_DATA_DISABLED: 'off' })).toBe(false);
    expect(isFirestoreDataDisabled({ NEXT_PUBLIC_FIRESTORE_DATA_DISABLED: 'no' })).toBe(false);
  });

  it('1 / true / yes / on (any case, trimmed) are ON, from either var', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      expect(isFirestoreDataDisabled({ FIRESTORE_DATA_DISABLED: v })).toBe(true);
      expect(isFirestoreDataDisabled({ NEXT_PUBLIC_FIRESTORE_DATA_DISABLED: v })).toBe(true);
    }
  });
});

describe('assert + error shape', () => {
  beforeEach(() => setKillEnv(undefined));
  afterEach(() => setKillEnv(undefined));

  it('OFF: assert is a no-op', () => {
    expect(() => assertFirestoreDataEnabled('server:getDb')).not.toThrow();
  });

  it('ON: assert throws the named, coded error naming the operation', () => {
    setKillEnv('1');
    let caught: unknown;
    try {
      assertFirestoreDataEnabled('server:getDb');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FirestoreDataDisabledError);
    const err = caught as FirestoreDataDisabledError;
    expect(err.name).toBe('FirestoreDataDisabledError');
    expect(err.code).toBe(FIRESTORE_DATA_DISABLED_CODE);
    expect(err.code).toBe('firestore-data-disabled');
    expect(err.message).toContain('server:getDb');
    expect(err.message).toContain('FIRESTORE_DATA_DISABLED');
    expect(isFirestoreDataDisabledError(err)).toBe(true);
    expect(isFirestoreDataDisabledError(new Error('other'))).toBe(false);
  });

  it('client twin alone turns the gate ON (baked NEXT_PUBLIC_ var)', () => {
    delete process.env.FIRESTORE_DATA_DISABLED;
    process.env.NEXT_PUBLIC_FIRESTORE_DATA_DISABLED = 'true';
    expect(() => assertFirestoreDataEnabled('client:wrapper:setDoc')).toThrow(
      FirestoreDataDisabledError,
    );
  });
});

describe('disabled client proxy', () => {
  it('any property touch throws the named error; inspection does not', () => {
    const proxy = createDisabledFirestoreProxy<Record<string, unknown>>('client:firestore-instance');
    expect(() => proxy.collection).toThrow(FirestoreDataDisabledError);
    expect(() => {
      (proxy as any).anything();
    }).toThrow(FirestoreDataDisabledError);
    expect((proxy as any)[Symbol.toStringTag]).toBe('FirestoreDataDisabled');
    expect((proxy as any).then).toBeUndefined();
  });
});

describe('server boundary: real firebase-admin.ts getDb / ensureAdminInitialized', () => {
  function loadAdmin() {
    let mod: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('@/lib/server/firebase-admin');
    });
    return mod as typeof import('@/lib/server/firebase-admin');
  }

  afterEach(() => setKillEnv(undefined));

  it('OFF: getDb returns the Firestore instance, ensureAdminInitialized is true', () => {
    setKillEnv(undefined);
    const admin = loadAdmin();
    expect(admin.ensureAdminInitialized()).toBe(true);
    expect(admin.getDb()).toBe(fakeDb);
  });

  // NOTE: loadAdmin() uses jest.isolateModules, so the thrown error is
  // an instance of the ISOLATED registry's copy of the error class —
  // instanceof against this file's import fails by reference while
  // name/code match. Assert via the cross-realm guard instead.
  function expectDisabledThrow(fn: () => unknown) {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(isFirestoreDataDisabledError(caught)).toBe(true);
    expect((caught as Error).name).toBe('FirestoreDataDisabledError');
    expect((caught as FirestoreDataDisabledError).code).toBe('firestore-data-disabled');
  }

  it('ON: getDb throws FirestoreDataDisabledError (never a silent null)', () => {
    setKillEnv('1');
    const admin = loadAdmin();
    expectDisabledThrow(() => admin.getDb());
  });

  it('ON: ensureAdminInitialized throws on the same boundary', () => {
    setKillEnv('true');
    const admin = loadAdmin();
    expectDisabledThrow(() => admin.ensureAdminInitialized());
  });

  it('ON: auth surface is exempt — admin.auth() is not routed through the gate', async () => {
    setKillEnv('1');
    const admin = loadAdmin();
    // The Admin SDK object itself is untouched by the gate; token
    // verification (the auth-exempt path) still resolves.
    await expect(admin.admin.auth().verifyIdToken('token')).resolves.toEqual({ uid: 'u1' });
    expect(admin.getAdminDiagnostics().projectId).toBeDefined();
  });
});

describe('client boundary: real firestore-wrapper.ts write wrappers', () => {
  function loadWrapper() {
    let mod: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('@/lib/client/firestore-wrapper');
    });
    return mod as typeof import('@/lib/client/firestore-wrapper');
  }

  const ref = { path: 'blogs/b1', id: 'b1' } as any;
  const colRef = { path: 'blogs', id: 'blogs' } as any;

  beforeEach(() => {
    sdkCalls.length = 0;
  });
  afterEach(() => setKillEnv(undefined));

  it('OFF: setDoc/addDoc delegate to the SDK exactly as before', async () => {
    setKillEnv(undefined);
    const wrapper = loadWrapper();
    await wrapper.setDoc(ref, { title: 'x' });
    await wrapper.addDoc(colRef, { title: 'y' });
    expect(sdkCalls).toEqual(['setDoc', 'addDoc']);
  });

  it('ON: every wrapper throws the named error BEFORE any SDK call', async () => {
    setKillEnv('1');
    const wrapper = loadWrapper();
    // Same isolateModules registry caveat as the server boundary:
    // assert name/code via the cross-realm guard, not instanceof.
    for (const call of [
      () => wrapper.setDoc(ref, { title: 'x' }),
      () => wrapper.updateDoc(ref, { title: 'x' }),
      () => wrapper.addDoc(colRef, { title: 'y' }),
      () => wrapper.deleteDoc(ref),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (e) {
        caught = e;
      }
      expect(isFirestoreDataDisabledError(caught)).toBe(true);
      expect((caught as Error).name).toBe('FirestoreDataDisabledError');
    }
    expect(sdkCalls).toEqual([]);
  });
});
