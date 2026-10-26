/**
 * @jest-environment node
 *
 * W5 FIRESTORE-DISABLED PROOF harness (mocked transports only — program
 * law: zero production reads/writes by agents).
 *
 * Setup for every exercise: FIRESTORE_DATA_DISABLED=1 and every
 * flipped surface ALSO write-primary (SUPA_SURFACES and SUPA_PRIMARY
 * name the same token list). The Firestore boundary is made to throw
 * exactly the way the real kill-switch makes it throw:
 *
 *  - the mocked '@/lib/server/firebase-admin' boundary runs the REAL
 *    assertFirestoreDataEnabled() from src/lib/firestore-kill-switch.ts
 *    (the same call the real getDb/ensureAdminInitialized run), so
 *    getDb() throws FirestoreDataDisabledError and records the attempt;
 *  - a "poisoned" db handle (for seams that receive `db` as a parameter)
 *    returns refs freely (ref construction is not a data op) but throws
 *    FirestoreDataDisabledError on every DATA op (get/set/update/add/
 *    delete/batch/runTransaction) and records each attempt.
 *
 * A surface is PROVEN-SUPA-ONLY (at the exercised level) when its
 * primacy path COMPLETES with its effect landed on the fake Supa
 * adapter and every Firestore attempt is either zero or a post-commit
 * best-effort mirror whose failure is swallowed by design. A surface
 * is STILL-TOUCHES-FIRESTORE when its path FAILS on the boundary.
 *
 * Evidence levels are stated per surface in
 * cutover-sections/w5-decommission.md — tx surfaces (events, finance,
 * store) are proven at CALL-SHAPE level only here: the mocked adapter's
 * tx() records the function name/args and returns a canned outcome;
 * the SQL functions themselves do not exist on the real project yet
 * (bundles #1/#2 unapplied), so no real-Postgres claim is made.
 */

/* ---------------------------------------------------------- recording */

const adapterEvents: string[] = [];
const firestoreAttempts: string[] = [];

const SURFACES =
  'blog,chapters,crm,forms,resources,organizations,admin-settings,notifications,applications,tasks,events,finance,leave,store-products-api,store-orders-api,store-settings,store-actions';

const savedEnv = { ...process.env };

/* ---------------------------------------------------------- fake adapter */

function txResultFor(fn: string): unknown {
  if (fn === 'tx_events_register_paid' || fn === 'tx_events_register_free') {
    return {
      outcome: 'created',
      registration_data: { status: 'registered', uid: 'u1' },
      counters: { registeredCount: 1 },
    };
  }
  return { ok: true, created: true };
}

const fakeAdapter: any = {
  getDoc: async (col: string, id: string) => {
    adapterEvents.push(`adapter:getDoc:${col}/${id}`);
    if (col === 'blogs') return { id, title: 'Hello', status: 'published', slug: 'hello' };
    return null;
  },
  listDocs: async (col: string) => {
    adapterEvents.push(`adapter:listDocs:${col}`);
    if (col === 'blogs') return [{ id: 'b1', title: 'Hello', status: 'published', slug: 'hello' }];
    return [];
  },
  countDocs: async () => 0,
  setDoc: async (col: string, id: string) => {
    adapterEvents.push(`adapter:setDoc:${col}/${id}`);
    return { id };
  },
  updateDoc: async (col: string, id: string) => {
    adapterEvents.push(`adapter:updateDoc:${col}/${id}`);
    return { id };
  },
  deleteDoc: async (col: string, id: string) => {
    adapterEvents.push(`adapter:deleteDoc:${col}/${id}`);
  },
  tx: async (fn: string) => {
    adapterEvents.push(`adapter:tx:${fn}`);
    return txResultFor(fn);
  },
  rpc: async (fn: string) => {
    adapterEvents.push(`adapter:rpc:${fn}`);
    return txResultFor(fn);
  },
};

