/**
 * Ballots — pure logic (ws-a.md §3.5, §3.6, §4.5, §6.2).
 * No Firebase / I/O imports. Imported by client and server.
 *
 * ADAPTER (motion model): the motions sibling owns the canonical Motion
 * type (src/lib/governance/meetings/motions*). It was not present when this
 * slice was built, so `MotionRef` below is the minimal shape this module
 * consumes. When the canonical type lands, replace MotionRef with an import
 * of it — every field used here is copied verbatim from ws-a §3.5.
 *
 * ADAPTER (quorum engine / casting vote): ws-a §6.2 names
 * src/lib/governance/quorum-engine.ts as THE shared engine and the only file
 * allowed to contain threshold arithmetic. That file (Meetings Core sibling)
 * was not present when this slice was built. `evaluateBallotOutcome` below
 * implements the §6.2 casting-ballot rule behind this adapter seam; when the
 * engine lands, its body must delegate to
 * quorum-engine.evaluateThreshold(threshold, snapshot, tallies, castingChoice)
 * and this local arithmetic must be deleted, not kept as a second engine.
 */

export type VotingMethod = "show_of_hands" | "electronic_poll" | "secret_ballot";
export type BallotChoice = "for" | "against" | "abstain";
export type MotionStatus =
  | "open"
  | "paused_quorum_lost"
  | "closed_passed"
  | "closed_failed"
  | "closed_tied_pending_casting"
  | "withdrawn";
export type BodyType =
  | "board"
  | "nec"
  | "council"
  | "council_of_chapters"
  | "general_body"
  | "chapter_committee";

