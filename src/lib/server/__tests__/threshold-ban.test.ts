/**
 * threshold-ban.test.ts - Item 3, spec F1.
 *
 * Unit tests for the server threshold-ban helpers
 * (src/lib/server/threshold-ban.ts): the anchored banReason pattern
 * match and the R5 restoration matrix. (The R1 threshold write shape
 * suite was removed at integration step 6 with the writer itself.)
 */

import {
  isThresholdBanReason,
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

// The buildThresholdBlacklistUpdate (R1) suite was removed at integration
// (step 6): the writer itself was deleted when the discipline regime
// replaced threshold blacklist writes with referral drafts (T-GREP-1
// sole-writer invariant). See threshold-ban.ts header note.

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
