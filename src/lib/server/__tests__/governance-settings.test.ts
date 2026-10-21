/**
 * @jest-environment node
 *
 * Tests for the Phase 2 governance settings accessor (spec Section 0.1).
 */
import {
  DEFAULT_GOVERNANCE_SETTINGS,
  getConsentGateMode,
  getGovernanceSettings,
  isPhase2Live,
} from '@/lib/server/governance-settings';

function mockDb(stored: Record<string, unknown> | null, throws = false) {
  return {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => {
          if (throws) throw new Error('firestore down');
          if (stored === null) return { exists: false, data: () => undefined };
          return { exists: true, data: () => stored };
        }),
      })),
    })),
  } as any;
}

describe('getGovernanceSettings', () => {
  it('returns defaults when the doc is missing', async () => {
    const settings = await getGovernanceSettings(mockDb(null));
    expect(settings).toEqual(DEFAULT_GOVERNANCE_SETTINGS);
    expect(settings.flags.consentLive).toBe(false);
  });

  it('merges stored values over defaults', async () => {
    const settings = await getGovernanceSettings(
      mockDb({
        consentGateMode: { sponsor_partner: 'hard' },
        flags: { consentLive: true },
        probationRestoreMode: 'reappoint',
      }),
    );
    expect(settings.consentGateMode.sponsor_partner).toBe('hard');
    expect(settings.consentGateMode.category_b_appointment).toBe('hard');
    expect(settings.flags.consentLive).toBe(true);
    expect(settings.flags.boardLive).toBe(false);
    expect(settings.probationRestoreMode).toBe('reappoint');
  });

  it('fails closed (defaults) when Firestore errors', async () => {
    const settings = await getGovernanceSettings(mockDb(null, true));
    expect(settings.flags).toEqual(DEFAULT_GOVERNANCE_SETTINGS.flags);
  });

  it('ignores invalid stored values', async () => {
    const settings = await getGovernanceSettings(
      mockDb({ consentGateMode: { chapter_lifecycle: 'bogus' }, flags: { boardLive: 'yes' } }),
    );
    expect(settings.consentGateMode.chapter_lifecycle).toBe('hard');
    expect(settings.flags.boardLive).toBe(false);
  });
});

describe('getConsentGateMode / isPhase2Live', () => {
  it('a missing matter-class key means hard (fail closed)', async () => {
    await expect(getConsentGateMode(mockDb({}), 'some_unknown_class')).resolves.toBe('hard');
  });
  it('reads stored modes', async () => {
    await expect(getConsentGateMode(mockDb({}), 'sponsor_partner')).resolves.toBe('record');
  });
  it('flags default false and read stored true', async () => {
    await expect(isPhase2Live(mockDb(null), 'boardLive')).resolves.toBe(false);
    await expect(isPhase2Live(mockDb({ flags: { boardLive: true } }), 'boardLive')).resolves.toBe(true);
  });
});
