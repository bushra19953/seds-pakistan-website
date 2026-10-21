/**
 * Circular resolutions — pure engine (ws-a.md §3.12, §4.7, §6.2, §6.6 T3).
 * No I/O. All functions are pure: they take a resolution and return a new
 * one (or a verdict); persistence and side effects live in the server
 * service (src/lib/server/governance/circular.ts).
 *
 * Window rule (ws-a §3.12 + §6.6 T3): the voting window is
 * [circulatedAt, closesAt] INCLUSIVE at both ends, where
 * closesAt = circulatedAt + 7 days. T3 closes a circulating resolution
 * whose closesAt has PASSED (strictly), so a vote cast exactly at
 * closesAt is still inside the window and a vote after closesAt is
 * rejected; auto-close fires only when now > closesAt.
 *
 * Early closure (ws-a §4.7): a fraction-of-all resolution closes as PASSED
 * the moment its approval count reaches the required count — that is the
 * only early closure the spec allows. A resolution is NEVER lapsed early:
 * short of the deadline the remaining Governors could still sign. For
 * ordinary_present_and_voting classes the outcome is unknowable until the
 * window ends (later "against" votes can still arrive), so there is no
 * early closure for them either; they are decided at close.
 */

import { computeRequiredCount, majorityNeeded } from "./threshold";
import type {
  CircularResolution,
  CircularTallies,
  CircularVote,
  CircularVoteChoice,
} from "./types";

export const CIRCULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const APPROVAL_STATEMENT = "I approve this resolution" as const;

export type CircularErrorCode =
  | "not_circulating"
  | "window_not_open"
  | "window_closed"
  | "not_eligible"
  | "already_voted";

