/**
 * Suite H resolver (spec R1-R7): the pure effective-site-state
 * resolver. The governing principle under test: the site is ENABLED
 * unless an affirmative, well-formed record says otherwise.
 */

import { computeEffectiveSiteState } from '@/lib/site-state';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('computeEffectiveSiteState', () => {
  it('R1: defaults to live with absent settings and absent licence', () => {
    expect(computeEffectiveSiteState(null, null, NOW).mode).toBe('live');
    expect(computeEffectiveSiteState(undefined, undefined, NOW).mode).toBe('live');
    expect(computeEffectiveSiteState({}, null, NOW).mode).toBe('live');
  });

  it('R2: siteEnabled false disables; maintenanceMode true maintains; defaults live', () => {
    expect(computeEffectiveSiteState({ siteEnabled: false }, null, NOW).mode).toBe('disabled');
    expect(computeEffectiveSiteState({ maintenanceMode: true }, null, NOW).mode).toBe('maintenance');
    expect(
      computeEffectiveSiteState(
        { siteEnabled: true, maintenanceMode: false },
        null,
        NOW,
      ).mode,
    ).toBe('live');
    // Non-boolean junk does not count as an affirmative switch.
    expect(computeEffectiveSiteState({ siteEnabled: 'no' }, null, NOW).mode).toBe('live');
    expect(computeEffectiveSiteState({ maintenanceMode: 'yes' }, null, NOW).mode).toBe('live');
  });

  it('R3: active and expired licences never block; unknown status is none', () => {
    expect(computeEffectiveSiteState({}, { status: 'active' }, NOW).mode).toBe('live');
    expect(computeEffectiveSiteState({}, { status: 'expired' }, NOW).mode).toBe('live');
    expect(computeEffectiveSiteState({}, { status: 'garbage' }, NOW).mode).toBe('live');
    expect(computeEffectiveSiteState({}, { status: 42 }, NOW).mode).toBe('live');
  });

  it('R4: notice_served runs the notice, then revokes at the effective time', () => {
    const licence = {
      status: 'notice_served',
      effectiveRevocationAt: new Date(NOW + 3 * DAY).toISOString(),
      licencePublicNotice: 'Licence revoked by the licensor.',
    };
    const during = computeEffectiveSiteState({}, licence, NOW);
    expect(during.mode).toBe('live');
    expect(during.noticeRunning).toBe(true);
    expect(during.noticeEffectiveAt).toBe(new Date(NOW + 3 * DAY).toISOString());

    const after = computeEffectiveSiteState({}, licence, NOW + 3 * DAY);
    expect(after.mode).toBe('revoked');
    expect(after.licencePublicNotice).toBe('Licence revoked by the licensor.');

    // Stored 'revoked' also blocks.
    expect(computeEffectiveSiteState({}, { status: 'revoked' }, NOW).mode).toBe('revoked');
  });

  it('R5: notice_served with an unparseable effective date never blocks', () => {
    const state = computeEffectiveSiteState(
      {},
      { status: 'notice_served', effectiveRevocationAt: 'not-a-date' },
      NOW,
    );
    expect(state.mode).toBe('live');
    expect(state.noticeRunning).toBeUndefined();
    const missing = computeEffectiveSiteState(
      {},
      { status: 'notice_served' },
      NOW,
    );
    expect(missing.mode).toBe('live');
  });

  it('R6: precedence is revoked > disabled > maintenance > live', () => {
    const revokedLicence = { status: 'revoked' };
    expect(
      computeEffectiveSiteState(
        { siteEnabled: false, maintenanceMode: true },
        revokedLicence,
        NOW,
      ).mode,
    ).toBe('revoked');
    expect(
      computeEffectiveSiteState(
        { siteEnabled: false, maintenanceMode: true },
        null,
        NOW,
      ).mode,
    ).toBe('disabled');
  });

  it('R7: Timestamp-shaped values resolve; garbage never throws', () => {
    const seconds = Math.floor((NOW + DAY) / 1000);
    const state = computeEffectiveSiteState(
      {},
      { status: 'notice_served', effectiveRevocationAt: { seconds, nanoseconds: 0 } },
      NOW,
    );
    expect(state.noticeRunning).toBe(true);
    expect(() =>
      computeEffectiveSiteState(
        { siteEnabled: { weird: true } },
        { status: { nested: 'x' }, effectiveRevocationAt: () => 1 },
        'garbage-now',
      ),
    ).not.toThrow();
  });
});