function tokenIn(raw: string | undefined, surface: string): boolean {
  if (!raw) return false;
  const tokens = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return tokens.includes('*') || tokens.includes(surface.trim().toLowerCase());
}

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => tokenIn(process.env.SUPA_SURFACES, surface),
  isSupaPrimary: (surface: string) =>
    tokenIn(process.env.SUPA_SURFACES, surface) && tokenIn(process.env.SUPA_PRIMARY, surface),
  getSupaClient: () => ({}),
  getSupaAdapter: () => fakeAdapter,
  createSupaAdapter: () => fakeAdapter,
}));

/* ------------------------------------------------- gated Firestore boundary */

import {
  FirestoreDataDisabledError,
  assertFirestoreDataEnabled,
} from '@/lib/firestore-kill-switch';

function poisonedRef(path: string): any {
  const ref: any = {
    id: path.split('/').pop(),
    path,
    collection: (name: string) => poisonedCollection(`${path}/${name}`),
    doc: (id?: string) => poisonedRef(`${path}/${id ?? 'auto-id'}`),
    get: async () => {
      firestoreAttempts.push(`data:get:${path}`);
      throw new FirestoreDataDisabledError(`data:get:${path}`);
    },
    set: async () => {
      firestoreAttempts.push(`data:set:${path}`);
      throw new FirestoreDataDisabledError(`data:set:${path}`);
    },
    update: async () => {
      firestoreAttempts.push(`data:update:${path}`);
      throw new FirestoreDataDisabledError(`data:update:${path}`);
    },
    delete: async () => {
      firestoreAttempts.push(`data:delete:${path}`);
      throw new FirestoreDataDisabledError(`data:delete:${path}`);
    },
  };
  return ref;
}

function poisonedCollection(path: string): any {
  const col: any = {
    id: path.split('/').pop(),
    path,
    doc: (id?: string) => poisonedRef(`${path}/${id ?? 'auto-id'}`),
    add: async () => {
      firestoreAttempts.push(`data:add:${path}`);
      throw new FirestoreDataDisabledError(`data:add:${path}`);
    },
    get: async () => {
      firestoreAttempts.push(`data:get:${path}`);
      throw new FirestoreDataDisabledError(`data:get:${path}`);
    },
    where: () => col,
    orderBy: () => col,
    limit: () => col,
  };
  return col;
}

const poisonedDb: any = {
  collection: (name: string) => poisonedCollection(name),
  doc: (path: string) => poisonedRef(path),
  batch: () => {
    firestoreAttempts.push('data:batch');
    throw new FirestoreDataDisabledError('data:batch');
  },
  runTransaction: async () => {
    firestoreAttempts.push('data:runTransaction');
    throw new FirestoreDataDisabledError('data:runTransaction');
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => {
    firestoreAttempts.push('boundary:ensureAdminInitialized');
    assertFirestoreDataEnabled('server:ensureAdminInitialized');
    return true;
  },
  getDb: () => {
    firestoreAttempts.push('boundary:getDb');
    assertFirestoreDataEnabled('server:getDb');
    return poisonedDb;
  },
  getAdminDiagnostics: () => ({ projectId: 'test' }),
  getLastAdminError: () => null,
  getAdminStorage: () => null,
  admin: {
    apps: [],
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => n,
        delete: () => 'del',
        arrayUnion: (v: unknown) => v,
        arrayRemove: (v: unknown) => v,
      },
    },
    auth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }),
  },
}));

jest.mock('firebase-admin', () => {
  const adminStub = {
    apps: [],
    app: () => ({ options: { projectId: 'test' } }),
    initializeApp: () => ({ options: { projectId: 'test' } }),
    credential: { cert: () => ({}), applicationDefault: () => ({}) },
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => n,
        delete: () => 'del',
        arrayUnion: (v: unknown) => v,
        arrayRemove: (v: unknown) => v,
      },
    },
    auth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }),
    storage: () => null,
  };
  return { __esModule: true, default: adminStub, ...adminStub };
});

