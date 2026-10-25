/**
 * @jest-environment node
 *
 * settings-mirror tests (in-memory fake adapter only; zero live reads).
 * Contract: payload equality with the primary write, mirror failure
 * returns false and never throws, flag-off means no adapter call.
 */
import {
  buildSettingsMirrorPayload,
  mirrorGovernanceDoc,
  mirrorSettingsDoc,
  setSettingsSupaAdapterForTests,
  settingsSupaEnabled,
  type SettingsSupaAdapter,
} from '../settings-mirror';

const PAYLOAD = {
  shadowMode: false,
  cronReferralLive: true,
  referralWindowDays: 14,
  referralMissThreshold: 2,
  warningRegistryVariant: 'internal',
  updatedAt: '2026-10-25T12:00:00.000Z',
  updatedBy: 'admin-1',
};

function fakeAdapter(impl?: SettingsSupaAdapter['setDoc']) {
  const calls: Array<{ collection: string; id: string; data: any; options: any }> = [];
  const adapter: SettingsSupaAdapter = {
    setDoc: jest.fn(async (collection: string, id: string, data: any, options?: any) => {
      calls.push({ collection, id, data, options });
      if (impl) return impl(collection, id, data, options);
      return { id, ...data };
    }),
  };
  return { adapter, calls };
}

const ORIGINAL_ENV = process.env.SUPA_SURFACES;

beforeEach(() => {
  process.env.SUPA_SURFACES = 'admin-settings';
  setSettingsSupaAdapterForTests(null);
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_ENV;
  setSettingsSupaAdapterForTests(undefined as never);
});

describe('flag gate', () => {
  it("is on for 'admin-settings' and '*', off otherwise", () => {
    process.env.SUPA_SURFACES = 'admin-settings';
    expect(settingsSupaEnabled()).toBe(true);
    process.env.SUPA_SURFACES = ' Admin-Settings , other';
    expect(settingsSupaEnabled()).toBe(true);
    process.env.SUPA_SURFACES = '*';
    expect(settingsSupaEnabled()).toBe(true);
    process.env.SUPA_SURFACES = 'notifications';
    expect(settingsSupaEnabled()).toBe(false);
    delete process.env.SUPA_SURFACES;
    expect(settingsSupaEnabled()).toBe(false);
  });

  it('flag off -> no adapter call, returns false', async () => {
    process.env.SUPA_SURFACES = 'notifications';
    const { adapter, calls } = fakeAdapter();
    setSettingsSupaAdapterForTests(adapter);
    await expect(mirrorSettingsDoc('settings', 'discipline', PAYLOAD)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });
});

describe('buildSettingsMirrorPayload', () => {
  it('passes a plain primary payload through unchanged (payload equality)', () => {
    expect(buildSettingsMirrorPayload(PAYLOAD)).toEqual(PAYLOAD);
  });

  it('converts Date and Timestamp-like values to ISO; sentinel becomes now', () => {
    const now = new Date('2026-10-25T12:00:00.000Z');
    const sentinel = new (class {
      readonly _methodName = 'serverTimestamp';
    })();
    const out = buildSettingsMirrorPayload(
      {
        a: new Date('2026-01-01T00:00:00.000Z'),
        b: { toDate: () => new Date('2026-02-02T00:00:00.000Z') },
        c: sentinel,
        d: 'plain',
      },
      now,
    );
    expect(out).toEqual({
      a: '2026-01-01T00:00:00.000Z',
      b: '2026-02-02T00:00:00.000Z',
      c: '2026-10-25T12:00:00.000Z',
      d: 'plain',
    });
  });
});

describe('mirrorSettingsDoc / mirrorGovernanceDoc', () => {
  it('writes the exact primary payload to settings/discipline with merge', async () => {
    const { adapter, calls } = fakeAdapter();
    setSettingsSupaAdapterForTests(adapter);
    await expect(mirrorSettingsDoc('settings', 'discipline', PAYLOAD)).resolves.toBe(true);
    expect(calls).toEqual([
      { collection: 'settings', id: 'discipline', data: PAYLOAD, options: { merge: true } },
    ]);
  });

  it('mirrors governance to governance_settings/phase2', async () => {
    const { adapter, calls } = fakeAdapter();
    setSettingsSupaAdapterForTests(adapter);
    const govPayload = {
      flags: { consentLive: true },
      updatedAt: '2026-10-25T12:00:00.000Z',
      updatedBy: 'founder-1',
      changeReason: 'turn consent live now',
    };
    await expect(mirrorGovernanceDoc('phase2', govPayload)).resolves.toBe(true);
    expect(calls).toEqual([
      {
        collection: 'governance_settings',
        id: 'phase2',
        data: govPayload,
        options: { merge: true },
      },
    ]);
  });

  it('adapter failure -> returns false and never throws', async () => {
    const { adapter } = fakeAdapter(async () => {
      throw new Error('supa down');
    });
    setSettingsSupaAdapterForTests(adapter);
    await expect(mirrorSettingsDoc('settings', 'siteWide', PAYLOAD)).resolves.toBe(false);
    await expect(mirrorGovernanceDoc('phase2', PAYLOAD)).resolves.toBe(false);
  });

  it('no adapter (unconfigured) -> returns false', async () => {
    setSettingsSupaAdapterForTests(null);
    await expect(mirrorSettingsDoc('settings', 'discipline', PAYLOAD)).resolves.toBe(false);
  });
});
