/**
 * Circular resolutions — threshold snapshot + ADAPTER to the decision-class
 * matrix and the shared meetings threshold engine.
 *
 * ADAPTER (decision-class matrix): the matrix (decisionClasses collection,
 * audit item 9) is a Phase 2 substrate and the motions sibling is building
 * the canonical threshold module under src/lib/governance/meetings/. Neither
 * was present when this slice was built (only ballots.ts, which defines the
 * §3.5 threshold SHAPE but no class reader and no required-count arithmetic
 * for circulars). `LOCAL_DECISION_CLASS_MATRIX` below is a spec-derived
 * local stand-in (fractions and flags taken from ws-a §6.2 / §6.4 examples:
 * ordinary Board business = majority of ALL Governors; reversal row 5.54 =
 * 2/3 of all Governors; override row 5.55 = 3/4 of all representatives).
 * When the canonical module lands, `resolveDecisionClass` is the single seam
 * to re-point at it (or at a Firestore read in the server service) and this
 * table must be deleted, not kept as a second matrix.
 *
 * ADAPTER (shared engine): ws-a §6.2 forbids a second threshold
 * implementation. The Meetings Core quorum engine
 * (src/lib/governance/quorum-engine.ts) does not exist yet, so the circular
 * outcome arithmetic lives in ./engine.ts behind this seam. When the engine
 * lands, engine.ts must delegate fraction evaluation to it.
 */

import type { CircularThreshold, DecisionClassView, MajorityType } from "./types";

/** Spec-derived local matrix — ADAPTER stand-in, see header. */
export const LOCAL_DECISION_CLASS_MATRIX: readonly DecisionClassView[] = [
  {
    id: "class_board_ordinary",
    label: "Board ordinary business (circular)",
    assignedBodyType: "board",
    majorityType: "fraction_of_all_governors",
    numerator: 1,
    denominatorKind: "all_governors",
    consentRequired: true,
    isReservedMatter: false,
    filingFlag: false,
    sourceRow: "5.18",
  },
  {
    id: "class_board_reversal",
    label: "Board reversal of a Council decision",
    assignedBodyType: "board",
    majorityType: "fraction_of_all_governors",
    numerator: 2,
    denominatorKind: "all_governors",
    consentRequired: true,
    isReservedMatter: false,
    filingFlag: true,
    sourceRow: "5.54",
  },
  {
    id: "class_chapters_override",
    label: "Council of Chapters override of a Council decision",
    assignedBodyType: "council_of_chapters",
    majorityType: "fraction_of_all_representatives",
    numerator: 3,
    denominatorKind: "all_representatives",
    consentRequired: true,
    isReservedMatter: false,
    filingFlag: true,
    sourceRow: "5.55",
  },
  {
    id: "class_present_and_voting_ordinary",
    label: "Ordinary motion, present and voting",
    assignedBodyType: "board",
    majorityType: "ordinary_present_and_voting",
    numerator: null,
    denominatorKind: "present_and_voting",
    consentRequired: false,
    isReservedMatter: false,
    filingFlag: false,
    sourceRow: "4.3",
  },
];

/** ADAPTER seam: resolve a class view by id from the local matrix. */
export function resolveDecisionClass(classId: string): DecisionClassView | null {
  return LOCAL_DECISION_CLASS_MATRIX.find((c) => c.id === classId) ?? null;
}

const FRACTION_TYPES: readonly MajorityType[] = [
  "fraction_of_all_governors",
  "fraction_of_all_full_members",
  "fraction_of_all_representatives",
];

/**
 * Smallest integer >= (numerator/denominator) * whole, integer arithmetic
 * only (ws-a §6.2: 2/3 of 9 = 6, 3/4 of 9 = 7).
 * The numerator stored on a class view is the fraction numerator over the
 * canonical denominator for its majorityType (1/2, 2/3, 3/4 …) — the local
 * matrix encodes 2/3 as numerator 2 over denominator 3 via the map below;
 * a numerator of 1 over a denominator of 2 is the strict-majority class
 * whose required count is floor(whole/2)+1 (identical to ceil(whole/2) for
 * odd wholes, one more for even wholes — ws-a §3.12: "strictly more than
 * half", so 4 of 8 does NOT pass).
 */
export function fractionDenominatorFor(majorityType: MajorityType, numerator: number | null): number | null {
  if (numerator === null || !FRACTION_TYPES.includes(majorityType)) return null;
  // The class view carries only a numerator (ws-a §3.9); the spec fractions
  // are 1/2 (strict majority), 2/3 (row 5.54) and 3/4 (row 5.55).
  if (numerator === 1) return 2;
  return numerator + 1;
}

export function computeRequiredCount(
  majorityType: MajorityType,
  numerator: number | null,
  wholeBodyCount: number,
): number | null {
  const denominator = fractionDenominatorFor(majorityType, numerator);
  if (denominator === null || numerator === null) return null;
  if (numerator === 1 && denominator === 2) {
    // Strict majority of ALL (ws-a §3.12).
    return Math.floor(wholeBodyCount / 2) + 1;
  }
  // ceil(numerator * whole / denominator) with integers.
  return Math.floor((numerator * wholeBodyCount + denominator - 1) / denominator);
}

/** Majority of ALL needed for a snapshot of this size (ws-a §3.12/§4.7). */
export function majorityNeeded(snapshotLength: number): number {
  return Math.floor(snapshotLength / 2) + 1;
}

/**
 * Copy the threshold from a class view IMMUTABLY (ws-a §3.5 rule applied to
 * circulars by the slice brief). The returned object is deeply frozen; the
 * class may later change in the matrix without affecting any circular that
 * already copied it. `wholeBodyCount` is the count known at copy time
 * (0 / unknown is allowed pre-circulation; the effective required count for
 * fraction classes is then derived from the COPIED fraction against the
 * circulation snapshot by the engine — the fraction, not a re-read class,
 * is what is frozen).
 */
export function snapshotThreshold(
  cls: DecisionClassView,
  wholeBodyCount: number,
): Readonly<CircularThreshold> {
  const denominator = fractionDenominatorFor(cls.majorityType, cls.numerator);
  const threshold: CircularThreshold = {
    majorityType: cls.majorityType,
    numerator: cls.numerator,
    denominator,
    denominatorKind: cls.denominatorKind,
    requiredCount:
      denominator !== null && wholeBodyCount > 0
        ? computeRequiredCount(cls.majorityType, cls.numerator, wholeBodyCount)
        : null,
    consentRequired: cls.consentRequired,
    isReservedMatter: cls.isReservedMatter,
    filingFlag: cls.filingFlag,
  };
  return Object.freeze(threshold);
}
