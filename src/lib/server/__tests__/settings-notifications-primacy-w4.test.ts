/**
 * @jest-environment node
 *
 * W4 primacy contracts — admin-settings (settings-mirror) and
 * notifications own-CRUD (notifications-supa-seam update/delete ops).
 * OFF pin: SUPA_PRIMARY unset => helpers inert.
 * ON: adapter write lands FIRST and THROWS on failure.
 * Everything mocked via the seams' test injection points; zero live reads.
 */
import {
  setSettingsSupaAdapterForTests,
  setGovernanceDocPrimaryFirst,
  setSettingsDocPrimaryFirst,
  settingsSupaPrimary,
} from '@/lib/server/settings-mirror';
import {
  deleteNotificationPrimaryFirst,
  notificationsSupaPrimary,
  setNotificationsSupaAdapterForTests,
  updateNotificationPrimaryFirst,
  userNotificationsPath,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

const events: string[] = [];
let failAdapter = false;

function fakeSettingsAdapter() {
  return {
    setDoc: async (col: string, id: string) => {
      events.push(`settings:setDoc:${col}:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
      return { id };
    },
  };
}

function fakeNotificationsAdapter(): NotificationsSupaAdapter {
  return {
    setDoc: async () => ({}) as any,
    updateDoc: async (path: string, id: string) => {
      events.push(`notif:updateDoc:${path}:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
      return {};
    },
    deleteDoc: async (path: string, id: string) => {
      events.push(`notif:deleteDoc:${path}:${id}`);
      if (failAdapter) throw new Error('simulated adapter failure');
    },
    listDocs: async () => [],
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  events.length = 0;
  failAdapter = false;
  process.env.SUPA_SURFACES = 'admin-settings,notifications';
  delete process.env.SUPA_PRIMARY;
  setSettingsSupaAdapterForTests(fakeSettingsAdapter() as any);
  setNotificationsSupaAdapterForTests(fakeNotificationsAdapter());
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = OLD_ENV;
  setSettingsSupaAdapterForTests(null as any);
  setNotificationsSupaAdapterForTests(null);
});

describe('admin-settings primacy', () => {
  it('OFF pin: helpers inert', async () => {
    expect(settingsSupaPrimary()).toBe(false);
    await expect(setSettingsDocPrimaryFirst('settings', 'discipline', { x: 1 })).resolves.toBe(false);
    await expect(setGovernanceDocPrimaryFirst('phase2', { y: 2 })).resolves.toBe(false);
    expect(events).toEqual([]);
  });

  it('ON: merge-set lands on the right collections; failure throws', async () => {
    process.env.SUPA_PRIMARY = 'admin-settings';
    expect(settingsSupaPrimary()).toBe(true);
    await expect(setSettingsDocPrimaryFirst('settings', 'discipline', { x: 1 })).resolves.toBe(true);
    await expect(setGovernanceDocPrimaryFirst('phase2', { y: 2 })).resolves.toBe(true);
    expect(events).toEqual([
      'settings:setDoc:settings:discipline',
      'settings:setDoc:governance_settings:phase2',
    ]);
    failAdapter = true;
    await expect(setSettingsDocPrimaryFirst('settings', 'discipline', {})).rejects.toThrow('simulated adapter failure');
  });
});

describe('notifications own-CRUD primacy', () => {
  it('OFF pin: update/delete helpers inert', async () => {
    expect(notificationsSupaPrimary()).toBe(false);
    await expect(updateNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', { isRead: true })).resolves.toBe(false);
    await expect(deleteNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1')).resolves.toBe(false);
    expect(events).toEqual([]);
  });

  it('ON: update/delete land; failure throws', async () => {
    process.env.SUPA_PRIMARY = 'notifications';
    expect(notificationsSupaPrimary()).toBe(true);
    await expect(updateNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', { isRead: true })).resolves.toBe(true);
    await expect(deleteNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1')).resolves.toBe(true);
    expect(events).toEqual([
      'notif:updateDoc:users/u1/notifications:n1',
      'notif:deleteDoc:users/u1/notifications:n1',
    ]);
    failAdapter = true;
    await expect(updateNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1', {})).rejects.toThrow('simulated adapter failure');
    await expect(deleteNotificationPrimaryFirst(userNotificationsPath('u1'), 'n1')).rejects.toThrow('simulated adapter failure');
  });
});
