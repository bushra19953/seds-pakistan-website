/**
 * Motion lifecycle tests (ws-a §3.5, §6.2): valid/invalid transitions and
 * the immutability guard for motion patches.
 */
import {
  canTransitionMotion,
  assertMotionTransition,
  isTerminalMotionStatus,
  guardMotionPatch,
  MotionError,
} from "../motions-lifecycle";

describe("motion lifecycle transitions", () => {
  it("allows open -> paused_quorum_lost -> open (quorum lost and regained)", () => {
    expect(canTransitionMotion("open", "paused_quorum_lost")).toBe(true);
    expect(canTransitionMotion("paused_quorum_lost", "open")).toBe(true);
  });

  it("allows open -> each closed outcome", () => {
    expect(canTransitionMotion("open", "closed_passed")).toBe(true);
    expect(canTransitionMotion("open", "closed_failed")).toBe(true);
    expect(canTransitionMotion("open", "closed_tied_pending_casting")).toBe(true);
  });

  it("allows the tied state to resolve via a casting ballot only", () => {
    expect(canTransitionMotion("closed_tied_pending_casting", "closed_passed")).toBe(true);
    expect(canTransitionMotion("closed_tied_pending_casting", "closed_failed")).toBe(true);
    expect(canTransitionMotion("closed_tied_pending_casting", "open")).toBe(false);
    expect(canTransitionMotion("closed_tied_pending_casting", "withdrawn")).toBe(false);
  });

  it("allows withdrawal only before close", () => {
    expect(canTransitionMotion("open", "withdrawn")).toBe(true);
    expect(canTransitionMotion("paused_quorum_lost", "withdrawn")).toBe(true);
    expect(canTransitionMotion("closed_passed", "withdrawn")).toBe(false);
  });

  it("treats closed_passed, closed_failed and withdrawn as terminal", () => {
    for (const s of ["closed_passed", "closed_failed", "withdrawn"] as const) {
      expect(isTerminalMotionStatus(s)).toBe(true);
      expect(canTransitionMotion(s, "open")).toBe(false);
    }
    expect(isTerminalMotionStatus("open")).toBe(false);
    expect(isTerminalMotionStatus("closed_tied_pending_casting")).toBe(false);
  });

  it("rejects closing a paused motion directly (must resume first)", () => {
    expect(canTransitionMotion("paused_quorum_lost", "closed_passed")).toBe(false);
    expect(() => assertMotionTransition("paused_quorum_lost", "closed_passed")).toThrow(MotionError);
  });

  it("rejects reopening a closed motion", () => {
    try {
      assertMotionTransition("closed_failed", "open");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MotionError);
      expect((e as MotionError).code).toBe("invalid_motion_transition");
      expect((e as MotionError).status).toBe(409);
    }
  });
});

describe("guardMotionPatch (threshold immutability enforcement)", () => {
  it("rejects any patch carrying a threshold, with the dedicated code", () => {
    const patch = {
      threshold: {
        majorityType: "ordinary_present_and_voting",
        numerator: null,
        fractionDenominator: null,
        denominatorKind: "present_and_voting",
        requiredCount: null,
        consentRequired: false,
        isReservedMatter: false,
        filingFlag: false,
      },
    };
    try {
      guardMotionPatch(patch);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MotionError).code).toBe("threshold_immutable");
    }
  });

  it("rejects patches to decisionClassId and denominatorSnapshot", () => {
    expect(() => guardMotionPatch({ decisionClassId: "other" })).toThrow(/immutable_field|decisionClassId/);
    expect(() => guardMotionPatch({ denominatorSnapshot: {} })).toThrow(MotionError);
  });

  it("allows ordinary lifecycle patches (status, result, decisionId, disclosures)", () => {
    expect(() =>
      guardMotionPatch({ status: "closed_passed", result: null, decisionId: "d1", disclosures: [] }),
    ).not.toThrow();
  });
});