export interface MotionThreshold {
  majorityType:
    | "ordinary_present_and_voting"
    | "fraction_of_all_governors"
    | "fraction_of_all_full_members"
    | "fraction_of_all_representatives"
    | "plurality"
    | "single_person";
  numerator: number | null;
  denominatorKind: string;
  requiredCount: number | null;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

export interface DenominatorSnapshot {
  eligibleUids: string[];
  presentUids: string[];
  presentCount: number;
  wholeBodyCount: number;
}

/** ADAPTER: minimal motion reference — see header. Mirrors ws-a §3.5. */
export interface MotionRef {
  id: string;
  meetingId: string | null;
  bodyId: string;
  bodyType: BodyType | string;
  text: string;
  proposerUid: string;
  decisionClassId: string;
  threshold: MotionThreshold;
  denominatorSnapshot: DenominatorSnapshot;
  method: VotingMethod;
  secretDemandedBy: string[];
  status: MotionStatus;
}

export interface InterestDisclosure {
  hasInterest: boolean;
  description: string;
  relatedPartyName: string | null;
}

/** Traceable ballot (ws-a §3.6 ballots/{ballotId}). Never used for secret votes. */
export interface BallotDoc {
  motionId: string;
  meetingId: string;
  voterUid: string;
  choice: BallotChoice;
  isProxy: boolean;
  proxyForUid: string | null;
  proxyAuthorizationId: string | null;
  isCastingVote: boolean;
  interestDisclosure: InterestDisclosure | null;
  castAt: Date;
}

/**
 * Secret-ballot token doc (ws-a §3.6 secret_ballot_tokens/{tokenHash}).
 * Doc id is the SHA-256 hex of the token. ANONYMITY BY SCHEMA: this shape
 * has no uid / voter field of any kind — do not add one.
 */
export interface SecretBallotTokenDoc {
  motionId: string;
  used: boolean;
  usedAt: Date | null;
}

/**
 * Secret-ballot choice doc (ws-a §3.6 secret_ballot_choices/{choiceId}).
 * ANONYMITY BY SCHEMA: exactly these three fields. No uid, no token, no IP,
 * no user agent — nothing that could link a voter to a choice.
 */
export interface SecretBallotChoiceDoc {
  motionId: string;
  choice: BallotChoice;
  /** Server-rounded to the minute to reduce timing correlation (ws-a §3.6). */
  castAt: Date;
}

export interface ProxyAuthorizationDoc {
  id: string;
  meetingId: string;
  grantorUid: string;
  proxyUid: string;
  advanceResolutionDecisionId: string;
  scopeMotionIds: string[] | null;
  revokedAt: Date | null;
}

export interface BallotTallies {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
}

export interface MotionResult extends BallotTallies {
  denominatorUsed: number;
  thresholdMet: boolean;
  castingVoteUsed: boolean;
  castingChoice: BallotChoice | null;
}

export const SECRET_DEMAND_THRESHOLD = 2;
export const SECRET_TOKEN_BYTES = 32;

/** Exact allow-lists for the secret store — schema inspection tests use these. */
export const SECRET_CHOICE_KEYS: readonly string[] = ["motionId", "choice", "castAt"];
export const SECRET_TOKEN_KEYS: readonly string[] = ["motionId", "used", "usedAt"];

/** Any of these keys on a secret-store doc would link a voter to a choice. */
export const FORBIDDEN_LINKAGE_KEYS: readonly string[] = [
  "uid",
  "voterUid",
  "voterId",
  "userId",
  "castBy",
  "token",
  "tokenHash",
  "ip",
  "ipAddress",
  "userAgent",
  "email",
  "displayName",
  "proxyForUid",
];

function assertSecretDocShape(doc: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(doc)) {
    if (FORBIDDEN_LINKAGE_KEYS.includes(key)) {
      throw new Error(`${label}: forbidden voter-linkage field "${key}"`);
    }
    if (!allowed.includes(key)) {
      throw new Error(`${label}: unexpected field "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
  for (const key of allowed) {
    if (!(key in doc)) throw new Error(`${label}: missing field "${key}"`);
  }
}

export function assertSecretChoiceDocShape(doc: Record<string, unknown>): void {
  assertSecretDocShape(doc, SECRET_CHOICE_KEYS, "secret_ballot_choices");
}

export function assertSecretTokenDocShape(doc: Record<string, unknown>): void {
  assertSecretDocShape(doc, SECRET_TOKEN_KEYS, "secret_ballot_tokens");
}

/** Build a secret choice doc — the ONLY constructor; shape is asserted. */
export function buildSecretBallotChoiceDoc(input: {
  motionId: string;
  choice: BallotChoice;
  castAt: Date;
}): SecretBallotChoiceDoc {
  const doc: SecretBallotChoiceDoc = {
    motionId: input.motionId,
    choice: input.choice,
    castAt: roundToMinute(input.castAt),
  };
  assertSecretChoiceDocShape(doc as unknown as Record<string, unknown>);
  return doc;
}

export function buildSecretBallotTokenDoc(input: { motionId: string }): SecretBallotTokenDoc {
  const doc: SecretBallotTokenDoc = { motionId: input.motionId, used: false, usedAt: null };
  assertSecretTokenDocShape(doc as unknown as Record<string, unknown>);
  return doc;
}

export function roundToMinute(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Secret-ballot demand (ws-a §3.5 / §4.5): locks at exactly 2 distinct demands
// from eligible present members, and can never flip back.
// ---------------------------------------------------------------------------

export function isEligiblePresent(motion: MotionRef, uid: string): boolean {
  return (
    motion.denominatorSnapshot.eligibleUids.includes(uid) &&
    motion.denominatorSnapshot.presentUids.includes(uid)
  );
}

export interface DemandResult {
  secretDemandedBy: string[];
  demands: number;
  method: VotingMethod;
  locked: boolean;
  added: boolean;
}

export function applySecretDemand(
  motion: Pick<MotionRef, "method" | "secretDemandedBy" | "denominatorSnapshot">,
  uid: string,
): DemandResult {
  const already = motion.secretDemandedBy.includes(uid);
  const secretDemandedBy = already ? [...motion.secretDemandedBy] : [...motion.secretDemandedBy, uid];
  const locked = secretDemandedBy.length >= SECRET_DEMAND_THRESHOLD;
  return {
    secretDemandedBy,
    demands: secretDemandedBy.length,
    // Once locked it stays secret_ballot even if demands were later removed;
    // before the threshold the existing method is unchanged.
    method: locked ? "secret_ballot" : motion.method,
    locked,
    added: !already,
  };
}

/** A method that has locked to secret_ballot can never revert (server-enforced). */
export function assertMethodTransition(current: VotingMethod, next: VotingMethod): void {
  if (current === "secret_ballot" && next !== "secret_ballot") {
    throw new Error("secret_ballot method is locked and cannot revert");
  }
}

// ---------------------------------------------------------------------------
// Counting: totals only. Per-voter choices are never exposed by these helpers.
// ---------------------------------------------------------------------------

export function tallyChoices(choices: readonly BallotChoice[]): BallotTallies {
  const t: BallotTallies = { votesFor: 0, votesAgainst: 0, abstentions: 0 };
  for (const c of choices) {
    if (c === "for") t.votesFor += 1;
    else if (c === "against") t.votesAgainst += 1;
    else t.abstentions += 1;
  }
  return t;
}

/** Traceable totals exclude the Founder casting ballot (counted separately). */
export function tallyBallots(ballots: readonly BallotDoc[]): BallotTallies {
  return tallyChoices(ballots.filter((b) => !b.isCastingVote).map((b) => b.choice));
}

export function findCastingBallot(ballots: readonly BallotDoc[]): BallotDoc | null {
  return ballots.find((b) => b.isCastingVote) ?? null;
}

// ---------------------------------------------------------------------------
// Tie handling + threshold outcome.
// ADAPTER: delegates to the shared quorum engine when it lands — see header.
// Rule (ws-a §6.2): ordinary = for > against; a tie (for == against, at least
// one vote cast) at board|council returns tie_pending_casting; a casting
// choice then decides (for -> passed, against -> failed, abstain -> failed
// with castingVoteUsed recorded). Tie anywhere else is failed. Fraction types
// pass at requiredCount and never tie / never take a casting vote.
// ---------------------------------------------------------------------------

export type BallotOutcome = "passed" | "failed" | "tie_pending_casting";

export interface OutcomeEvaluation {
  outcome: BallotOutcome;
  result: MotionResult | null; // null while tie_pending_casting
}

export function needsCastingVote(input: {
  bodyType: string;
  threshold: MotionThreshold;
  tallies: BallotTallies;
}): boolean {
  if (input.threshold.majorityType !== "ordinary_present_and_voting") return false;
  if (input.bodyType !== "board" && input.bodyType !== "council") return false;
  const cast = input.tallies.votesFor + input.tallies.votesAgainst;
  return cast > 0 && input.tallies.votesFor === input.tallies.votesAgainst;
}

export function evaluateBallotOutcome(input: {
  bodyType: string;
  threshold: MotionThreshold;
  denominatorSnapshot: DenominatorSnapshot;
  tallies: BallotTallies;
  castingChoice?: BallotChoice | null;
}): OutcomeEvaluation {
  const { threshold, tallies } = input;
  const castingChoice = input.castingChoice ?? null;
  const base: MotionResult = {
    ...tallies,
    denominatorUsed: input.denominatorSnapshot.wholeBodyCount,
    thresholdMet: false,
    castingVoteUsed: castingChoice !== null,
    castingChoice,
  };

  if (threshold.majorityType === "ordinary_present_and_voting") {
    if (tallies.votesFor > tallies.votesAgainst) {
      return { outcome: "passed", result: { ...base, thresholdMet: true } };
    }
    if (needsCastingVote({ bodyType: input.bodyType, threshold, tallies })) {
      if (castingChoice === null) return { outcome: "tie_pending_casting", result: null };
      const passed = castingChoice === "for";
      return {
        outcome: passed ? "passed" : "failed",
        result: { ...base, thresholdMet: passed, castingVoteUsed: true },
      };
    }
    return { outcome: "failed", result: { ...base } };
  }

  if (
    threshold.majorityType === "fraction_of_all_governors" ||
    threshold.majorityType === "fraction_of_all_full_members" ||
    threshold.majorityType === "fraction_of_all_representatives"
  ) {
    const passed = threshold.requiredCount !== null && tallies.votesFor >= threshold.requiredCount;
    // Casting choice is ignored on fraction types (ws-a §6.2).
    return {
      outcome: passed ? "passed" : "failed",
      result: { ...base, thresholdMet: passed, castingVoteUsed: false, castingChoice: null },
    };
  }

  // plurality / single_person do not normally reach meeting motions (ws-a §6.2);
  // treat plurality as for > against and everything else as failed.
  if (threshold.majorityType === "plurality") {
    const passed = tallies.votesFor > tallies.votesAgainst;
    return { outcome: passed ? "passed" : "failed", result: { ...base, thresholdMet: passed } };
  }
  return { outcome: "failed", result: { ...base } };
}

/** Deterministic traceable ballot doc id (ws-a §3.6): one ballot per member. */
export function traceableBallotId(motionId: string, effectiveVoterUid: string): string {
  return `${motionId}_${effectiveVoterUid}`;
}

export function castingBallotId(motionId: string): string {
  return `${motionId}_founder_casting`;
}
