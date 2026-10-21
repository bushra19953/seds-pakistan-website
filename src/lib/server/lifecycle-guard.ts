/**
 * lifecycle-guard.ts - Phase 2 Section D.2/D.3: the appointment guard.
 *
 * Pure function, no I/O: the caller (Phase 1's single write path,
 * applyRoleChange - the ONLY caller, spec D.2) resolves every input into a
 * LifecycleContext and records the returned decision via
 * writeGovernanceAuditOrThrow with action 'lifecycle_guard_decision'.
 *
 * Rules run in the spec's order; the FIRST failure is the returned code so
 * the UI can name the nearest fixable problem:
 *   0. catalog completeness (hard fail, no override)
 *   1. founder override (never bypasses the D.3 hard fails)
 *   2. appointer match (incl. founder_appointer look-alike and Board
 *      evidence checks)
 *   3. chapter scope (cross-chapter denial; National President exception
 *      for chapter presidents, hard-coded by actor key per D.2)
 *   4. eligibility hard fails (cadet in probation; Category B non-Full
 *      without a decided schedule_3_2_c Consent)
 *   5. seat occupancy
 * Plus the D.8.1 day-30 founder fallback: while a vacancy's
 * founderFallbackAvailable flag is true for the target seat, the Founder
 * satisfies the appointer check for that seat (never the hard fails).
 *
 * Founder identity is a UID equality check (spec Section 0 contract 5):
 * ctx.founderOverride is honoured only when ctx.actorUid === FOUNDER_UID.
 * ADAPTER: FOUNDER_UID is imported from src/lib/roles.ts:44, its home on
 * this branch; the interface contract moves it to src/config/founder.ts
 * on the Phase 1 branch and integration re-points this import.
 */

import { FOUNDER_UID } from '@/lib/roles';
import {
  BOARD_APPOINTER_KEY,
  FOUNDER_APPOINTER_KEY,
  type LifecycleContext,
  type LifecycleGuardResult,
} from '@/types/lifecycle';
import {
  getAppointerEntryIncludingSupplementary,
  type AppointerMapEntry,
} from './lifecycle-appointer-map';

export interface LifecycleGuardOptions {
  /**
   * D.8.1: true when the target seat has an open vacancy whose
   * founderFallbackAvailable flag is set (and the seat is not
   * governor_member, for which the fallback never applies - the vacancy
   * engine never sets the flag there).
   */
  vacancyFallbackAvailable?: boolean;
  /**
   * Resolved Board-appointer evidence: true when ctx.boardAppointerVoteId
   * was verified to point at a governance_votes doc with mode
   * offline_attested whose deciderUids were seated Governors. The guard
   * stays pure; the caller (applyRoleChange) does this read.
   */
  boardVoteEvidenceValid?: boolean;
}

function deny(
  code: Extract<LifecycleGuardResult, { allowed: false }>['code'],
  appointerKey: string | null,
  detail: string,
): LifecycleGuardResult {
  return { allowed: false, code, appointerKey, detail };
}

