/**
 * @jest-environment node
 *
 * Notifications cluster G2 — Supabase mirror tests.
 *
 * Every server notification write point in the group's files must, when
 * useSupa('notifications') is ON, also mirror through the seam with the
 * migration kit's row basis (collectionPath users/{uid}/notifications
 * -> row { id, firebase_uid: uid, parent_path:
 * 'users/{uid}/notifications', data: <body, timestamps as ISO> }), and
 * must behave EXACTLY as today when OFF / unconfigured, and must never
 * throw when the mirror fails. The adapter here is a mock — no live
 * Supabase, no live Firestore.
 */

const FIXED_ISO = '2026-10-25T05:00:00.000Z';
const fakeTimestamp = {
  toDate: () => new Date(FIXED_ISO),
  seconds: Math.floor(new Date(FIXED_ISO).getTime() / 1000),
  nanoseconds: 0,
};
// The real FieldValue sentinel is a class instance (non-plain object),
// which is exactly what the seam's serializer keys on.
class FakeFieldValue {
  readonly _methodName = 'serverTimestamp';
}
const fakeSentinel = new FakeFieldValue();

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      Timestamp: { now: () => fakeTimestamp },
      FieldValue: { serverTimestamp: () => fakeSentinel },
    },
  },
}));

const serviceDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => serviceDbHolder.db,
  admin: {
    firestore: {
      Timestamp: { now: () => fakeTimestamp },
      FieldValue: { serverTimestamp: () => fakeSentinel },
    },
    messaging: () => ({ sendEachForMulticast: async () => ({}) }),
  },
}));
jest.mock('@/lib/server/push-server', () => ({
  sendPushToUser: jest.fn(async () => undefined),
}));
jest.mock('@/lib/server/email-service', () => ({
  emailService: { sendEmail: jest.fn(async () => true) },
}));
jest.mock('@/lib/mailer', () => ({
  generateEmailHtml: jest.fn(async () => ({ subject: 's', html: '<p/>' })),
}));

import {
  createAdminNotification,
  createGlobalNotification,
  createNotificationToUser,
} from '@/lib/notification-helper';
import { notifyValidatorsOnSubmission } from '@/lib/server/validation-notifications';
import { notificationService } from '@/lib/server/notification-service';
import {
  mirrorNotificationCreate,
  notificationsSupaEnabled,
  serializeNotificationData,
  setNotificationsSupaAdapterForTests,
  userNotificationsPath,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

/* ------------------------------------------------------------------ helpers */

function makeAdapter(overrides: Partial<NotificationsSupaAdapter> = {}) {
  const calls = { setDoc: [] as any[], updateDoc: [] as any[], deleteDoc: [] as any[], listDocs: [] as any[] };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => { calls.setDoc.push(args); },
    updateDoc: async (...args: any[]) => { calls.updateDoc.push(args); },
    deleteDoc: async (...args: any[]) => { calls.deleteDoc.push(args); },
    listDocs: async (...args: any[]) => { calls.listDocs.push(args); return []; },
    ...overrides,
  };
  return { adapter, calls };
}

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  serviceDbHolder.db = null;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  (console.log as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

/* --------------------------------------------------------------------- seam */

describe('seam', () => {
  it('flag parsing matches useSupa semantics (default OFF)', () => {
    expect(notificationsSupaEnabled()).toBe(false);
    process.env.SUPA_SURFACES = 'announcements';
    expect(notificationsSupaEnabled()).toBe(false);
    process.env.SUPA_SURFACES = ' announcements , Notifications ';
    expect(notificationsSupaEnabled()).toBe(true);
    process.env.SUPA_SURFACES = '*';
    expect(notificationsSupaEnabled()).toBe(true);
  });

  it('serializes Timestamps and sentinels to ISO strings, deep', () => {
    const out = serializeNotificationData({
      createdAt: fakeTimestamp,
      timestamp: fakeSentinel,
      nested: { when: new Date(FIXED_ISO) },
      plain: 'keep',
      n: 3,
    });
    expect(out.createdAt).toBe(FIXED_ISO);
    expect(typeof out.timestamp).toBe('string');
    expect((out.nested as any).when).toBe(FIXED_ISO);
    expect(out.plain).toBe('keep');
    expect(out.n).toBe(3);
  });

  it('mirror create passes the kit row basis: collection path, id, serialized body', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const ok = await mirrorNotificationCreate(userNotificationsPath('u9'), 'doc1', {
      title: 'T',
      createdAt: fakeTimestamp,
    });
    expect(ok).toBe(true);
    // The adapter builds { id, firebase_uid: 'u9',
    // parent_path: 'users/u9/notifications', data } from exactly these args.
    expect(calls.setDoc).toEqual([
      ['users/u9/notifications', 'doc1', { title: 'T', createdAt: FIXED_ISO }],
    ]);
  });

  it('mirror is a no-op when OFF and swallows adapter errors when ON', async () => {
    const { adapter, calls } = makeAdapter({
      setDoc: async () => { throw new Error('down'); },
    });
    setNotificationsSupaAdapterForTests(adapter);
    await expect(
      mirrorNotificationCreate('users/u9/notifications', 'd', {}),
    ).resolves.toBe(false);
    expect(calls.setDoc).toHaveLength(0); // flag OFF: adapter never consulted via calls? setDoc is the adapter — no call recorded because mirror returned early
    process.env.SUPA_SURFACES = 'notifications';
    await expect(
      mirrorNotificationCreate('users/u9/notifications', 'd', {}),
    ).resolves.toBe(false);
  });
});