/* ---------------------------------------------------------- imports */

import { setBlogPrimaryFirst, updateBlogPrimaryFirst } from '@/lib/server/blog-supa';
import { createBlogPost, getBlogBySlug } from '@/lib/server/blog-server';
import {
  __resetChaptersSupaAdapterForTests,
  __setChaptersSupaAdapterForTests,
  setChapterPrimaryFirst,
} from '@/lib/chapters-supa';
import {
  __setCrmSupaEnabledForTests,
  __setCrmSupaPortForTests,
  __setCrmSupaPrimaryForTests,
  setPartnerPrimaryFirst,
} from '@/lib/server/crm-supa';
import { setFormPrimaryFirst, setFormResponsePrimaryFirst } from '@/lib/server/forms-supa';
import { setResourcePrimaryFirst } from '@/lib/server/resources-supa';
import { setOrganizationPrimaryFirst } from '@/lib/server/organizations-supa';
import {
  setSettingsSupaAdapterForTests,
  setSettingsDocPrimaryFirst,
} from '@/lib/server/settings-mirror';
import {
  createNotificationPrimaryFirst,
  setNotificationsSupaAdapterForTests,
} from '@/lib/server/notifications-supa-seam';
import {
  __resetApplicationsSupaAdapterForTests,
  __setApplicationsSupaAdapterForTests,
  setApplicationPrimaryFirst,
} from '@/lib/applications-supa';
import {
  resetAdapterForTests as resetLeaveAdapterForTests,
  setAdapterForTests as setLeaveAdapterForTests,
  setLeaveRequestPrimaryFirst,
} from '@/lib/supa-seams/hr-leave';
import {
  __resetTasksSupaAdapterForTests,
  __setTasksSupaAdapterForTests,
  createTaskDocPrimaryFirst,
  deleteTaskDocWithPrimacy,
} from '@/lib/supa/seam-tasks-route';
import { callFinanceTx } from '@/lib/finance/supa/primary';
import { callStoreTx } from '@/lib/supa/store-primary';
import {
  runFreeRegistrationPrimary,
  runPaidRegistrationPrimary,
  setRegistrationsSupaAdapterForTests,
} from '@/lib/supa-events/registrations';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

/* ---------------------------------------------------------- lifecycle */

beforeEach(() => {
  adapterEvents.length = 0;
  firestoreAttempts.length = 0;
  process.env.FIRESTORE_DATA_DISABLED = '1';
  process.env.SUPA_SURFACES = SURFACES;
  process.env.SUPA_PRIMARY = SURFACES;
  __setChaptersSupaAdapterForTests(fakeAdapter as never);
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests(fakeAdapter as never);
  __setCrmSupaPrimaryForTests(true);
  setSettingsSupaAdapterForTests(fakeAdapter as never);
  setNotificationsSupaAdapterForTests(fakeAdapter as never);
  __setApplicationsSupaAdapterForTests(fakeAdapter as never);
  setLeaveAdapterForTests(fakeAdapter as never);
  __setTasksSupaAdapterForTests(fakeAdapter as never);
  setRegistrationsSupaAdapterForTests(fakeAdapter as never);
});

afterAll(() => {
  process.env = savedEnv;
  __resetChaptersSupaAdapterForTests();
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
  __setCrmSupaPrimaryForTests(undefined);
  setSettingsSupaAdapterForTests(null as never);
  setNotificationsSupaAdapterForTests(null as never);
  __resetApplicationsSupaAdapterForTests();
  resetLeaveAdapterForTests();
  __resetTasksSupaAdapterForTests();
  setRegistrationsSupaAdapterForTests(undefined);
});

/* ---------------------------------------------------------- seam level */

