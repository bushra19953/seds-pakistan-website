import {
  CIRCULAR_WINDOW_MS,
  CircularEngineError,
  castVote,
  closesAtFor,
  effectiveRequiredCount,
  evaluateAutoClose,
  evaluateOutcome,
  isWithinWindow,
  tallyVotes,
} from "../engine";
import {
  majorityNeeded,
  resolveDecisionClass,
  snapshotThreshold,
} from "../threshold";
import type { CircularResolution, DecisionClassView } from "../types";

const T0 = new Date("2026-10-21T09:00:00Z");
const GOVERNORS_9 = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];

function circulating(over: Partial<CircularResolution> = {}): CircularResolution {
  const cls = resolveDecisionClass("class_board_ordinary")!;
  return {
    id: "circ_1",
    bodyId: "board_body",
    bodyType: "board",
    title: "Budget approval",
    text: "The Board resolves to approve the budget.",
    decisionClassId: cls.id,
    consentId: "consent_1",
    status: "circulating",
    threshold: snapshotThreshold(cls, 0),
    circulatedAt: T0,
    closesAt: closesAtFor(T0),
    createdBy: "g1",
    createdAt: T0,
    updatedAt: T0,
    governorUidsSnapshot: [...GOVERNORS_9],
    signatures: [],
    votes: [],
    signedCount: 0,
    decisionId: null,
    filingTaskId: null,
    ...over,
  };
}

const voteFor = (res: CircularResolution, uid: string, at: Date) =>
  castVote(res, { uid, displayName: uid.toUpperCase(), choice: "for", at });

