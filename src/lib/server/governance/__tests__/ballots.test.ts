import {
  BallotError,
  InMemoryBallotStore,
  castCastingBallot,
  castSecretBallot,
  castTraceableBallot,
  closeMotionBallots,
  demandSecretBallot,
  hashSecretToken,
  issueSecretToken,
} from "../ballots";
import {
  SECRET_CHOICE_KEYS,
  SECRET_TOKEN_KEYS,
  type MotionRef,
} from "@/lib/governance/meetings/ballots";

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
  denominatorSnapshot: {
    eligibleUids: ["u1", "u2", "u3", "u4"],
    presentUids: ["u1", "u2", "u3", "u4"],
    presentCount: 4,
    wholeBodyCount: 4,
  },
  method: "electronic_poll",
  secretDemandedBy: [],
  status: "open",
  ...over,
});

async function storeWith(m: MotionRef) {
  const s = new InMemoryBallotStore();
  await s.saveMotion(m);
  return s;
}

describe("demand-secret route logic", () => {
  it("1 demand does not lock; the 2nd locks to secret_ballot", async () => {
    const s = await storeWith(motion());
    expect(await demandSecretBallot(s, { motionId: "m1", uid: "u1" })).toEqual({ demands: 1, method: "electronic_poll", locked: false });
    expect(await demandSecretBallot(s, { motionId: "m1", uid: "u2" })).toEqual({ demands: 2, method: "secret_ballot", locked: true });
    expect((await s.getMotion("m1"))?.method).toBe("secret_ballot");
  });
  it("rejects a demand from a non-present / ineligible member", async () => {
    const s = await storeWith(motion());
    await expect(demandSecretBallot(s, { motionId: "m1", uid: "outsider" })).rejects.toMatchObject({ code: "not_eligible" });
  });
});

describe("traceable ballots", () => {
  it("double vote is rejected 409 and totals do not change", async () => {
    const s = await storeWith(motion());
    await castTraceableBallot(s, { motionId: "m1", voterUid: "u1", choice: "for" });
    await expect(castTraceableBallot(s, { motionId: "m1", voterUid: "u1", choice: "against" }))
      .rejects.toMatchObject({ code: "already_voted", status: 409 });
    const closed = await closeMotionBallots(s, { motionId: "m1" });
    expect(closed.tallies).toEqual({ votesFor: 1, votesAgainst: 0, abstentions: 0 });
  });
  it("interest disclosure never blocks a ballot (no-recusal, ws-a N1)", async () => {
    const s = await storeWith(motion());
    const r = await castTraceableBallot(s, {
      motionId: "m1", voterUid: "u1", choice: "for",
      interestDisclosure: { hasInterest: true, description: "vendor", relatedPartyName: "Acme" },
    });
    expect((await s.getBallot(r.ballotId))?.interestDisclosure?.hasInterest).toBe(true);
  });
  it("proxy vote without authorization -> 422; with valid + effective -> accepted as proxy", async () => {
    const s = await storeWith(motion());
    await expect(castTraceableBallot(s, { motionId: "m1", voterUid: "u2", choice: "for", proxyForUid: "u1", proxyAuthorizationId: "missing" }))
      .rejects.toMatchObject({ code: "proxy_not_authorized", status: 422 });
    s.proxies.set("pa1", {
      id: "pa1", meetingId: "mtg1", grantorUid: "u1", proxyUid: "u2",
      advanceResolutionDecisionId: "dec1", scopeMotionIds: null, revokedAt: null,
    });
    // Default adapter denies (fail closed) when no effectiveness checker injected.
    await expect(castTraceableBallot(s, { motionId: "m1", voterUid: "u2", choice: "for", proxyForUid: "u1", proxyAuthorizationId: "pa1" }))
      .rejects.toMatchObject({ code: "proxy_not_authorized" });
    const r = await castTraceableBallot(s, {
      motionId: "m1", voterUid: "u2", choice: "for", proxyForUid: "u1", proxyAuthorizationId: "pa1",
      isEffectiveDecision: async (id) => id === "dec1",
    });
    expect(await s.getBallot(r.ballotId)).toMatchObject({ isProxy: true, proxyForUid: "u1", voterUid: "u2" });
    // The grantor cannot also vote directly afterwards.
    await expect(castTraceableBallot(s, { motionId: "m1", voterUid: "u1", choice: "against" }))
      .rejects.toMatchObject({ code: "already_voted" });
  });
  it("voting on a paused (quorum lost) motion -> 409 quorum_lost", async () => {
    const s = await storeWith(motion({ status: "paused_quorum_lost" }));
    await expect(castTraceableBallot(s, { motionId: "m1", voterUid: "u1", choice: "for" }))
      .rejects.toMatchObject({ code: "quorum_lost" });
  });
});

