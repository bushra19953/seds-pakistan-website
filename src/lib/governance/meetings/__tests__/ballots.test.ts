import {
  applySecretDemand,
  assertMethodTransition,
  assertSecretChoiceDocShape,
  assertSecretTokenDocShape,
  buildSecretBallotChoiceDoc,
  buildSecretBallotTokenDoc,
  evaluateBallotOutcome,
  needsCastingVote,
  roundToMinute,
  tallyBallots,
  tallyChoices,
  type MotionRef,
} from "../ballots";

const motion = (over: Partial<MotionRef> = {}): MotionRef => ({
  id: "m1",
  meetingId: "mtg1",
  bodyId: "b1",
  bodyType: "board",
  text: "Approve",
  proposerUid: "u1",
  decisionClassId: "c1",
  threshold: {
    majorityType: "ordinary_present_and_voting",
    numerator: null,
    denominatorKind: "present_and_voting",
    requiredCount: null,
    consentRequired: false,
    isReservedMatter: false,
    filingFlag: false,
  },
  denominatorSnapshot: { eligibleUids: ["u1", "u2", "u3"], presentUids: ["u1", "u2", "u3"], presentCount: 3, wholeBodyCount: 3 },
  method: "electronic_poll",
  secretDemandedBy: [],
  status: "open",
  ...over,
});

describe("secret demand lock-in (ws-a §3.5/§4.5)", () => {
  it("does NOT lock at 1 demand", () => {
    const r = applySecretDemand(motion(), "u1");
    expect(r.demands).toBe(1);
    expect(r.locked).toBe(false);
    expect(r.method).toBe("electronic_poll");
  });
  it("locks at exactly 2 distinct demands", () => {
    const first = applySecretDemand(motion(), "u1");
    const second = applySecretDemand(motion({ secretDemandedBy: first.secretDemandedBy, method: first.method }), "u2");
    expect(second.demands).toBe(2);
    expect(second.locked).toBe(true);
    expect(second.method).toBe("secret_ballot");
  });
  it("is idempotent per uid — same member twice counts once", () => {
    const r = applySecretDemand(motion({ secretDemandedBy: ["u1"] }), "u1");
    expect(r.demands).toBe(1);
    expect(r.added).toBe(false);
    expect(r.locked).toBe(false);
  });
  it("locked method can never revert", () => {
    expect(() => assertMethodTransition("secret_ballot", "electronic_poll")).toThrow(/locked/);
    expect(() => assertMethodTransition("electronic_poll", "secret_ballot")).not.toThrow();
  });
});

