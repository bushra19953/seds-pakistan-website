import {
  DecisionsError,
  InMemoryDecisionsClient,
  buildDecisionEntry,
  type DecisionEntryInput,
} from "../decisions-client";
import {
  InMemoryConsentsClient,
  isDecidedConsentStatus,
  type ConsentView,
} from "../consents-client";
import {
  InMemoryDecisionClassesReader,
  localMatrixDecisionClassesReader,
  type ServerDecisionClassView,
} from "../decision-classes";

const T0 = new Date("2026-10-21T10:00:00Z");

const validInput = (over: Partial<DecisionEntryInput> = {}): DecisionEntryInput => ({
  bodyId: "board_body",
  decisionClassId: "class_board_ordinary",
  source: "meeting_motion",
  sourceId: "motion_1",
  text: "Approve the minutes",
  outcome: "passed",
  votingSummary: {
    votesFor: 5,
    votesAgainst: 2,
    abstentions: 1,
    denominator: 8,
    thresholdApplied: { majorityType: "ordinary_present_and_voting" },
  },
  consentId: null,
  decidedAt: T0,
  effectiveAt: T0,
  status: "effective",
  supersedesDecisionId: null,
  retentionUntil: new Date("2036-10-21T10:00:00Z"),
  ...over,
});

describe("decisions-client: buildDecisionEntry (ws-a §3.9)", () => {
  it("builds a stored entry from a valid input and stamps the register id", () => {
    const entry = buildDecisionEntry(validInput(), "decision_1");
    expect(entry.id).toBe("decision_1");
    expect(entry.bodyId).toBe("board_body");
    expect(entry.status).toBe("effective");
    expect(entry.voidedAt).toBeNull();
    expect(entry.ratifiedAt).toBeNull();
  });

  it("rejects an entry missing a required string field", () => {
    expect(() => buildDecisionEntry(validInput({ text: "" }), "d1")).toThrow(DecisionsError);
    expect(() => buildDecisionEntry(validInput({ text: "" }), "d1")).toThrow(/missing required field: text/);
  });

  it("rejects an entry with an incomplete voting summary", () => {
    const bad = validInput({
      votingSummary: { votesFor: 1 } as DecisionEntryInput["votingSummary"],
    });
    expect(() => buildDecisionEntry(bad, "d1")).toThrow(/votingSummary is incomplete/);
  });

  it("rejects an entry whose dates are not Dates", () => {
    const bad = validInput({ decidedAt: "2026-10-21" as unknown as Date });
    expect(() => buildDecisionEntry(bad, "d1")).toThrow(/must be Dates/);
  });
});

describe("decisions-client: append-only writes and owned transitions", () => {
  it("writeDecision appends; a second write never overwrites the first", async () => {
    const client = new InMemoryDecisionsClient();
    const a = await client.writeDecision(validInput());
    const b = await client.writeDecision(validInput({ text: "Second decision" }));
    expect(a.id).not.toBe(b.id);
    expect(client.all()).toHaveLength(2);
    expect((await client.getDecision(a.id))?.text).toBe("Approve the minutes");
  });

  it("pending_ratification -> ratified is owned and stamps ratifiedAt", async () => {
    const client = new InMemoryDecisionsClient();
    const entry = await client.writeDecision(
      validInput({ source: "urgent", status: "pending_ratification", outcome: "effective" }),
    );
    const ratified = await client.transitionDecisionStatus(entry.id, "ratified", { ratifiedAt: T0 });
    expect(ratified.status).toBe("ratified");
    expect(ratified.ratifiedAt).toEqual(T0);
  });

  it("pending_ratification -> void is owned and carries the retroactive payload", async () => {
    const client = new InMemoryDecisionsClient();
    const entry = await client.writeDecision(
      validInput({ source: "urgent", status: "pending_ratification", outcome: "effective" }),
    );
    const voidedAt = new Date("2026-11-20T10:00:00Z");
    const voided = await client.transitionDecisionStatus(entry.id, "void", {
      voidedAt,
      voidEffectiveFrom: T0,
    });
    expect(voided.status).toBe("void");
    expect(voided.voidedAt).toEqual(voidedAt);
    // Retroactive: effective from the original decision time, not the void time.
    expect(voided.voidEffectiveFrom).toEqual(T0);
  });

  it("any other transition is refused as not owned (append-only register)", async () => {
    const client = new InMemoryDecisionsClient();
    const entry = await client.writeDecision(validInput({ status: "effective" }));
    await expect(client.transitionDecisionStatus(entry.id, "ratified")).rejects.toThrow(
      /decision_transition_not_owned|Workstream A cannot move/,
    );
    await expect(client.transitionDecisionStatus(entry.id, "superseded")).rejects.toThrow(
      DecisionsError,
    );
    // Status untouched by the refused attempts.
    expect((await client.getDecision(entry.id))?.status).toBe("effective");
  });

  it("transition on an unknown id is a 404", async () => {
    const client = new InMemoryDecisionsClient();
    await expect(client.transitionDecisionStatus("nope", "ratified")).rejects.toThrow(/404|No decisions entry/);
  });
});

