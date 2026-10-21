/**
 * warning-restore.test.ts - Item 3, spec F5.
 *
 * Client helper parity: the client mirror (src/lib/warning-restore.ts)
 * must give identical isThresholdBanReason results to the server
 * helper (src/lib/server/threshold-ban.ts) on the same string table,
 * and evaluateRevokeRestoration must follow the R5/R8 matrix.
 */

import {
  isThresholdBanReason as clientIsThresholdBanReason,
  evaluateRevokeRestoration,
} from '@/lib/warning-restore';
import { isThresholdBanReason as serverIsThresholdBanReason } from '@/lib/server/threshold-ban';
import { THRESHOLD_STRING_TABLE } from '@/lib/server/__tests__/threshold-ban.test';

describe('isThresholdBanReason parity (client vs server)', () => {
  it.each(THRESHOLD_STRING_TABLE)('%j -> %s on both sides', (input, expected) => {
    expect(clientIsThresholdBanReason(input)).toBe(expected);
    expect(serverIsThresholdBanReason(input)).toBe(expected);
    expect(clientIsThresholdBanReason(input)).toBe(
      serverIsThresholdBanReason(input)
    );
  });
});

describe('evaluateRevokeRestoration (R5/R8)', () => {
  it('below threshold + threshold ban: both clear', () => {
    expect(
      evaluateRevokeRestoration({ isBlacklisted: true, isBanned: true }, 2, 3, true)
    ).toEqual({ clearBlacklist: true, clearBan: true });
  });

  it('below threshold + manual ban: blacklist only', () => {
    expect(
      evaluateRevokeRestoration({ isBlacklisted: true, isBanned: true }, 2, 3, false)
    ).toEqual({ clearBlacklist: true, clearBan: false });
  });

  it('at threshold: neither clears', () => {
    expect(
      evaluateRevokeRestoration({ isBlacklisted: true, isBanned: true }, 3, 3, true)
    ).toEqual({ clearBlacklist: false, clearBan: false });
  });

  it('not blacklisted: neither clears', () => {
    expect(
      evaluateRevokeRestoration({ isBlacklisted: false, isBanned: true }, 0, 3, true)
    ).toEqual({ clearBlacklist: false, clearBan: false });
  });
});