describe("secret store anonymity by schema", () => {
  it("choice doc has exactly motionId/choice/castAt and castAt rounded to the minute", () => {
    const doc = buildSecretBallotChoiceDoc({ motionId: "m1", choice: "for", castAt: new Date("2026-10-21T10:11:42.900Z") });
    expect(Object.keys(doc).sort()).toEqual(["castAt", "choice", "motionId"]);
    expect(doc.castAt.toISOString()).toBe("2026-10-21T10:11:00.000Z");
  });
  it("token doc has exactly motionId/used/usedAt — no uid", () => {
    const doc = buildSecretBallotTokenDoc({ motionId: "m1" });
    expect(Object.keys(doc).sort()).toEqual(["motionId", "used", "usedAt"]);
  });
  it("schema assertion rejects any voter-linkage field", () => {
    for (const bad of ["uid", "voterUid", "userId", "token", "ip", "userAgent", "email"]) {
      expect(() => assertSecretChoiceDocShape({ motionId: "m1", choice: "for", castAt: new Date(), [bad]: "x" })).toThrow();
      expect(() => assertSecretTokenDocShape({ motionId: "m1", used: false, usedAt: null, [bad]: "x" })).toThrow();
    }
  });
  it("roundToMinute zeroes seconds/ms", () => {
    expect(roundToMinute(new Date("2026-01-01T00:00:59.999Z")).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("counting totals", () => {
  it("tallyChoices counts aggregates only", () => {
    expect(tallyChoices(["for", "for", "against", "abstain", "for"])).toEqual({ votesFor: 3, votesAgainst: 1, abstentions: 1 });
  });
  it("tallyBallots excludes the casting ballot", () => {
    const b = (choice: any, isCastingVote = false) => ({
      motionId: "m1", meetingId: "mtg1", voterUid: "u", choice, isProxy: false,
      proxyForUid: null, proxyAuthorizationId: null, isCastingVote, interestDisclosure: null, castAt: new Date(),
    });
    expect(tallyBallots([b("for"), b("against"), b("for", true)])).toEqual({ votesFor: 1, votesAgainst: 1, abstentions: 0 });
  });
});

describe("tie handling / casting ballot (ws-a §6.2)", () => {
  const tallies = { votesFor: 3, votesAgainst: 3, abstentions: 1 };
  it("ordinary pass/fail without tie", () => {
    expect(evaluateBallotOutcome({ bodyType: "board", threshold: motion().threshold, denominatorSnapshot: motion().denominatorSnapshot, tallies: { votesFor: 4, votesAgainst: 3, abstentions: 2 } }).outcome).toBe("passed");
  });
  it("tie at board returns tie_pending_casting", () => {
    const r = evaluateBallotOutcome({ bodyType: "board", threshold: motion().threshold, denominatorSnapshot: motion().denominatorSnapshot, tallies });
    expect(r.outcome).toBe("tie_pending_casting");
    expect(r.result).toBeNull();
    expect(needsCastingVote({ bodyType: "board", threshold: motion().threshold, tallies })).toBe(true);
  });
  it("tie at council also pending; tie at nec is plain failed", () => {
    expect(evaluateBallotOutcome({ bodyType: "council", threshold: motion().threshold, denominatorSnapshot: motion().denominatorSnapshot, tallies }).outcome).toBe("tie_pending_casting");
    expect(evaluateBallotOutcome({ bodyType: "nec", threshold: motion().threshold, denominatorSnapshot: motion().denominatorSnapshot, tallies }).outcome).toBe("failed");
  });
  it("casting for passes, casting against fails, casting abstain fails with castingVoteUsed", () => {
    const snap = motion().denominatorSnapshot;
    expect(evaluateBallotOutcome({ bodyType: "board", threshold: motion().threshold, denominatorSnapshot: snap, tallies, castingChoice: "for" })).toMatchObject({ outcome: "passed", result: { thresholdMet: true, castingVoteUsed: true, castingChoice: "for" } });
    expect(evaluateBallotOutcome({ bodyType: "board", threshold: motion().threshold, denominatorSnapshot: snap, tallies, castingChoice: "against" }).outcome).toBe("failed");
    expect(evaluateBallotOutcome({ bodyType: "board", threshold: motion().threshold, denominatorSnapshot: snap, tallies, castingChoice: "abstain" })).toMatchObject({ outcome: "failed", result: { castingVoteUsed: true } });
  });
  it("0-0 with no votes cast is not a casting tie", () => {
    expect(needsCastingVote({ bodyType: "board", threshold: motion().threshold, tallies: { votesFor: 0, votesAgainst: 0, abstentions: 2 } })).toBe(false);
  });
  it("fraction threshold: requiredCount governs, casting never applies", () => {
    const th = { ...motion().threshold, majorityType: "fraction_of_all_governors" as const, requiredCount: 6, numerator: 2 };
    const snap = { ...motion().denominatorSnapshot, wholeBodyCount: 9 };
    expect(evaluateBallotOutcome({ bodyType: "board", threshold: th, denominatorSnapshot: snap, tallies: { votesFor: 5, votesAgainst: 0, abstentions: 0 } }).outcome).toBe("failed");
    expect(evaluateBallotOutcome({ bodyType: "board", threshold: th, denominatorSnapshot: snap, tallies: { votesFor: 6, votesAgainst: 6, abstentions: 0 }, castingChoice: "for" })).toMatchObject({ outcome: "passed", result: { castingVoteUsed: false } });
  });
});