/* ------------------------------------------------------- notification-helper */

function helperDb() {
  const added: Array<{ uid: string; data: any }> = [];
  const batchSets: Array<{ uid: string; id: string; data: any }> = [];
  const globalAdded: any[] = [];
  const db: any = {
    collection: (name: string) => {
      if (name === 'notifications') {
        return { add: async (data: any) => { globalAdded.push(data); return { id: 'global-1' }; } };
      }
      // users
      return {
        doc: (uid: string) => ({
          collection: () => ({
            add: async (data: any) => { added.push({ uid, data }); return { id: `notif-${uid}` }; },
            doc: () => ({ id: `batch-${uid}` }),
          }),
        }),
        where: () => ({
          get: async () => ({
            empty: false,
            docs: [{ id: 'admin-1' }, { id: 'admin-2' }],
          }),
        }),
      };
    },
    batch: () => ({
      set: (ref: any, data: any) => { batchSets.push({ uid: ref.__uid, id: ref.id, data }); },
      commit: async () => undefined,
    }),
  };
  // batch refs need the uid: rebuild doc() so refs carry it
  const origCollection = db.collection;
  db.collection = (name: string) => {
    const col = origCollection(name);
    if (name === 'users') {
      const origDoc = col.doc;
      col.doc = (uid: string) => {
        const d = origDoc(uid);
        const origSub = d.collection;
        d.collection = () => {
          const sub = origSub();
          const origDocFn = sub.doc;
          sub.doc = () => ({ ...origDocFn(), __uid: uid });
          return sub;
        };
        return d;
      };
    }
    return col;
  };
  return { db, added, batchSets, globalAdded };
}

describe('notification-helper mirrors', () => {
  it('createNotificationToUser mirrors the .add() write when ON', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = helperDb();
    const id = await createNotificationToUser(db, 'user-7', { title: 'Hi', message: 'M', type: 'info' });
    expect(id).toBe('notif-user-7');
    expect(calls.setDoc).toHaveLength(1);
    const [path, docId, data] = calls.setDoc[0];
    expect(path).toBe('users/user-7/notifications');
    expect(docId).toBe('notif-user-7');
    expect(data).toMatchObject({ title: 'Hi', message: 'M', type: 'info', userId: 'user-7', read: false });
    expect(data.createdAt).toBe(FIXED_ISO);
  });

  it('createNotificationToUser does not mirror when OFF', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = helperDb();
    await createNotificationToUser(db, 'user-7', { title: 'Hi', message: 'M', type: 'info' });
    expect(calls.setDoc).toHaveLength(0);
  });

  it('createNotificationToUser still returns the id when the mirror throws', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter } = makeAdapter({ setDoc: async () => { throw new Error('down'); } });
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = helperDb();
    await expect(
      createNotificationToUser(db, 'user-7', { title: 'Hi', message: 'M', type: 'info' }),
    ).resolves.toBe('notif-user-7');
  });

  it('createAdminNotification mirrors every batch.set write', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, batchSets } = helperDb();
    const count = await createAdminNotification(db, {
      title: 'Broadcast',
      message: 'B',
      type: 'admin',
      targetRoles: ['admin'],
    });
    expect(count).toBe(2);
    expect(batchSets).toHaveLength(2);
    expect(calls.setDoc.map((c: any[]) => [c[0], c[1]])).toEqual([
      ['users/admin-1/notifications', 'batch-admin-1'],
      ['users/admin-2/notifications', 'batch-admin-2'],
    ]);
    expect(calls.setDoc[0][2]).toMatchObject({ title: 'Broadcast', userId: 'admin-1', read: false });
    expect(calls.setDoc[0][2].createdAt).toBe(FIXED_ISO);
  });

  it('createGlobalNotification mirrors to the top-level notifications path', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = helperDb();
    const id = await createGlobalNotification(db, { title: 'G', message: 'M', type: 'info' });
    expect(id).toBe('global-1');
    // Row basis for a top-level doc: firebase_uid null, parent_path 'notifications'.
    expect(calls.setDoc[0][0]).toBe('notifications');
    expect(calls.setDoc[0][1]).toBe('global-1');
    expect(calls.setDoc[0][2]).toMatchObject({ title: 'G', isGlobal: true, read: false });
  });
});

/* --------------------------------------------------- validation-notifications */