describe("consents-client: decided test (ws-a §3.9)", () => {
  it("only granted and conditional count as decided", () => {
    expect(isDecidedConsentStatus("granted")).toBe(true);
    expect(isDecidedConsentStatus("conditional")).toBe(true);
    expect(isDecidedConsentStatus("pending")).toBe(false);
    expect(isDecidedConsentStatus("refused")).toBe(false);
    expect(isDecidedConsentStatus("expired")).toBe(false);
  });

  it("isDecidedConsent is false for a missing consent", async () => {
    const client = new InMemoryConsentsClient();
    await expect(client.isDecidedConsent("absent")).resolves.toBe(false);
  });

  it("listConsentsForMeeting returns only consents linked to that meeting", async () => {
    const base: ConsentView = {
      id: "c1",
      status: "granted",
      matter: "Emergency meeting",
      proposedAct: "Convene",
      decidedAt: T0,
      decidedBy: "founder",
      meetingId: "mtg_1",
    };
    const client = new InMemoryConsentsClient([
      base,
      { ...base, id: "c2", meetingId: "mtg_2" },
      { ...base, id: "c3", meetingId: null },
    ]);
    const forMtg1 = await client.listConsentsForMeeting("mtg_1");
    expect(forMtg1.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("decision-classes reader (ws-a §3.9 consumed matrix)", () => {
  it("local matrix ADAPTER resolves a known class with warn-only default", async () => {
    const reader = localMatrixDecisionClassesReader();
    const cls = await reader.getClass("class_board_ordinary");
    expect(cls).not.toBeNull();
    expect(cls?.enforcementMode).toBe("warn-only");
    expect(cls?.consentRequired).toBe(true);
  });

  it("unknown class id resolves to null, never a fabricated class", async () => {
    const reader = localMatrixDecisionClassesReader();
    await expect(reader.getClass("class_does_not_exist")).resolves.toBeNull();
  });

  it("in-memory reader returns injected classes and honours enforce mode", async () => {
    const cls: ServerDecisionClassView = {
      id: "class_x",
      label: "X",
      assignedBodyType: "board",
      majorityType: "ordinary_present_and_voting",
      numerator: null,
      denominatorKind: "present_and_voting",
      consentRequired: false,
      isReservedMatter: true,
      filingFlag: false,
      sourceRow: "5.1",
      enforcementMode: "enforce",
    };
    const reader = new InMemoryDecisionClassesReader([cls]);
    expect((await reader.getClass("class_x"))?.isReservedMatter).toBe(true);
    expect((await reader.listClasses()).map((c) => c.id)).toEqual(["class_x"]);
  });
});