describe("secret ballot store", () => {
  async function secretStore() {
    const s = await storeWith(motion({ method: "secret_ballot", secretDemandedBy: ["u1", "u2"] }));
    return s;
  }
  it("SCHEMA INSPECTION: no written token/choice doc contains any voter-linkage field", async () => {
    const s = await secretStore();
    const { token } = await issueSecretToken(s, { motionId: "m1", uid: "u1" });
    await castSecretBallot(s, { token, choice: "for", now: new Date("2026-10-21T10:11:42Z") });
    const linkage = /uid|voter|user|token|ip|agent|email|name/i;
    for (const doc of s.secretTokens.values()) {
      expect(Object.keys(doc).sort()).toEqual([...SECRET_TOKEN_KEYS].sort());
      expect(Object.keys(doc).some((k) => linkage.test(k))).toBe(false);
    }
    for (const doc of s.secretChoices.values()) {
      expect(Object.keys(doc).sort()).toEqual([...SECRET_CHOICE_KEYS].sort());
      expect(Object.keys(doc).some((k) => linkage.test(k))).toBe(false);
      // Participation tracking is separate: issue log holds uid but NO choice.
      expect(JSON.stringify(doc)).not.toContain("u1");
    }
    for (const issue of s.tokenIssues.values()) {
      expect(Object.keys(issue)).toEqual(["issuedAt"]); // no choice field
    }
    // Token doc is keyed by hash; the raw token itself is never a stored value.
    expect([...s.secretTokens.keys()]).toEqual([hashSecretToken(token)]);
    expect(JSON.stringify([...s.secretTokens.values()])).not.toContain(token);
  });
  it("issue_token twice for one voter is refused; other voters unaffected", async () => {
    const s = await secretStore();
    await issueSecretToken(s, { motionId: "m1", uid: "u1" });
    await expect(issueSecretToken(s, { motionId: "m1", uid: "u1" })).rejects.toMatchObject({ code: "token_already_issued", status: 409 });
    await expect(issueSecretToken(s, { motionId: "m1", uid: "u2" })).resolves.toHaveProperty("token");
  });
  it("cast with a reused token is refused; unknown token refused", async () => {
    const s = await secretStore();
    const { token } = await issueSecretToken(s, { motionId: "m1", uid: "u1" });
    await castSecretBallot(s, { token, choice: "against" });
    await expect(castSecretBallot(s, { token, choice: "for" })).rejects.toMatchObject({ code: "token_reused" });
    await expect(castSecretBallot(s, { token: "nope", choice: "for" })).rejects.toMatchObject({ code: "invalid_token" });
    expect(s.secretChoices.size).toBe(1);
  });
  it("counting totals correct, aggregates only; issue log deleted at close", async () => {
    const s = await secretStore();
    for (const [uid, choice] of [["u1", "for"], ["u2", "for"], ["u3", "against"], ["u4", "abstain"]] as const) {
      const { token } = await issueSecretToken(s, { motionId: "m1", uid });
      await castSecretBallot(s, { token, choice });
    }
    const closed = await closeMotionBallots(s, { motionId: "m1" });
    expect(closed).toMatchObject({ status: "closed_passed", tallies: { votesFor: 2, votesAgainst: 1, abstentions: 1 } });
    expect(closed.result).toMatchObject({ votesFor: 2, votesAgainst: 1, abstentions: 1, castingVoteUsed: false });
    expect(s.tokenIssues.size).toBe(0);
  });
  it("traceable cast on a secret motion is refused (must use token flow)", async () => {
    const s = await secretStore();
    await expect(castTraceableBallot(s, { motionId: "m1", voterUid: "u1", choice: "for" }))
      .rejects.toMatchObject({ code: "method_is_secret" });
  });
});

describe("tie -> casting ballot lifecycle", () => {
  it("tie closes pending casting, Founder casting decides, second close finalizes", async () => {
    const s = await storeWith(motion());
    await castTraceableBallot(s, { motionId: "m1", voterUid: "u1", choice: "for" });
    await castTraceableBallot(s, { motionId: "m1", voterUid: "u2", choice: "against" });
    const first = await closeMotionBallots(s, { motionId: "m1" });
    expect(first).toMatchObject({ status: "closed_tied_pending_casting", tied: true, result: null });

    // Non-founder casting attempt rejected.
    await expect(castCastingBallot(s, { motionId: "m1", founderUid: "u3", isFounder: false, choice: "for" }))
      .rejects.toMatchObject({ code: "founder_only" });
    await castCastingBallot(s, { motionId: "m1", founderUid: "founder1", isFounder: true, choice: "for" });
    // Casting ballot is stored separately and does not inflate the tallies.
    const fin = await closeMotionBallots(s, { motionId: "m1" });
    expect(fin).toMatchObject({ status: "closed_passed", tied: false, tallies: { votesFor: 1, votesAgainst: 1, abstentions: 0 } });
    expect(fin.result).toMatchObject({ castingVoteUsed: true, castingChoice: "for", thresholdMet: true });
  });
  it("casting ballot rejected when the motion is not tied-pending", async () => {
    const s = await storeWith(motion());
    await expect(castCastingBallot(s, { motionId: "m1", founderUid: "founder1", isFounder: true, choice: "for" }))
      .rejects.toBeInstanceOf(BallotError);
  });
});
