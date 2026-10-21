/**
 * threshold-ban.ts
 *
 * Single server-side home for the warning-threshold blacklist rule, the
 * threshold banReason pattern match, the expulsion check, and the
 * restoration evaluation. The manual warning route, the deadline cron,
 * and the clear-probation cron all use these helpers so the paths can
 * never drift again (they already had: the manual route and the deadline
 * cron wrote different banReason strings for the same threshold ban).
 *
 * CLIENT MIRROR: src/lib/warning-restore.ts duplicates the pattern
 * constants and the pure evaluation for the client-side defaulters page,
 * which cannot import firebase-admin code. Keep the two files in sync.
 *
 * Rules implemented here (Item 3 spec, section (c)):
 * - R1: a threshold crossing sets isBlacklisted only, labelled
 *   blacklistStatus "pending_review". It NEVER sets isBanned or
 *   banReason, and no threshold string contains "permanent".
 * - R4: a stored banReason is a threshold ban only when it matches one
 *   of the anchored patterns below. A future expulsion workflow must
 *   NOT reuse either pattern for its banReason.
 * - R5: restoration clears the ban only in the same write that clears
 *   the blacklist, only for a threshold-pattern banReason, and only
 *   when no expulsion record exists.
 *
 * Expulsion location (forward definition, Item 3 spec section (d)):
 * collection "expulsions", docs where userId == uid and
 * status == "active". The collection does not exist yet; the query
 * returns empty and the check is false for everyone today. When the
 * Board expulsion workflow is designed, it must either write to this
 * collection and shape, or update hasExpulsionRecord in the same
 * change.
 */

/**
 * Anchored patterns for the two threshold banReason templates ever
 * written by the warning system. The digits are any run of 1-3 digits
 * (the blacklist threshold at issuance time). Matching is exact apart
 * from the digits: case-sensitive, full string.
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

/**
 * The threshold write (R1). Returns ONLY the blacklist fields: no
 * isBanned, no banReason, and the word "permanent" appears nowhere.
 * `now` is whatever timestamp representation the caller uses (Admin
 * SDK Timestamp on the server).
 */
export function buildThresholdBlacklistUpdate<TNow>(threshold: number, now: TNow) {
  return {
    isBlacklisted: true,
    blacklistReason: `Reached ${threshold} active warnings.`,
    blacklistedAt: now,
    blacklistStatus: 'pending_review' as const,
  };
}

/** Minimal Firestore surface hasExpulsionRecord needs. */
interface ExpulsionQueryDb {
  collection: (name: string) => {
    where: (
      field: string,
      op: string,
      value: unknown
    ) => {
      where: (
        field: string,
        op: string,
        value: unknown
      ) => { get: () => Promise<{ empty: boolean; size: number }> };
    };
  };
}

/**
 * True when an active expulsion record exists for the user in the
 * "expulsions" collection (see the header comment for the contract).
 * Returns false when the collection is empty or absent.
 */
export async function hasExpulsionRecord(
  db: ExpulsionQueryDb,
  uid: string
): Promise<boolean> {
  const snap = await db
    .collection('expulsions')
    .where('userId', '==', uid)
    .where('status', '==', 'active')
    .get();
  return !snap.empty && snap.size > 0;
}

export interface RestorationConditions {
  /** Caller-computed isThresholdBanReason(userData.banReason). */
  isThresholdBanReason: boolean;
  /** Caller-computed hasExpulsionRecord result. */
  hasExpulsionRecord: boolean;
}

export interface RestorationDecision {
  clearBlacklist: boolean;
  clearBan: boolean;
}

/**
 * R5 restoration evaluation. Pure: the caller passes the banReason
 * match flag and the expulsion result in, so this stays unit-testable
 * without Firestore.
 *
 *   clearBlacklist = isBlacklisted === true && newCount < threshold
 *   clearBan       = clearBlacklist && isBanned === true
 *                    && threshold banReason && no expulsion record
 */
export function evaluateRestoration(
  userData: { isBlacklisted?: unknown; isBanned?: unknown },
  newCount: number,
  threshold: number,
  conditions: RestorationConditions
): RestorationDecision {
  const clearBlacklist =
    userData.isBlacklisted === true && newCount < threshold;
  const clearBan =
    clearBlacklist &&
    userData.isBanned === true &&
    conditions.isThresholdBanReason === true &&
    conditions.hasExpulsionRecord !== true;
  return { clearBlacklist, clearBan };
}