describe('PROVEN-SUPA-ONLY at seam level (primacy op completes, zero Firestore attempts)', () => {
  it('blog: setBlogPrimaryFirst + updateBlogPrimaryFirst land on the adapter only', async () => {
    await expect(setBlogPrimaryFirst('b1', { title: 'x' })).resolves.toBe(true);
    await expect(updateBlogPrimaryFirst('b1', { title: 'y' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:blogs/b1', 'adapter:updateDoc:blogs/b1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('chapters: setChapterPrimaryFirst lands on the adapter only', async () => {
    await expect(setChapterPrimaryFirst('ist', { name: 'IST' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:chapters/ist']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('crm: setPartnerPrimaryFirst lands on the port only', async () => {
    await expect(setPartnerPrimaryFirst('p1', { organizationName: 'X' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:sponsors_partners/p1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('forms: setFormPrimaryFirst + setFormResponsePrimaryFirst land on the adapter only', async () => {
    await expect(setFormPrimaryFirst('f1', { title: 'F' })).resolves.toBe(true);
    await expect(setFormResponsePrimaryFirst('f1', 'r1', { answer: 1 })).resolves.toBe(true);
    expect(adapterEvents).toEqual([
      'adapter:setDoc:forms/f1',
      'adapter:setDoc:forms/f1/responses/r1',
    ]);
    expect(firestoreAttempts).toEqual([]);
  });

  it('resources: setResourcePrimaryFirst lands on the adapter only', async () => {
    await expect(setResourcePrimaryFirst('r1', { title: 'R' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:resources/r1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('organizations: setOrganizationPrimaryFirst lands on the adapter only', async () => {
    await expect(setOrganizationPrimaryFirst('o1', { name: 'Org' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:organizations/o1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('admin-settings: setSettingsDocPrimaryFirst lands on the adapter only', async () => {
    await expect(
      setSettingsDocPrimaryFirst('settings', 'siteWide', { siteName: 'SEDS' }),
    ).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:settings/siteWide']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('notifications (own CRUD/create): createNotificationPrimaryFirst lands on the adapter only', async () => {
    await expect(
      createNotificationPrimaryFirst('users/u1/notifications', 'n1', { title: 'hi' }),
    ).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:users/u1/notifications/n1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('applications: setApplicationPrimaryFirst lands on the adapter only', async () => {
    await expect(setApplicationPrimaryFirst('a1', { status: 'pending' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:applications/a1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('leave (route half): setLeaveRequestPrimaryFirst lands on the adapter only', async () => {
    await expect(setLeaveRequestPrimaryFirst('l1', { status: 'pending' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:leave_requests/l1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('tasks: createTaskDocPrimaryFirst lands on the adapter only', async () => {
    await expect(createTaskDocPrimaryFirst('t1', { title: 'T' })).resolves.toBe(true);
    expect(adapterEvents).toEqual(['adapter:setDoc:tasks/t1']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('tasks: deleteTaskDocWithPrimacy completes even when the Firestore mirror delete throws disabled', async () => {
    const mirrorDelete = async () => {
      firestoreAttempts.push('data:delete:tasks/t1');
      throw new FirestoreDataDisabledError('data:delete:tasks/t1');
    };
    await expect(deleteTaskDocWithPrimacy('t1', mirrorDelete)).resolves.toBe('primary');
    expect(adapterEvents).toEqual(['adapter:deleteDoc:tasks/t1']);
    // The mirror was ATTEMPTED and its disabled failure swallowed by design.
    expect(firestoreAttempts).toEqual(['data:delete:tasks/t1']);
  });

  it('cron/compliance/backup handle family: SupaDbHandle doc set+get completes over the adapter', async () => {
    const handle = createSupaDbHandle(fakeAdapter as never);
    const ref = handle.collection('users').doc('u1');
    await ref.set({ name: 'U' });
    const snap = await ref.get();
    expect(adapterEvents).toContain('adapter:setDoc:users/u1');
    expect(firestoreAttempts).toEqual([]);
    expect(snap.id).toBe('u1');
  });
});

/* ------------------------------------------------- tx call-shape level */

describe('PROVEN-SUPA-ONLY at call-shape level (tx surfaces; SQL does not exist on the real project yet)', () => {
  it('finance: callFinanceTx issues exactly one tx() and no Firestore attempt', async () => {
    const res = await callFinanceTx(
      'finance_create_money_approval',
      'tx_finance_create_money_approval',
      { p_maker_uid: 'u1' },
      'create:order_verify_payment:ord-1:u1:hash',
    );
    expect(res).toEqual({ ok: true, created: true });
    expect(adapterEvents).toEqual(['adapter:tx:tx_finance_create_money_approval']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('store: callStoreTx issues exactly one tx() and no Firestore attempt', async () => {
    const res = await callStoreTx('tx_store_product_set', 'store_product_set', { p_id: 'p1' }, 'k1');
    expect(res).toMatchObject({ ok: true });
    expect(adapterEvents).toEqual(['adapter:tx:tx_store_product_set']);
    expect(firestoreAttempts).toEqual([]);
  });

  it('events (free): runFreeRegistrationPrimary completes via tx(); the Firestore mirror attempt is swallowed', async () => {
    const res = await runFreeRegistrationPrimary(poisonedDb, {
      eventId: 'e1',
      uid: 'u1',
      data: { whatsappE164: '+920000000000' },
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyRegistered).toBe(false);
    expect(adapterEvents).toEqual(['adapter:tx:tx_events_register_free']);
    // Mirror attempted against the poisoned handle and swallowed by design.
    expect(firestoreAttempts.length).toBeGreaterThan(0);
    expect(firestoreAttempts.every((a) => a.startsWith('data:'))).toBe(true);
  });

  it('events (paid): runPaidRegistrationPrimary completes via tx(); order + registration mirrors are swallowed', async () => {
    const orderRef = poisonedRef('orders/o1');
    const res = await runPaidRegistrationPrimary(poisonedDb, {
      eventId: 'e1',
      uid: 'u1',
      transactionId: 'tx1',
      orderRef,
      orderData: { total: 500 },
      buyer: { fullName: 'B', email: 'b@example.com' },
    } as never);
    expect(res.outcome).toBe('created');
    expect(adapterEvents).toEqual(['adapter:tx:tx_events_register_paid']);
    expect(firestoreAttempts.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------- caller level */

describe('caller level (canonical server flows)', () => {
  it('blog READ: getBlogBySlug serves from Supa with zero Firestore boundary attempts', async () => {
    const post = await getBlogBySlug('hello');
    expect(post?.title).toBe('Hello');
    expect(adapterEvents).toContain('adapter:listDocs:blogs');
    expect(firestoreAttempts).toEqual([]);
  });

  it('blog WRITE caller: createBlogPost STILL TOUCHES Firestore — getDb at entry (blog-server.ts)', async () => {
    await expect(createBlogPost({ title: 'hello' })).rejects.toBeInstanceOf(
      FirestoreDataDisabledError,
    );
    // The flow dies at the boundary BEFORE the primacy branch: it calls
    // ensureAdminInitialized() + getDb() unconditionally at entry and
    // mints the candidate id from a Firestore doc ref. The adapter
    // never receives the write. Exact sites are named in the report.
    expect(firestoreAttempts).toContain('boundary:ensureAdminInitialized');
    expect(adapterEvents).toEqual([]);
  });
});

/* ------------------------------------------------------------- control */

describe('control: primacy OFF + kill ON = the Firestore path is what breaks (the switch proves dependence)', () => {
  it('blog seam helpers go inert with SUPA_PRIMARY unset (caller would run Firestore-first)', async () => {
    delete process.env.SUPA_PRIMARY;
    await expect(setBlogPrimaryFirst('b1', { title: 'x' })).resolves.toBe(false);
    expect(adapterEvents).toEqual([]);
  });
});
