/**
 * Minutes auto-draft tests (ws-a sections 3.7, 6.3, test case 14).
 * Fixture: a closed meeting with 2 motions, 1 disclosure, and 1 granted
 * plus 1 refused consent generates all six sec 3.5 fields.
 */
import {
  buildMinutesDraft,
  validateMinutesCompleteness,
  MINUTES_SEC_3_5_FIELDS,
  MINUTES_SEC_3_5_CHECKLIST,
  type BuildMinutesDraftInput,
} from "../minutes-draft";

const fixture: BuildMinutesDraftInput = {
  meeting: {
    id: "mtg_1",
    bodyId: "body_board",
    bodyType: "board",
    consentId: "consent_granted",
    quorumRequired: 5,
    quorumVerifiedAt: "2026-10-21T10:05:00.000Z",
    quorumVerifiedBy: "uid_chair",
    closedAt: "2026-10-21T11:00:00.000Z",
  },
  attendance: [
    { uid: "uid_chair", displayName: "Chair One", mode: "in_person", isPresent: true },
    { uid: "uid_a", displayName: "Member A", mode: "in_person", isPresent: true },
    { uid: "uid_b", displayName: "Member B", mode: "electronic", isPresent: true },
    { uid: "uid_c", displayName: "Member C", mode: "electronic", isPresent: true },
    { uid: "uid_d", displayName: "Member D", mode: "in_person", isPresent: true },
    { uid: "uid_e", displayName: "Member E", mode: "absent", isPresent: false },
  ],
  motions: [
    {
      id: "motion_1",
      text: "Approve the annual budget",
      decisionClassId: "class_budget",
      proposerUid: "uid_a",
      method: "electronic_poll",
      status: "closed_passed",
      consentId: "consent_granted",
    },
    {
      id: "motion_2",
      text: "Elect the returning officer",
      decisionClassId: "class_election_admin",
      proposerUid: "uid_b",
      method: "secret_ballot",
      status: "closed_passed",
      consentId: "consent_refused",
    },
  ],
  ballots: [
    { motionId: "motion_1", voterUid: "uid_chair", choice: "for" },
    { motionId: "motion_1", voterUid: "uid_a", choice: "for", interestDisclosure: { hasInterest: true, description: "Supplier is a relative", relatedPartyName: "Acme Supplies" } },
    { motionId: "motion_1", voterUid: "uid_b", choice: "for" },
    { motionId: "motion_1", voterUid: "uid_c", choice: "against" },
    { motionId: "motion_1", voterUid: "uid_d", choice: "abstain" },
    // Stray per-voter data for the SECRET motion: must never be copied.
    { motionId: "motion_2", voterUid: "uid_a", choice: "against" },
  ],
  secretTotals: [
    { motionId: "motion_2", votesFor: 4, votesAgainst: 1, abstentions: 0 },
  ],
  consents: [
    { consentId: "consent_granted", matter: "Budget spend", outcome: "granted", decidedAt: "2026-10-20T09:00:00.000Z" },
    { consentId: "consent_refused", matter: "Officer appointment", outcome: "refused", decidedAt: "2026-10-20T09:30:00.000Z" },
  ],
};

