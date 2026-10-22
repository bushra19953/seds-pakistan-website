/**
 * warning-restore.ts
 *
 * Client-safe pure helpers for the warning restoration rule, used by
 * the warnings register in the discipline hub (the Register tab of
 * /admin/discipline, a client component that cannot import
 * the server helper in src/lib/server/threshold-ban.ts, which depends
 * on firebase-admin).
 *
 * SERVER MIRROR: the regex patterns below are literal duplicates of
 * THRESHOLD_BAN_REASON_PATTERNS in src/lib/server/threshold-ban.ts.
 * Keep the two files in sync. The parity is pinned by unit tests on
 * both sides (src/lib/__tests__/warning-restore.test.ts and
 * src/lib/server/__tests__/threshold-ban.test.ts run the same string
 * table).
 *
 * A stored banReason is a threshold ban only when it matches one of
 * these anchored patterns (digits = the threshold at issuance time).
 * "Manually banned by admin", "", null, undefined, and any future
 * expulsion wording must never match. A future expulsion workflow
 * must NOT reuse either pattern for its banReason.
 */
export const THRESHOLD_BAN_REASON_PATTERNS: readonly RegExp[] = [
  /^Reached [0-9]{1,3} warnings\. Blacklisted and banned permanently\.$/,
  /^Exceeded [0-9]{1,3} warnings\. Auto-blacklisted\.$/,
];

/** True when a stored banReason was written by a warning threshold path. */
export function isThresholdBanReason(banReason: unknown): boolean {
  if (typeof banReason !== 'string' || banReason.length === 0) return false;
  return THRESHOLD_BAN_REASON_PATTERNS.some((pattern) => pattern.test(banReason));
}

export interface RevokeRestorationDecision {
  clearBlacklist: boolean;
  clearBan: boolean;
}

/**
 * R5/R8 evaluation for the client revoke path. Takes the threshold
 * banReason match as an input flag (computed with isThresholdBanReason
 * above) so it stays pure.
 *
 * Client caveat (Item 3 spec B6.1): the expulsion condition cannot be
 * checked from the client (no expulsion collection exists and no
 * client read rule for it is proposed), so clearBan keys on the
 * threshold-pattern condition only. This is safe while no expulsion
 * record can exist; when an expulsion workflow ships, the revoke
 * handler must move server-side or gain an expulsion read.
 */
export function evaluateRevokeRestoration(
  userData: { isBlacklisted?: unknown; isBanned?: unknown },
  newCount: number,
  threshold: number,
  hasThresholdBanReason: boolean
): RevokeRestorationDecision {
  const clearBlacklist =
    userData.isBlacklisted === true && newCount < threshold;
  const clearBan =
    clearBlacklist &&
    userData.isBanned === true &&
    hasThresholdBanReason === true;
  return { clearBlacklist, clearBan };
}