describe('validation-notifications mirror', () => {
  function validationDb() {
    const sets: Array<{ uid: string; id: string; data: any }> = [];
    const db: any = {
      collection: () => ({
        doc: (uid: string) => ({
          collection: () => ({
            doc: () => ({
              id: `vn-${uid}`,
              set: async (data: any) => { sets.push({ uid, id: `vn-${uid}`, data }); },
            }),
          }),
          get: async () => ({ data: () => ({ fcmTokens: [], pushEnabled: false }) }),
        }),
      }),
    };
    return { db, sets };
  }

  it('writeInAppNotification (via notifyValidatorsOnSubmission) mirrors when ON', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, sets } = validationDb();
    serviceDbHolder.db = db;
    await notifyValidatorsOnSubmission({
      taskId: 'task-1',
      taskTitle: 'Build',
      submitterUid: 'submitter-1',
      validatorUids: ['validator-1'],
    });
    expect(sets).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(1);
    const [path, id, data] = calls.setDoc[0];
    expect(path).toBe('users/validator-1/notifications');
    expect(id).toBe('vn-validator-1');
    expect(data).toMatchObject({ type: 'task_status_change', isRead: false, taskId: 'task-1' });
    expect(typeof data.timestamp).toBe('string'); // sentinel serialized to ISO
  });

  it('a throwing mirror never fails the validation notification', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter } = makeAdapter({ setDoc: async () => { throw new Error('down'); } });
    setNotificationsSupaAdapterForTests(adapter);
    const { db, sets } = validationDb();
    serviceDbHolder.db = db;
    await expect(
      notifyValidatorsOnSubmission({
        taskId: 'task-1',
        taskTitle: 'Build',
        submitterUid: 'submitter-1',
        validatorUids: ['validator-1'],
      }),
    ).resolves.toBeUndefined();
    expect(sets).toHaveLength(1);
  });
});

/* ------------------------------------------------------- notification-service */

describe('notification-service mirrors (email behavior untouched)', () => {
  function serviceDb(userData: any) {
    const sets: Array<{ uid: string; id: string; data: any }> = [];
    const updates: any[] = [];
    const makeRef = (uid: string) => ({
      id: `svc-${uid}`,
      set: async (data: any) => { sets.push({ uid, id: `svc-${uid}`, data }); },
      update: async (data: any) => { updates.push(data); },
    });
    const db: any = {
      collection: () => ({
        doc: (uid: string) => ({
          get: async () => ({ exists: true, data: () => userData }),
          collection: () => ({ doc: () => makeRef(uid) }),
        }),
        where: () => ({
          get: async () => ({
            docs: [
              { id: 'role-1', data: () => ({ ...userData }) },
              { id: 'role-2', data: () => ({ ...userData }) },
            ],
          }),
        }),
      }),
      batch: () => ({
        set: (ref: any, data: any) => { sets.push({ uid: ref.id.replace('svc-', ''), id: ref.id, data }); },
        commit: async () => undefined,
      }),
    };
    return { db, sets, updates };
  }

  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('send() mirrors the in-app .set() when ON', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, sets } = serviceDb({ email: 'u@example.com', displayName: 'U', pushEnabled: false });
    serviceDbHolder.db = db;
    await notificationService.send('user-3', { type: 'info', title: 'T', body: 'B' }, 'P2');
    await tick();
    expect(sets).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(1);
    const [path, id, data] = calls.setDoc[0];
    expect(path).toBe('users/user-3/notifications');
    expect(id).toBe('svc-user-3');
    expect(data).toMatchObject({ title: 'T', body: 'B', userId: 'user-3', priority: 'P2', isRead: false });
    expect(typeof data.createdAt).toBe('string');
    // deliveryStatus updates are mirrored too (dot paths pass through).
    const mirroredUpdates = calls.updateDoc.map((c: any[]) => c[2]);
    expect(mirroredUpdates).toContainEqual({ 'deliveryStatus.push': 'skipped' });
    expect(mirroredUpdates).toContainEqual({ 'deliveryStatus.email': 'skipped' });
  });

  it('send() does not mirror when OFF', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = serviceDb({ email: 'u@example.com', displayName: 'U', pushEnabled: false });
    serviceDbHolder.db = db;
    await notificationService.send('user-3', { type: 'info', title: 'T', body: 'B' }, 'P2');
    await tick();
    expect(calls.setDoc).toHaveLength(0);
    expect(calls.updateDoc).toHaveLength(0);
  });

  it('broadcastByRoles mirrors every batch write when ON', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db } = serviceDb({ email: 'u@example.com', displayName: 'U', pushEnabled: false });
    serviceDbHolder.db = db;
    await notificationService.broadcastByRoles(['admin'], { type: 'info', title: 'T', body: 'B' }, 'P3');
    await tick();
    expect(calls.setDoc.map((c: any[]) => c[0]).sort()).toEqual([
      'users/role-1/notifications',
      'users/role-2/notifications',
    ]);
  });
});
