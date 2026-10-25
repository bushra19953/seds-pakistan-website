/**
 * @jest-environment node
 *
 * GAP-N1 closure — top-level `notifications` writers that bypassed the
 * mirrored helper modules:
 *   - src/lib/governance/offices.ts        notifyOffice (.add)
 *   - src/lib/server/lifecycle-adapters.ts sendLifecycleNotification
 *     (fallback .add only; the primary path goes through
 *     notificationService.send, already mirrored in that service)
 *   - src/lib/server/election-ports.ts     createDefaultNotificationPort
 *     (Firestore fallback only; the supa-first path already wrote the
 *     notification to Supabase and returns before the Firestore write)
 *
 * Per site: flag ON (SUPA_SURFACES=notifications, injected adapter) ->
 * mirrorNotificationCreate fires with the top-level path 'notifications'
 * (fs_notifications); flag OFF -> no mirror call; adapter failure ->
 * the caller's result is unchanged (mirrors never throw).
 */

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'SERVER_TS' },
      Timestamp: { now: () => ({ toDate: () => new Date() }) },
    },
  },
}));

const mockServiceSend = jest.fn(async () => undefined);
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: (...args: any[]) => mockServiceSend(...args) },
}));

import { notifyOffice } from '@/lib/governance/offices';
import { sendLifecycleNotification } from '@/lib/server/lifecycle-adapters';
import { createDefaultNotificationPort } from '@/lib/server/election-ports';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

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

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  mockServiceSend.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------- offices */

function officesDb() {
  const adds: any[] = [];
  const db: any = {
    collection: (name: string) => ({
      where: (field: string) => ({
        get: async () => {
          if (name === 'roles' && field === 'role') {
            return { docs: [{ id: 'holder-1', data: () => ({}) }] };
          }
          if (name === 'users') {
            return { docs: [{ id: 'holder-1', data: () => ({ displayName: 'Holder One' }) }] };
          }
          return { docs: [] };
        },
      }),
      get: async () => ({ docs: [] }),
      add: async (data: any) => {
        adds.push(data);
        return { id: 'notif-office-1' };
      },
    }),
  };
  return { db, adds };
}

describe('offices.notifyOffice', () => {
  it('flag ON: mirrors the top-level write to path notifications', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db, adds } = officesDb();
    const res = await notifyOffice(db, 'national_treasurer' as any, { title: 'T', body: 'B' }, 'founder-1');
    expect(res).toEqual({ deliveredTo: 'holder-1', vacant: false });
    expect(adds).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('notifications');
    expect(calls.setDoc[0][1]).toBe('notif-office-1');
    expect(calls.setDoc[0][2]).toMatchObject({ userId: 'holder-1', title: 'T', message: 'B', type: 'office' });
    // createdAt Date is serialized to an ISO string for jsonb.
    expect(typeof calls.setDoc[0][2].createdAt).toBe('string');
  });

  it('flag OFF: Firestore write only, no mirror call', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, adds } = officesDb();
    const res = await notifyOffice(db, 'national_treasurer' as any, { title: 'T', body: 'B' }, 'founder-1');
    expect(res.deliveredTo).toBe('holder-1');
    expect(adds).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: result unchanged', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db } = officesDb();
    const res = await notifyOffice(db, 'national_treasurer' as any, { title: 'T', body: 'B' }, 'founder-1');
    expect(res).toEqual({ deliveredTo: 'holder-1', vacant: false });
  });
});

/* --------------------------------------------------- lifecycle fallback */

function lifecycleDb() {
  const adds: any[] = [];
  const db: any = {
    collection: (name: string) => ({
      add: async (data: any) => {
        adds.push({ collection: name, data });
        return { id: 'notif-life-1' };
      },
    }),
  };
  return { db, adds };
}

describe('lifecycle sendLifecycleNotification fallback', () => {
  it('flag ON: fallback .add is mirrored to path notifications', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db, adds } = lifecycleDb();
    // No string title/body -> the typed service cannot be used -> fallback.
    await sendLifecycleNotification(db, 'user-9', 'probation_note', { detail: 'x' });
    expect(mockServiceSend).not.toHaveBeenCalled();
    expect(adds).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('notifications');
    expect(calls.setDoc[0][1]).toBe('notif-life-1');
    expect(calls.setDoc[0][2]).toMatchObject({ userId: 'user-9', type: 'probation_note', read: false });
  });

  it('flag OFF: fallback write only, no mirror call', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, adds } = lifecycleDb();
    await sendLifecycleNotification(db, 'user-9', 'probation_note', { detail: 'x' });
    expect(adds).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: function still resolves (never throws)', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db } = lifecycleDb();
    await expect(
      sendLifecycleNotification(db, 'user-9', 'probation_note', { detail: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('primary path (title+body) still routes via notificationService, no direct write', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db, adds } = lifecycleDb();
    await sendLifecycleNotification(db, 'user-9', 'probation_cleared', { title: 'Hi', body: 'There' });
    expect(mockServiceSend).toHaveBeenCalledTimes(1);
    expect(adds).toHaveLength(0);
    expect(calls.setDoc).toHaveLength(0); // the service performs its own mirror
  });
});

/* ------------------------------------------------ election-ports port */

function electionDb() {
  const sets: Array<{ id: string; data: any }> = [];
  let n = 0;
  const db: any = {
    collection: () => ({
      doc: () => {
        const id = `elec-doc-${++n}`;
        return { id, set: async (data: any) => { sets.push({ id, data }); } };
      },
    }),
  };
  return { db, sets };
}

describe('election-ports createDefaultNotificationPort (Firestore fallback)', () => {
  it('flag ON: mirrors the fallback write to path notifications with the Firestore doc id', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db, sets } = electionDb();
    const port = createDefaultNotificationPort(db);
    const res = await port.notifyUser({ uid: 'voter-1', type: 'election', title: 'Vote', message: 'Now' } as any);
    expect(res.inApp).toBe('created');
    expect(sets).toHaveLength(1);
    expect(res.inAppNotificationId).toBe(sets[0].id);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('notifications');
    expect(calls.setDoc[0][1]).toBe(sets[0].id);
    expect(calls.setDoc[0][2]).toMatchObject({ userId: 'voter-1', title: 'Vote' });
  });

  it('flag OFF: Firestore write only, no mirror call', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const { db, sets } = electionDb();
    const port = createDefaultNotificationPort(db);
    const res = await port.notifyUser({ uid: 'voter-1', type: 'election', title: 'Vote', message: 'Now' } as any);
    expect(res.inApp).toBe('created');
    expect(sets).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: port still reports created', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const { db } = electionDb();
    const port = createDefaultNotificationPort(db);
    const res = await port.notifyUser({ uid: 'voter-1', type: 'election', title: 'Vote', message: 'Now' } as any);
    expect(res.inApp).toBe('created');
    expect(res.inAppNotificationId).toBeTruthy();
  });
});
