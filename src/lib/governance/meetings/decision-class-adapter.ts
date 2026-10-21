/**
 * Decision-class adapter for motions (ws-a §3.5, §3.9) — pure, no I/O.
 *
 * The decision-class matrix is a Phase 2 substrate; motions consume it
 * ONLY through this seam. `copyThresholdFromClass` is the single place a
 * class becomes a motion threshold: the copy is made once, at open, is
 * DEEP-FROZEN, and is never re-read afterwards. Later edits to the matrix
 * cannot change an opened motion (the immutability contract in
 * motions-types.ts, enforced on writes by guardMotionPatch).
 *
 * Fraction arithmetic reuses the ONE implementation in
 * circular/threshold.ts (computeRequiredCount): strict majority of all =
 * floor(whole/2)+1; otherwise ceil(numerator * whole / denominator) in
 * integer arithmetic (2/3 of 9 = 6, 3/4 of 9 = 7). If Phase 2 stores the
 * fraction differently, only this file changes.
 */

import { computeRequiredCount } from "@/lib/governance/circular/threshold";
import type { DecisionClassView, MotionThreshold } from "./motions-types";

const FRACTION_TYPES: ReadonlySet<string> = new Set([
  "fraction_of_all_governors",
  "fraction_of_all_full_members",
  "fraction_of_all_representatives",
]);

/**
 * Copy the threshold from a class view, computing requiredCount for
 * fraction types against the denominator snapshot's whole-body count.
 * The returned object (and only it) is what the motion stores.
 */
export function copyThresholdFromClass(
  cls: DecisionClassView,
  wholeBodyCount: number,
): MotionThreshold {
  const requiredCount = FRACTION_TYPES.has(cls.majorityType)
    ? computeRequiredCount(cls.majorityType, cls.numerator, wholeBodyCount)
    : null;
  const threshold: MotionThreshold = {
    majorityType: cls.majorityType,
    numerator: cls.numerator,
    fractionDenominator: cls.fractionDenominator,
    denominatorKind: cls.denominatorKind,
    requiredCount,
    consentRequired: cls.consentRequired,
    isReservedMatter: cls.isReservedMatter,
    filingFlag: cls.filingFlag,
  };
  return Object.freeze(threshold);
}