describe("circular window (ws-a §3.12: [circulatedAt, closesAt] inclusive)", () => {
  it("closesAt is exactly circulatedAt + 7 days", () => {
    expect(closesAtFor(T0).getTime() - T0.getTime()).toBe(CIRCULAR_WINDOW_MS);
    expect(CIRCULAR_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("a vote exactly at circulatedAt is accepted", () => {
    const next = voteFor(circulating(), "g1", T0);
    expect(next.votes).toHaveLength(1);
  });

  it("a vote exactly at closesAt is accepted (inclusive end)", () => {
    const res = circulating();
    const next = voteFor(res, "g1", res.closesAt!);
    expect(next.votes).toHaveLength(1);
    expect(isWithinWindow(res, res.closesAt!)).toBe(true);
  });

  it("a vote 1ms after closesAt is rejected as window_closed", () => {
    const res = circulating();
    const after = new Date(res.closesAt!.getTime() + 1);
    expect(() => voteFor(res, "g1", after)).toThrow(CircularEngineError);
    expect(() => voteFor(res, "g1", after)).toThrow(/after the voting window closed/);
    expect(isWithinWindow(res, after)).toBe(false);
  });

  it("a vote before circulation opens is rejected as window_not_open", () => {
    const before = new Date(T0.getTime() - 1);
    expect(() => voteFor(circulating(), "g1", before)).toThrow(/before circulation/);
  });

  it("a vote on a draft (not circulating) is rejected", () => {
    const draft = circulating({ status: "draft", circulatedAt: null, closesAt: null });
    expect(() => voteFor(draft, "g1", T0)).toThrow(/not circulating/);
    expect(isWithinWindow(draft, T0)).toBe(false);
  });
});

describe("circular eligibility and repeat votes", () => {
  it("a voter outside the circulation snapshot is rejected", () => {
    expect(() => voteFor(circulating(), "outsider", T0)).toThrow(/not in the circulation snapshot/);
  });

  it("a second vote from the same Governor is rejected (maps to 409 already_signed)", () => {
    const once = voteFor(circulating(), "g1", T0);
    expect(() => voteFor(once, "g1", T0)).toThrow(/already cast a vote/);
  });

  it("a 'for' vote is mirrored into signatures with the approval statement", () => {
    const next = voteFor(circulating(), "g1", T0);
    expect(next.signedCount).toBe(1);
    expect(next.signatures[0]).toMatchObject({ uid: "g1", statement: "I approve this resolution" });
  });

  it("an 'against' vote is recorded but is not a signature", () => {
    const next = castVote(circulating(), { uid: "g1", displayName: "G1", choice: "against", at: T0 });
    expect(next.votes).toHaveLength(1);
    expect(next.signedCount).toBe(0);
  });
});

describe("circular outcome math: fraction of ALL Governors (ws-a §3.12, §6.2)", () => {
  it("strict majority of 9 is 5; 4 approvals before the deadline is undecided", () => {
    let res = circulating();
    for (const uid of GOVERNORS_9.slice(0, 4)) res = voteFor(res, uid, T0);
    const ev = evaluateOutcome(res, { windowEnded: false });
    expect(ev.requiredCount).toBe(5);
    expect(ev.denominatorUsed).toBe(9);
    expect(ev.outcome).toBe("undecided");
    expect(res.status).toBe("circulating");
  });

  it("the 5th approval closes the resolution as passed immediately (ws-a §4.7)", () => {
    let res = circulating();
    for (const uid of GOVERNORS_9.slice(0, 5)) res = voteFor(res, uid, T0);
    expect(res.status).toBe("passed");
    const ev = evaluateOutcome(res, { windowEnded: false });
    expect(ev.outcome).toBe("passed");
    expect(ev.decidedEarly).toBe(true);
  });

  it("2/3 of all Governors (row 5.54) requires 6 of 9 regardless of who has voted", () => {
    const cls = resolveDecisionClass("class_board_reversal")!;
    const res = circulating({
      decisionClassId: cls.id,
      threshold: snapshotThreshold(cls, 0),
    });
    expect(effectiveRequiredCount(res)).toBe(6);
    let voted = res;
    for (const uid of GOVERNORS_9.slice(0, 5)) voted = voteFor(voted, uid, T0);
    expect(voted.status).toBe("circulating"); // 5 of 9 is not 2/3
    voted = voteFor(voted, "g6", T0);
    expect(voted.status).toBe("passed");
  });

  it("at window end, short of the required count the outcome is failed (service marks lapsed)", () => {
    let res = circulating();
    for (const uid of GOVERNORS_9.slice(0, 4)) res = voteFor(res, uid, T0);
    const ev = evaluateOutcome(res, { windowEnded: true });
    expect(ev.outcome).toBe("failed");
  });
});

describe("circular outcome math: present-and-voting (ws-a §6.2)", () => {
  function pvResolution(): CircularResolution {
    const cls: DecisionClassView = {
      id: "class_pv",
      label: "PV",
      assignedBodyType: "board",
      majorityType: "ordinary_present_and_voting",
      numerator: null,
      denominatorKind: "present_and_voting",
      consentRequired: false,
      isReservedMatter: false,
      filingFlag: false,
      sourceRow: "4.3",
    };
    return circulating({ decisionClassId: cls.id, threshold: snapshotThreshold(cls, 0) });
  }

  it("has no fixed required count and stays undecided until the window ends", () => {
    let res = pvResolution();
    res = castVote(res, { uid: "g1", displayName: "G1", choice: "for", at: T0 });
    res = castVote(res, { uid: "g2", displayName: "G2", choice: "for", at: T0 });
    res = castVote(res, { uid: "g3", displayName: "G3", choice: "against", at: T0 });
    expect(res.status).toBe("circulating");
    expect(evaluateOutcome(res, { windowEnded: false }).outcome).toBe("undecided");
    const end = evaluateOutcome(res, { windowEnded: true });
    expect(end.outcome).toBe("passed"); // 2 for > 1 against
    expect(end.denominatorUsed).toBe(3); // abstentions excluded from the denominator
  });

  it("a tie at window end fails for present-and-voting (passed requires for > against)", () => {
    let res = pvResolution();
    res = castVote(res, { uid: "g1", displayName: "G1", choice: "for", at: T0 });
    res = castVote(res, { uid: "g2", displayName: "G2", choice: "against", at: T0 });
    res = castVote(res, { uid: "g3", displayName: "G3", choice: "abstain", at: T0 });
    expect(evaluateOutcome(res, { windowEnded: true }).outcome).toBe("failed");
  });
});

describe("circular auto-close backstop (ws-a §6.6 T3)", () => {
  it("does nothing at exactly closesAt (window still open)", () => {
    const res = circulating();
    const { transition } = evaluateAutoClose(res, res.closesAt!);
    expect(transition).toBeNull();
  });

  it("lapses a circulating resolution past closesAt that never reached its count", () => {
    let res = circulating();
    res = voteFor(res, "g1", T0);
    const after = new Date(res.closesAt!.getTime() + 1000);
    const { resolution, transition } = evaluateAutoClose(res, after);
    expect(transition).toBe("lapsed");
    expect(resolution.status).toBe("lapsed");
  });

  it("is idempotent: a closed resolution never transitions again", () => {
    const closed = circulating({ status: "passed" });
    const after = new Date(closed.closesAt!.getTime() + 1000);
    expect(evaluateAutoClose(closed, after).transition).toBeNull();
  });
});

describe("circular threshold immutability (ws-a §3.5 rule applied to circulars)", () => {
  it("the copied threshold is frozen and immune to later class edits", () => {
    const cls: DecisionClassView = { ...resolveDecisionClass("class_board_ordinary")! };
    const copy = snapshotThreshold(cls, 0);
    expect(Object.isFrozen(copy)).toBe(true);
    // Simulate a later matrix edit: the class view object changes.
    cls.consentRequired = false;
    cls.isReservedMatter = true;
    cls.numerator = 99;
    expect(copy.consentRequired).toBe(true);
    expect(copy.isReservedMatter).toBe(false);
    expect(copy.numerator).toBe(1);
  });

  it("effectiveRequiredCount derives from the COPIED fraction against the snapshot, not a re-read", () => {
    const cls = resolveDecisionClass("class_board_reversal")!;
    const res = circulating({ decisionClassId: cls.id, threshold: snapshotThreshold(cls, 0) });
    // 2/3 copied: of a 9-Governor snapshot the requirement is 6 even though
    // the copy was made when the whole-body count was unknown (0).
    expect(effectiveRequiredCount(res)).toBe(6);
    expect(majorityNeeded(9)).toBe(5);
    expect(majorityNeeded(8)).toBe(5); // strictly more than half
  });
});

describe("circular tallies", () => {
  it("counts for/against/abstain and the not-voted remainder of the snapshot", () => {
    let res = circulating();
    res = voteFor(res, "g1", T0);
    res = castVote(res, { uid: "g2", displayName: "G2", choice: "against", at: T0 });
    res = castVote(res, { uid: "g3", displayName: "G3", choice: "abstain", at: T0 });
    expect(tallyVotes(res)).toEqual({ votesFor: 1, votesAgainst: 1, abstentions: 1, notVoted: 6 });
  });
});
