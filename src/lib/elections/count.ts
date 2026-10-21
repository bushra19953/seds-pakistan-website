/**
 * Pure count and seat-allocation logic (spec Sections 3.5, 6.4, 6.5).
 * Plurality (Decision Rights row 5.21). No Firebase imports.
 *
 * A tie is a CUTOFF tie only when the tied candidates straddle the last
 * seat: more candidates share the cutoff vote total than there are
 * seats remaining for them. A tie fully inside the seats (for example
 * joint first with 2 seats) is not a cutoff tie and allocates normally.
 */

export interface CutoffTieResult {
  tiedCandidateUids: string[];
  votesEach: number;
  seatsContested: number;
}

export interface SeatAllocation {
  /** Candidate uids elected outright, in tally order. */
  elected: string[];
  /** Present when a lot draw must decide the remaining seat(s). */
  cutoffTie: CutoffTieResult | null;
  /** Seats left open pending a tie lot (0 when no cutoff tie). */
  seatsPendingLot: number;
}

export function rankCandidates(
  tallies: Record<string, number>,
): Array<{ candidateUid: string; votes: number }> {
  return Object.entries(tallies)
    .map(([candidateUid, votes]) => ({ candidateUid, votes }))
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      return a.candidateUid < b.candidateUid ? -1 : 1;
    });
}

export function allocateSeats(
  tallies: Record<string, number>,
  seats: number,
): SeatAllocation {
  const ranked = rankCandidates(tallies);
  if (seats <= 0 || ranked.length === 0) {
    return { elected: [], cutoffTie: null, seatsPendingLot: 0 };
  }
  if (ranked.length <= seats) {
    return {
      elected: ranked.map((r) => r.candidateUid),
      cutoffTie: null,
      seatsPendingLot: 0,
    };
  }

  const cutoffVotes = ranked[seats - 1].votes;
  const aboveCutoff = ranked.filter((r) => r.votes > cutoffVotes);
  const atCutoff = ranked.filter((r) => r.votes === cutoffVotes);
  const seatsForTied = seats - aboveCutoff.length;

  if (atCutoff.length <= seatsForTied) {
    // Everyone at the cutoff fits: no contested tie.
    return {
      elected: ranked.slice(0, seats).map((r) => r.candidateUid),
      cutoffTie: null,
      seatsPendingLot: 0,
    };
  }

  return {
    elected: aboveCutoff.map((r) => r.candidateUid),
    cutoffTie: {
      tiedCandidateUids: atCutoff.map((r) => r.candidateUid),
      votesEach: cutoffVotes,
      seatsContested: seatsForTied,
    },
    seatsPendingLot: seatsForTied,
  };
}

/**
 * Apply a recorded tie-lot outcome to an allocation. The winner must be
 * one of the tied candidates; v1 contests exactly one seat by lot (a
 * multi-seat lot is resolved by successive recorded draws).
 */
export function applyTieLotWinner(
  allocation: SeatAllocation,
  winnerUid: string,
): SeatAllocation {
  if (!allocation.cutoffTie) return allocation;
  if (!allocation.cutoffTie.tiedCandidateUids.includes(winnerUid)) {
    throw new Error("Tie lot winner is not one of the tied candidates.");
  }
  const remaining = allocation.seatsPendingLot - 1;
  return {
    elected: [...allocation.elected, winnerUid],
    cutoffTie:
      remaining > 0
        ? {
            ...allocation.cutoffTie,
            tiedCandidateUids: allocation.cutoffTie.tiedCandidateUids.filter(
              (u) => u !== winnerUid,
            ),
            seatsContested: remaining,
          }
        : null,
    seatsPendingLot: remaining,
  };
}

export interface BallotTallyInput {
  choices: string[];
  isBlank: boolean;
}

export interface TallyResult {
  tallies: Record<string, number>;
  ballotsCounted: number;
  blankBallots: number;
  invalidBallots: number;
}

/**
 * Tally ballot docs against the certified candidate list. A ballot
 * whose choices include a non-certified candidate or duplicates cannot
 * exist (the cast transaction validates), so any such ballot is
 * counted invalid and is itself an integrity flag (spec 6.4 step 2).
 */
export function tallyBallots(
  ballots: BallotTallyInput[],
  certifiedCandidateUids: string[],
  seats: number,
): TallyResult {
  const certified = new Set(certifiedCandidateUids);
  const tallies: Record<string, number> = {};
  for (const uid of certifiedCandidateUids) tallies[uid] = 0;
  let blankBallots = 0;
  let invalidBallots = 0;

  for (const ballot of ballots) {
    if (ballot.isBlank || ballot.choices.length === 0) {
      blankBallots += 1;
      continue;
    }
    const unique = new Set(ballot.choices);
    const valid =
      ballot.choices.length <= seats &&
      unique.size === ballot.choices.length &&
      ballot.choices.every((c) => certified.has(c));
    if (!valid) {
      invalidBallots += 1;
      continue;
    }
    for (const choice of ballot.choices) tallies[choice] += 1;
  }

  return {
    tallies,
    ballotsCounted: ballots.length,
    blankBallots,
    invalidBallots,
  };
}