export class CircularEngineError extends Error {
  code: CircularErrorCode;
  constructor(code: CircularErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function closesAtFor(circulatedAt: Date): Date {
  return new Date(circulatedAt.getTime() + CIRCULAR_WINDOW_MS);
}

/** True when `at` is inside the inclusive voting window of a circulating resolution. */
export function isWithinWindow(res: Pick<CircularResolution, "status" | "circulatedAt" | "closesAt">, at: Date): boolean {
  if (res.status !== "circulating" || res.circulatedAt === null || res.closesAt === null) return false;
  const t = at.getTime();
  return t >= res.circulatedAt.getTime() && t <= res.closesAt.getTime();
}

/**
 * Effective required approval count for THIS resolution, derived from its
 * FROZEN threshold copy against its circulation snapshot — never from a
 * fresh class read. Fraction classes: the copied fraction. Ordinary
 * present-and-voting classes have no fixed count (decided on votes cast).
 * Any other class on a Board circular falls back to the ws-a §3.12 rule:
 * strict majority of ALL Governors in the snapshot.
 */
export function effectiveRequiredCount(res: CircularResolution): number | null {
  const whole = res.governorUidsSnapshot.length;
  if (whole === 0) return null;
  const t = res.threshold;
  if (t.majorityType === "ordinary_present_and_voting") return null;
  if (t.denominator !== null && t.numerator !== null) {
    return computeRequiredCount(t.majorityType, t.numerator, whole);
  }
  return majorityNeeded(whole);
}

export function tallyVotes(res: CircularResolution): CircularTallies {
  const tallies: CircularTallies = { votesFor: 0, votesAgainst: 0, abstentions: 0, notVoted: 0 };
  const voted = new Set<string>();
  for (const v of res.votes) {
    voted.add(v.uid);
    if (v.choice === "for") tallies.votesFor += 1;
    else if (v.choice === "against") tallies.votesAgainst += 1;
    else tallies.abstentions += 1;
  }
  tallies.notVoted = res.governorUidsSnapshot.filter((u) => !voted.has(u)).length;
  return tallies;
}

export type Outcome = "passed" | "failed" | "undecided";

export interface OutcomeEvaluation {
  outcome: Outcome;
  /** True only for the ws-a §4.7 fraction-of-all early pass. */
  decidedEarly: boolean;
  requiredCount: number | null;
  /** Denominator the rule actually used: whole snapshot, or votes cast. */
  denominatorUsed: number;
  tallies: CircularTallies;
}

/**
 * Outcome math for both denominator rules (ws-a §6.2):
 * - fraction-of-all: denominator is the WHOLE snapshot; passed when
 *   votesFor >= requiredCount; failed only once passage is impossible
 *   (deadline reached short of required, judged by the caller passing
 *   windowEnded=true) — before that it is undecided.
 * - present-and-voting: denominator is votes cast (for + against;
 *   abstentions counted and reported but excluded, per §6.2); passed when
 *   votesFor > votesAgainst; decidable only at window end.
 */
export function evaluateOutcome(
  res: CircularResolution,
  opts: { windowEnded: boolean },
): OutcomeEvaluation {
  const tallies = tallyVotes(res);
  const requiredCount = effectiveRequiredCount(res);

  if (res.threshold.majorityType === "ordinary_present_and_voting") {
    const denominatorUsed = tallies.votesFor + tallies.votesAgainst;
    if (!opts.windowEnded) {
      return { outcome: "undecided", decidedEarly: false, requiredCount, denominatorUsed, tallies };
    }
    const passed = tallies.votesFor > tallies.votesAgainst;
    return { outcome: passed ? "passed" : "failed", decidedEarly: false, requiredCount, denominatorUsed, tallies };
  }

  const denominatorUsed = res.governorUidsSnapshot.length;
  if (requiredCount !== null && tallies.votesFor >= requiredCount) {
    return {
      outcome: "passed",
      decidedEarly: !opts.windowEnded,
      requiredCount,
      denominatorUsed,
      tallies,
    };
  }
  if (opts.windowEnded) {
    return { outcome: "failed", decidedEarly: false, requiredCount, denominatorUsed, tallies };
  }
  return { outcome: "undecided", decidedEarly: false, requiredCount, denominatorUsed, tallies };
}

/**
 * Cast one asynchronous vote. Throws CircularEngineError with a stable code
 * for: not circulating, before the window opens, after it closes, voter not
 * in the circulation snapshot, or a repeat vote (the service maps a repeat
 * signature to ws-a's 409 already_signed).
 * On an early fraction-of-all pass the returned resolution is already
 * status "passed" (ws-a §4.7 immediate close); register/filing side effects
 * are the service's job, keyed off that transition.
 */
export function castVote(
  res: CircularResolution,
  vote: { uid: string; displayName: string; choice: CircularVoteChoice; at: Date },
): CircularResolution {
  if (res.status !== "circulating") {
    throw new CircularEngineError("not_circulating", `resolution is ${res.status}, not circulating`);
  }
  if (res.circulatedAt === null || res.closesAt === null) {
    throw new CircularEngineError("not_circulating", "resolution has no voting window");
  }
  if (vote.at.getTime() < res.circulatedAt.getTime()) {
    throw new CircularEngineError("window_not_open", "vote cast before circulation opened the window");
  }
  if (vote.at.getTime() > res.closesAt.getTime()) {
    throw new CircularEngineError("window_closed", "vote cast after the voting window closed");
  }
  if (!res.governorUidsSnapshot.includes(vote.uid)) {
    throw new CircularEngineError("not_eligible", "voter is not in the circulation snapshot");
  }
  if (res.votes.some((v) => v.uid === vote.uid)) {
    throw new CircularEngineError("already_voted", "voter has already cast a vote on this resolution");
  }

  const cast: CircularVote = { uid: vote.uid, displayName: vote.displayName, choice: vote.choice, castAt: vote.at };
  const votes = [...res.votes, cast];
  const signatures =
    vote.choice === "for"
      ? [
          ...res.signatures,
          { uid: vote.uid, displayName: vote.displayName, signedAt: vote.at, statement: APPROVAL_STATEMENT },
        ]
      : [...res.signatures];
  const next: CircularResolution = {
    ...res,
    votes,
    signatures,
    signedCount: signatures.length,
    updatedAt: vote.at,
  };
  const evaluation = evaluateOutcome(next, { windowEnded: false });
  if (evaluation.outcome === "passed" && evaluation.decidedEarly) {
    return { ...next, status: "passed" };
  }
  return next;
}

/**
 * Cron backstop (ws-a §6.6 T3): a circulating resolution whose closesAt has
 * PASSED (strictly after) is closed — passed if the threshold is already
 * met (normally it closed at sign time; this is the backstop), otherwise
 * lapsed. At exactly closesAt the window is still open: no transition.
 * Returns the (possibly unchanged) resolution plus what happened.
 */
export function evaluateAutoClose(
  res: CircularResolution,
  now: Date,
): { resolution: CircularResolution; transition: "passed" | "lapsed" | null } {
  if (res.status !== "circulating" || res.closesAt === null) {
    return { resolution: res, transition: null };
  }
  if (now.getTime() <= res.closesAt.getTime()) {
    return { resolution: res, transition: null };
  }
  const evaluation = evaluateOutcome(res, { windowEnded: true });
  if (evaluation.outcome === "passed") {
    return { resolution: { ...res, status: "passed", updatedAt: now }, transition: "passed" };
  }
  return { resolution: { ...res, status: "lapsed", updatedAt: now }, transition: "lapsed" };
}
