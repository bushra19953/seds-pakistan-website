import { allocateSeats, applyTieLotWinner, tallyBallots } from "../count";

describe("elections count", () => {
  it("5. allocates 2 seats by plurality with distinct tallies", () => {
    const a = allocateSeats({ c1: 40, c2: 30, c3: 10 }, 2);
    expect(a.elected).toEqual(["c1", "c2"]);
    expect(a.cutoffTie).toBeNull();
    expect(a.seatsPendingLot).toBe(0);
  });

  it("6. detects a tie exactly at the second-seat cutoff and allocates no second seat until a lot is supplied", () => {
    const a = allocateSeats({ c1: 40, c2: 25, c3: 25 }, 2);
    expect(a.elected).toEqual(["c1"]);
    expect(a.cutoffTie).toEqual({
      tiedCandidateUids: ["c2", "c3"],
      votesEach: 25,
      seatsContested: 1,
    });
    expect(a.seatsPendingLot).toBe(1);

    const resolved = applyTieLotWinner(a, "c3");
    expect(resolved.elected).toEqual(["c1", "c3"]);
    expect(resolved.cutoffTie).toBeNull();
  });

  it("rejects a tie lot winner who is not tied", () => {
    const a = allocateSeats({ c1: 40, c2: 25, c3: 25, c4: 1 }, 2);
    expect(() => applyTieLotWinner(a, "c4")).toThrow();
  });

  it("7. does not treat a tie above the cutoff (joint first) as a cutoff tie when both fit", () => {
    const a = allocateSeats({ c1: 30, c2: 30, c3: 10 }, 2);
    expect(a.elected).toEqual(["c1", "c2"]);
    expect(a.cutoffTie).toBeNull();
  });

  it("8. counts blank ballots as blank and reports them separately", () => {
    const t = tallyBallots(
      [
        { choices: ["c1"], isBlank: false },
        { choices: [], isBlank: true },
        { choices: [], isBlank: false },
        { choices: ["c1", "c2"], isBlank: false },
      ],
      ["c1", "c2"],
      2,
    );
    expect(t.ballotsCounted).toBe(4);
    expect(t.blankBallots).toBe(2);
    expect(t.invalidBallots).toBe(0);
    expect(t.tallies).toEqual({ c1: 2, c2: 1 });
  });

  it("flags ballots with non-certified or duplicate choices as invalid", () => {
    const t = tallyBallots(
      [
        { choices: ["ghost"], isBlank: false },
        { choices: ["c1", "c1"], isBlank: false },
      ],
      ["c1"],
      2,
    );
    expect(t.invalidBallots).toBe(2);
    expect(t.tallies).toEqual({ c1: 0 });
  });

  it("allocates all seats when candidates do not exceed seats", () => {
    const a = allocateSeats({ c1: 5, c2: 3 }, 2);
    expect(a.elected).toEqual(["c1", "c2"]);
    expect(a.cutoffTie).toBeNull();
  });
});