export function checkLifecycleGuards(
  ctx: LifecycleContext,
  options: LifecycleGuardOptions = {},
): LifecycleGuardResult {
  const entry: AppointerMapEntry | undefined = getAppointerEntryIncludingSupplementary(
    ctx.roleKey,
  );

  // Rule 0: catalog completeness - hard fail, no override (D.1/D.2).
  if (!entry || entry.appointingRoleKeys.length === 0) {
    return deny(
      'ROLE_CATALOG_INCOMPLETE',
      null,
      `Role ${ctx.roleKey} has no appointer map entry; appointment fails closed.`,
    );
  }
  const appointerKey = entry.appointingRoleKeys[0];
  const isFounder = ctx.actorUid === FOUNDER_UID && ctx.founderOverride;

  // D.3 eligibility hard fails (D.2 rule 4 in the spec's numbering). They
  // are factored out because they bind EVERY path - including the founder
  // override, which explicitly does not bypass them (D.2 rule 1 exclusion).
  const hardFail = (): LifecycleGuardResult | null => {
    if (entry.category === 'C' && ctx.subjectIsCadetInProbation) {
      return deny(
        'CADET_IN_PROBATION',
        appointerKey,
        'A Cadet in the 8-week probation may not hold a Category C role (Bylaws s.6.3); no waiver instrument exists.',
      );
    }
    if (
      entry.category === 'B' &&
      entry.minimumMembershipClassForFullPowers === 'Full' &&
      ctx.subjectMembershipClass !== 'Full'
    ) {
      const consent = ctx.consentLookup('schedule_3_2_c');
      if (!consent) {
        return deny(
          'NOT_FULL_MEMBER',
          appointerKey,
          'Category B office requires a Full Member (Art. 3.1) or a decided schedule_3_2_c Consent waiver; neither is present.',
        );
      }
      // Decided Consent present: the appointment proceeds and the caller
      // stamps consentId on the appointment record permanently (D.3).
    }
    return null;
  };

  // A look-alike founder_appointer grant: key presence without UID
  // equality is not the Founder (D.2 rule 2). Checked before the override
  // so a non-founder holding the key can never ride it.
  if (
    ctx.actorRoleKeys.includes(FOUNDER_APPOINTER_KEY) &&
    ctx.actorUid !== FOUNDER_UID
  ) {
    return deny(
      'FOUNDER_OVERRIDE_ONLY',
      appointerKey,
      'The founder_appointer key is held by a non-Founder account; only the Founder UID may act as founder_appointer.',
    );
  }

  // Rule 1: founder override forgives WHO acted, never WHAT the office is.
  // The recorded appointer stays the catalog appointer. The D.3 hard fails
  // and the seat-occupancy rule still bind the Founder.
  if (isFounder) {
    const fail = hardFail();
    if (fail) return fail;
    const occupied = seatOccupancyDeny(entry, ctx, appointerKey);
    if (occupied) return occupied;
    return { allowed: true, appointerKey, viaFounderOverride: true };
  }

  // D.8.1 day-30 fallback: the Founder may appoint to THIS seat while the
  // vacancy flag is set, notwithstanding the catalog appointer. Hard fails
  // still apply (the fallback "does NOT waive the hard fails", D.8.1).
  if (options.vacancyFallbackAvailable && ctx.actorUid === FOUNDER_UID) {
    const fail = hardFail();
    if (fail) return fail;
    const occupied = seatOccupancyDeny(entry, ctx, appointerKey);
    if (occupied) return occupied;
    return { allowed: true, appointerKey, viaFounderOverride: true };
  }

  // Rule 2: appointer match.
  if (appointerKey === BOARD_APPOINTER_KEY) {
    if (!ctx.boardAppointerVoteId || !options.boardVoteEvidenceValid) {
      return deny(
        'BOARD_APPOINTER_EVIDENCE_MISSING',
        appointerKey,
        'This role is appointed by the Board; an offline_attested governance_votes record by seated Governors is required (Section 0 contract 4).',
      );
    }
  } else if (appointerKey === FOUNDER_APPOINTER_KEY) {
    // Only the Founder can satisfy a founder_appointer appointer, and the
    // founder path was already handled above.
    return deny(
      'APPOINTER_MISMATCH',
      appointerKey,
      `Role ${ctx.roleKey} is appointed by founder_appointer; the actor does not hold that authority.`,
    );
  } else if (!ctx.actorRoleKeys.includes(appointerKey)) {
    return deny(
      'APPOINTER_MISMATCH',
      appointerKey,
      `Role ${ctx.roleKey} is appointed by ${appointerKey}; the actor does not hold that role.`,
    );
  }

  // Rule 3: chapter scope.
  if (entry.chapterScoped) {
    if (!ctx.chapterSlug) {
      return deny(
        'CHAPTER_MISMATCH',
        appointerKey,
        `Role ${ctx.roleKey} is chapter-scoped; a chapterSlug is required.`,
      );
    }
    const actorIsNationalPresident = ctx.actorRoleKeys.includes('president_national');
    if (
      ctx.actorChapterSlug &&
      ctx.actorChapterSlug !== ctx.chapterSlug &&
      !actorIsNationalPresident
    ) {
      return deny(
        'CROSS_CHAPTER_DENIED',
        appointerKey,
        `Actor belongs to chapter ${ctx.actorChapterSlug}; appointments to ${ctx.chapterSlug} are denied cross-chapter.`,
      );
    }
  }

  // Rule 4: eligibility hard fails (after appointer and chapter scope,
  // per the spec's first-failure ordering).
  const fail = hardFail();
  if (fail) return fail;

  // Rule 5: seat occupancy (the caller re-checks inside the write
  // transaction; this pure check is the decision of record, D.2).
  const occupied = seatOccupancyDeny(entry, ctx, appointerKey);
  if (occupied) return occupied;

  return { allowed: true, appointerKey, viaFounderOverride: false };
}

function seatOccupancyDeny(
  entry: AppointerMapEntry,
  ctx: LifecycleContext,
  appointerKey: string,
): LifecycleGuardResult | null {
  const { holderUids, cap } = ctx.seatOccupancy;
  if (
    entry.seatBound &&
    cap !== null &&
    holderUids.length >= cap &&
    !holderUids.includes(ctx.targetUid)
  ) {
    return deny(
      'SEAT_OCCUPIED',
      appointerKey,
      `Seat for ${ctx.roleKey} is at its cap of ${cap} and the target is not a current holder.`,
    );
  }
  return null;
}

/**
 * shouldCreateRatificationRecord (spec D.4): a ratifications doc is
 * created ONLY when the catalog entry requires ratification AND the
 * appointment was founder-appointed (appointer resolved to the Founder /
 * founder_appointer, not via a Board vote record). A Board-appointed
 * Category B officer is not ratifiable - the Board ratifying its own act
 * would be circular.
 */
export function shouldCreateRatificationRecord(params: {
  entry: AppointerMapEntry | undefined;
  appointedByUid: string;
  viaBoardVote: boolean;
}): boolean {
  const { entry, appointedByUid, viaBoardVote } = params;
  if (!entry || !entry.ratificationRequired) return false;
  if (viaBoardVote) return false;
  return appointedByUid === FOUNDER_UID || entry.appointingRoleKeys.includes(FOUNDER_APPOINTER_KEY);
}

/** The standing refusal question text (spec D.5). */
export function refusalQuestionText(appointeeName: string, roleLabel: string): string {
  return `That the appointment of ${appointeeName} as ${roleLabel} be refused.`;
}

/**
 * requiredRefusals (spec D.4/D.9 T8/T9): refusal passes iff refusal votes
 * reach ceil(2/3 of the FROZEN electorate snapshot). The denominator is
 * the snapshot copied at vote-open - never the currently seated count and
 * never a statutory constant silently substituted (Z-03 honesty rule).
 */
export function requiredRefusals(eligibleElectors: number): number {
  if (!Number.isFinite(eligibleElectors) || eligibleElectors <= 0) return 0;
  return Math.ceil((2 / 3) * eligibleElectors);
}