describe("buildMinutesDraft (ws-a 3.7, test case 14)", () => {
  const draft = buildMinutesDraft(fixture);

  it("generates all six sec 3.5 fields", () => {
    for (const field of MINUTES_SEC_3_5_FIELDS) {
      expect(draft).toHaveProperty(field);
    }
    expect(MINUTES_SEC_3_5_CHECKLIST).toHaveLength(6);
    expect(validateMinutesCompleteness(draft)).toEqual({
      complete: true,
      missing: [],
    });
  });

  it("(a) splits attendees into present / absent / electronic", () => {
    expect(draft.fieldAttendees.present.map((p) => p.uid)).toEqual([
      "uid_chair",
      "uid_a",
      "uid_b",
      "uid_c",
      "uid_d",
    ]);
    expect(draft.fieldAttendees.electronic.map((p) => p.uid)).toEqual([
      "uid_b",
      "uid_c",
    ]);
    expect(draft.fieldAttendees.absent).toEqual([
      { uid: "uid_e", displayName: "Member E" },
    ]);
  });

  it("(b) carries the quorum verification record", () => {
    expect(draft.fieldQuorum).toMatchObject({
      quorumRequired: 5,
      presentCount: 5,
      verifiedBy: "uid_chair",
      met: true,
    });
    expect(draft.fieldQuorum.verifiedAt).toBe("2026-10-21T10:05:00.000Z");
  });

  it("(c) carries the interest disclosure, resolved to a display name", () => {
    expect(draft.fieldDisclosures).toEqual([
      {
        uid: "uid_a",
        displayName: "Member A",
        motionId: "motion_1",
        description: "Supplier is a relative",
        relatedPartyName: "Acme Supplies",
      },
    ]);
  });

  it("(d) carries the exact motion texts", () => {
    expect(draft.fieldMotions.map((m) => m.text)).toEqual([
      "Approve the annual budget",
      "Elect the returning officer",
    ]);
  });

  it("(e/f) carries voting totals and both referenced consents", () => {
    expect(draft.fieldVoting[0]).toMatchObject({
      motionId: "motion_1",
      votesFor: 3,
      votesAgainst: 1,
      abstentions: 1,
      method: "electronic_poll",
      castingVoteUsed: false,
    });
    expect(draft.fieldConsents.map((c) => c.outcome)).toEqual([
      "granted",
      "refused",
    ]);
  });
});

describe("secret ballot in minutes (ws-a 3.6/3.7(e), test case 12)", () => {
  const draft = buildMinutesDraft(fixture);

  it("appears as TOTALS ONLY, ignoring stray per-voter data", () => {
    const row = draft.fieldVoting.find((v) => v.motionId === "motion_2")!;
    // Totals come from secretTotals (4/1/0), NOT from the stray ballot (against).
    expect(row).toEqual({
      motionId: "motion_2",
      votesFor: 4,
      votesAgainst: 1,
      abstentions: 0,
      method: "secret_ballot",
      castingVoteUsed: false,
      castingChoice: null,
    });
    // No per-voter keys anywhere on the row.
    expect(Object.keys(row).sort()).toEqual(
      [
        "abstentions",
        "castingChoice",
        "castingVoteUsed",
        "method",
        "motionId",
        "votesAgainst",
        "votesFor",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("uid_a");
    expect(JSON.stringify(row)).not.toContain("voterUid");
  });
});

describe("validateMinutesCompleteness", () => {
  const draft = buildMinutesDraft(fixture);

  it("flags a doc with a field removed", () => {
    const broken: Record<string, unknown> = { ...draft };
    delete broken.fieldConsents;
    const result = validateMinutesCompleteness(broken);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("fieldConsents");
  });

  it("flags removed sub-fields of attendees and quorum", () => {
    const broken = {
      ...draft,
      fieldAttendees: { present: draft.fieldAttendees.present },
      fieldQuorum: { ...draft.fieldQuorum, verifiedAt: null },
    };
    const result = validateMinutesCompleteness(broken);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("fieldAttendees.absent");
    expect(result.missing).toContain("fieldAttendees.electronic");
    expect(result.missing).toContain("fieldQuorum.verifiedAt");
  });

  it("flags a null minutes document as missing all six fields", () => {
    expect(validateMinutesCompleteness(null).missing).toEqual([
      ...MINUTES_SEC_3_5_FIELDS,
    ]);
  });
});

describe("casting vote separation (ws-a 3.6)", () => {
  it("counts the Founder casting ballot separately, not in the totals", () => {
    const draft = buildMinutesDraft({
      ...fixture,
      ballots: [
        { motionId: "motion_1", voterUid: "uid_a", choice: "for" },
        { motionId: "motion_1", voterUid: "uid_b", choice: "against" },
        { motionId: "motion_1", voterUid: "uid_founder", choice: "for", isCastingVote: true },
      ],
    });
    const row = draft.fieldVoting.find((v) => v.motionId === "motion_1")!;
    expect(row.votesFor).toBe(1);
    expect(row.votesAgainst).toBe(1);
    expect(row.castingVoteUsed).toBe(true);
    expect(row.castingChoice).toBe("for");
  });
});
