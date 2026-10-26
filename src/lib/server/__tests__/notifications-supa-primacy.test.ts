/**
 * @jest-environment node
 *
 * Notifications seam — write primacy (cutover program, workflows POST
 * residual #2): createNotificationPrimaryFirst is the seam's one
 * adapter-first operation. It must be inert unless 'notifications' is
 * in BOTH SUPA_SURFACES and SUPA_PRIMARY (flag law, flags.ts
 * isSupaPrimary), must write the serialized body with the kit row
 * basis when active, must throw on adapter failure (the caller treats
 * that as a primary-write failure), and must resolve false when no
 * adapter is configured so the caller falls back to Firestore-first.
 * Mock adapter only — no live Supabase, no live Firestore.
 */

import {
  createNotificationPrimaryFirst,
  notificationsSupaPrimary,
  setNotificationsSupaAdapterForTests,
  userNotificationsPath,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

function makeAdapter(overrides: Partial<NotificationsSupaAdapter> = {}) {
  const calls = { setDoc: [] as any[] };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => { calls.setDoc.push(args); },
    updateDoc: async () => undefined,
    deleteDoc: async () => undefined,
    listDocs: async () => [],
    ...overrides,
  };
  return { adapter, calls };
}

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  setNotificationsSupaAdapterForTests(null);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPA_PRIMARY;
  setNotificationsSupaAdapterForTests(null);
  (console.warn as jest.Mock).mockRestore?.();
});

describe('notificationsSupaPrimary flag law', () => {
  it('is false by default and when only one token names the surface', () => {
    expect(notificationsSupaPrimary()).toBe(false);
    process.env.SUPA_PRIMARY = 'notifications';
    expect(notificationsSupaPrimary()).toBe(false); // SUPA_SURFACES alone gates first
    delete process.env.SUPA_PRIMARY;
    process.env.SUPA_SURFACES = 'notifications';
    expect(notificationsSupaPrimary()).toBe(false); // dual-write only
  });

  it('is true when both name notifications (case/space-insensitive, * counts)', () => {
    process.env.SUPA_SURFACES = ' announcements , Notifications ';
    process.env.SUPA_PRIMARY = 'tasks,notifications';
    expect(notificationsSupaPrimary()).toBe(true);
    process.env.SUPA_PRIMARY = '*';
    expect(notificationsSupaPrimary()).toBe(true);
    process.env.SUPA_PRIMARY = 'tasks';
    expect(notificationsSupaPrimary()).toBe(false);
  });
});

describe('createNotificationPrimaryFirst', () => {
  it('resolves false and never touches the adapter when primacy is off (incl. dual-write)', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    await expect(
      createNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', { title: 'T' }),
    ).resolves.toBe(false);
    process.env.SUPA_SURFACES = 'notifications'; // dual-write today: mirror's job, not primacy's
    await expect(
      createNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', { title: 'T' }),
    ).resolves.toBe(false);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('writes the adapter first with path, id and the serialized body when primary', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    process.env.SUPA_PRIMARY = 'notifications';
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const ok = await createNotificationPrimaryFirst(userNotificationsPath('u9'), 'doc1', {
      title: 'T',
      timestamp: new Date('2026-10-25T05:00:00.000Z'),
    });
    expect(ok).toBe(true);
    expect(calls.setDoc).toEqual([
      ['users/u9/notifications', 'doc1', { title: 'T', timestamp: '2026-10-25T05:00:00.000Z' }],
    ]);
  });

  it('throws on adapter failure so the caller sees a primary-write failure', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    process.env.SUPA_PRIMARY = 'notifications';
    const { adapter } = makeAdapter({
      setDoc: async () => { throw new Error('supa down'); },
    });
    setNotificationsSupaAdapterForTests(adapter);
    await expect(
      createNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', { title: 'T' }),
    ).rejects.toThrow('supa down');
  });

  it('resolves false when primary is named but no adapter is configured', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    process.env.SUPA_PRIMARY = 'notifications';
    setNotificationsSupaAdapterForTests(null);
    await expect(
      createNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', { title: 'T' }),
    ).resolves.toBe(false);
  });
});
