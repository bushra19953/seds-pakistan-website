/**
 * threshold-ban.test.ts - Item 3, spec F1.
 *
 * Unit tests for the server threshold-ban helpers
 * (src/lib/server/threshold-ban.ts): the anchored banReason pattern
 * match, the R1 threshold write shape, and the R5 restoration matrix.
 */

import {
  isThresholdBanReason,
  buildThresholdBlacklistUpdate,
  evaluateRestoration,
} from '@/lib/server/threshold-ban';

// The string table is shared verbatim with the client parity suite
// (src/lib/__tests__/warning-restore.test.ts).
export const THRESHOLD_STRING_TABLE: Array<[unknown, boolean]> = [
  ['Reached 3 warnings. Blacklisted and banned permanently.', true],
  ['Exceeded 3 warnings. Auto-blacklisted.', true],
  ['Reached 5 warnings. Blacklisted and banned permanently.', true],
  ['Exceeded 10 warnings. Auto-blacklisted.', true],
  ['Manually banned by admin', false],
  ['', false],
  [null, false],
  [undefined, false],
  ['Reached 3 warnings.', false], // partial string must not match
  ['Reached 3 warnings. Blacklisted and banned permanently. Extra words.', false], // anchoring
  ['reached 3 warnings. Blacklisted and banned permanently.', false], // case-sensitive
  ['Reached 1234 warnings. Blacklisted and banned permanently.', false], // 4 digits exceeds {1,3}
  [42, false],
];

describe('isThresholdBanReason (server)', () => {
  it.each(THRESHOLD_STRING_TABLE)('%j -> %s', (input, expected) => {
    expect(isThresholdBanReason(input)).toBe(expected);
  });
});

describe('buildThresholdBlacklistUpdate (R1)', () => {
  it('returns ONLY blacklist fields: no isBanned, no banReason, nothing permanent', () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const update = buildThresholdBlacklistUpdate(3, now) as Record<string, unknown>;

    expect(update.isBlacklisted).toBe(true);
    expect(update.blacklistStatus).toBe('pending_review');
    expect(update.blacklistReason).toBe('Reached 3 active warnings.');
    expect(update.blacklistedAt).toBe(now);
    expect('isBanned' in update).toBe(false);
    expect('banReason' in update).toBe(false);
    for (const value of Object.values(update)) {
      if (typeof value === 'string') {
        expect(value.toLowerCase()).not.toContain('permanent');
      }
    }
  });

  it('interpolates the threshold into the reason', () => {
    const update = buildThresholdBlacklistUpdate(5, null) as Record<string, unknown>;
    expect(update.blacklistReason).toBe('Reached 5 active warnings.');
  });
});

describe('evaluateRestoration (R5 matrix)', () => {
  const thresholdBan = { isThresholdBanReason: true, hasExpulsionRecord: false };

  it('below threshold + threshold ban + no expulsion: both clear', () => {
    expect(
      evaluateRestoration({ isBlacklisted: true, isBanned: true }, 2, 3, thresholdBan)
    ).toEqual({ clearBlacklist: true, clearBan: true });
  });

  it('below threshold + manual ban: blacklist only', () => {
    expect(
      evaluateRestoration({ isBlacklisted: true, isBanned: true }, 2, 3, {
        isThresholdBanReason: false,
        hasExpulsionRecord: false,
      })
    ).toEqual({ clearBlacklist: true, clearBan: false });
  });

  it('count still at threshold: neither clears', () => {
    expect(
      evaluateRestoration({ isBlacklisted: true, isBanned: true }, 3, 3, thresholdBan)
    ).toEqual({ clearBlacklist: false, clearBan: false });
  });

  it('not blacklisted: neither clears', () => {
    expect(
      evaluateRestoration({ isBlacklisted: false, isBanned: true }, 0, 3, thresholdBan)
    ).toEqual({ clearBlacklist: false, clearBan: false });
  });

  it('expulsion record present: blacklist only, ban survives', () => {
    expect(
      evaluateRestoration({ isBlacklisted: true, isBanned: true }, 2, 3, {
        isThresholdBanReason: true,
        hasExpulsionRecord: true,
      })
    ).toEqual({ clearBlacklist: true, clearBan: false });
  });

  it('blacklisted but not banned: blacklist clears, no ban to clear', () => {
    expect(
      evaluateRestoration({ isBlacklisted: true, isBanned: false }, 1, 3, thresholdBan)
    ).toEqual({ clearBlacklist: true, clearBan: false });
  });
});
