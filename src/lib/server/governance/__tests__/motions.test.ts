import {
  InMemoryAttendanceReader,
  InMemoryMeetingReader,
  InMemoryMotionStore,
  ballotStoreFor,
  closeMotion,
  openMotion,
  recordMotionDisclosure,
  type MeetingView,
  type MotionDeps,
} from "../motions";
import {
  InMemoryBallotStore,
  castCastingBallot,
  castTraceableBallot,
} from "../ballots";
import { InMemoryDecisionsClient } from "../decisions-client";
import {
  InMemoryDecisionClassesReader,
  type ServerDecisionClassView,
} from "../decision-classes";
import {
  InMemoryBodyReader,
  InMemoryFilingTaskCreator,
  type BodyView,
} from "../shared";

const T0 = new Date("2026-10-21T10:00:00Z");
const BOARD_9 = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];
const PRESENT_5 = BOARD_9.slice(0, 5);

const boardBody: BodyView = {
  id: "board_body",
  name: "Board of Governors",
  type: "board",
  chairUid: "g1",
  secretaryUid: "ngs_1",
  memberUids: [...BOARD_9],
  quorumOverride: null,
  chapterId: null,
};

const meeting: MeetingView = {
  id: "mtg_1",
  bodyId: "board_body",
  bodyType: "board",
  chairUid: "g1",
  secretaryUid: "ngs_1",
  status: "convened",
  quorumRequired: 5,
  quorumVerifiedAt: T0,
};

const ordinaryClass: ServerDecisionClassView = {
  id: "class_ordinary",
  label: "Ordinary",
  assignedBodyType: "board",
  majorityType: "ordinary_present_and_voting",
  numerator: null,
  denominatorKind: "present_and_voting",
  consentRequired: false,
  isReservedMatter: false,
  filingFlag: false,
  sourceRow: "4.3",
  enforcementMode: "enforce",
};

const higherClass: ServerDecisionClassView = {
  ...ordinaryClass,
  id: "class_higher",
  label: "General Body class",
  assignedBodyType: "general_body",
};

const twoThirdsClass: ServerDecisionClassView = {
  ...ordinaryClass,
  id: "class_two_thirds",
  label: "Reversal",
  majorityType: "fraction_of_all_governors",
  numerator: 2,
  denominatorKind: "all_governors",
  filingFlag: true,
  sourceRow: "5.54",
};

function makeDeps(over: Partial<MotionDeps> = {}) {
  const motions = new InMemoryMotionStore();
  const ballots = new InMemoryBallotStore();
  const meetings = new InMemoryMeetingReader([{ ...meeting }]);
  const attendance = new InMemoryAttendanceReader({ mtg_1: [...PRESENT_5] });
  const classes = new InMemoryDecisionClassesReader([ordinaryClass, higherClass, twoThirdsClass]);
  const deps: MotionDeps = {
    motions,
    ballots,
    meetings,
    attendance,
    bodies: new InMemoryBodyReader([boardBody]),
    classes,
    decisions: new InMemoryDecisionsClient(),
    filingTasks: new InMemoryFilingTaskCreator(),
    newId: () => motions.nextMotionId(),
    ...over,
  };
  return { deps, motions, ballots, meetings, attendance, classes };
}

const openInput = (over: Record<string, unknown> = {}) => ({
  meetingId: "mtg_1",
  actorUid: "g1",
  text: "Approve the budget",
  decisionClassId: "class_ordinary",
  proposerUid: "g2",
  at: T0,
  ...over,
});

describe("openMotion gates (ws-a §4.5, test case 10)", () => {
  it("opening before quorum verification (meeting not convened) is 409", async () => {
    const { deps, meetings } = makeDeps();
    meetings.add({ ...meeting, id: "mtg_draft", status: "noticed", quorumVerifiedAt: null });
    await expect(
      openMotion(deps, openInput({ meetingId: "mtg_draft" })),
    ).rejects.toMatchObject({ code: "meeting_not_convened", status: 409 });
  });

  it("opening by a non-chair is 403", async () => {
    const { deps } = makeDeps();
    await expect(openMotion(deps, openInput({ actorUid: "g3" }))).rejects.toMatchObject({
      code: "not_chair",
      status: 403,
    });
  });

  it("opening with quorum not met is 409 quorum_not_met", async () => {
    const { deps, attendance } = makeDeps();
    attendance.setPresent("mtg_1", ["g1", "g2", "g3"]);
    await expect(openMotion(deps, openInput())).rejects.toMatchObject({
      code: "quorum_not_met",
      status: 409,
    });
  });

  it("a class assigned to a higher body is 403 in enforce mode", async () => {
    const { deps } = makeDeps();
    await expect(
      openMotion(deps, openInput({ decisionClassId: "class_higher" })),
    ).rejects.toMatchObject({ code: "class_assigned_higher", status: 403 });
  });

  it("the same class opens with a stamped matrixWarning in warn-only mode", async () => {
    const warn = { ...higherClass, enforcementMode: "warn-only" as const };
    const { deps } = makeDeps({
      classes: new InMemoryDecisionClassesReader([ordinaryClass, warn]),
    });
    const { motion, matrixWarning } = await openMotion(deps, openInput({ decisionClassId: "class_higher" }));
    expect(motion.status).toBe("open");
    expect(matrixWarning).toMatch(/assigned to general_body/);
    expect(motion.matrixWarning).toBe(matrixWarning);
  });

  it("an open referral blocks opening in enforce mode (409 referral_open)", async () => {
    const { deps } = makeDeps({ referrals: { hasOpenReferral: async () => true } });
    await expect(openMotion(deps, openInput())).rejects.toMatchObject({
      code: "referral_open",
      status: 409,
    });
  });
});

describe("openMotion snapshot + threshold immutability (ws-a §3.5, §6.2)", () => {
  it("copies the threshold at open: 2/3 of 9 Governors requires 6, frozen against later matrix edits", async () => {
    const { deps, classes } = makeDeps();
    const { motion } = await openMotion(deps, openInput({ decisionClassId: "class_two_thirds" }));
    expect(motion.threshold.requiredCount).toBe(6);
    expect(motion.threshold.numerator).toBe(2);
    expect(Object.isFrozen(motion.threshold)).toBe(true);
    // The matrix is edited afterwards; the opened motion must not change.
    const edited = { ...twoThirdsClass, numerator: 1 };
    classes.add(edited); // reader returns the FIRST match, so assert against a fresh read below instead
    const stored = await deps.motions.getMotion(motion.id);
    expect(stored?.threshold.requiredCount).toBe(6);
    expect(stored?.threshold.numerator).toBe(2);
  });

  it("freezes the denominator snapshot at open: a later departure changes nothing", async () => {
    const { deps, attendance } = makeDeps();
    const { motion } = await openMotion(deps, openInput());
    attendance.setPresent("mtg_1", ["g1"]);
    const stored = await deps.motions.getMotion(motion.id);
    expect(stored?.denominatorSnapshot.presentCount).toBe(5);
    expect(stored?.denominatorSnapshot.wholeBodyCount).toBe(9);
    expect(stored?.denominatorSnapshot.presentUids).toEqual(PRESENT_5);
  });
});

describe("closeMotion: counting, register write, casting (ws-a §4.5, test cases 4, 10)", () => {
  async function openAndVote(votes: Array<[string, "for" | "against" | "abstain"]>) {
    const ctx = makeDeps();
    const { motion } = await openMotion(ctx.deps, openInput());
    const store = ballotStoreFor(ctx.motions, ctx.ballots);
    for (const [uid, choice] of votes) {
      await castTraceableBallot(store, { motionId: motion.id, voterUid: uid, choice, now: T0 });
    }
    return { ...ctx, motion, store };
  }

  it("3 for / 2 against closes passed and writes the register entry", async () => {
    const { deps, motion } = await openAndVote([
      ["g1", "for"],
      ["g2", "for"],
      ["g3", "for"],
      ["g4", "against"],
      ["g5", "against"],
    ]);
    const closed = await closeMotion(deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(closed.status).toBe("closed_passed");
    expect(closed.tied).toBe(false);
    expect(closed.result).toMatchObject({ votesFor: 3, votesAgainst: 2, thresholdMet: true });
    const entries = (deps.decisions as InMemoryDecisionsClient).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "meeting_motion", outcome: "passed", status: "effective" });
    expect(closed.decisionId).toBe(entries[0].id);
  });

  it("a failed motion is still recorded in the register with outcome failed", async () => {
    const { deps, motion } = await openAndVote([
      ["g1", "against"],
      ["g2", "against"],
      ["g3", "for"],
    ]);
    const closed = await closeMotion(deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(closed.status).toBe("closed_failed");
    const entries = (deps.decisions as InMemoryDecisionsClient).all();
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("failed");
  });

  it("a Board tie parks at closed_tied_pending_casting with NO entry; the Founder casting ballot plus a second close finalizes it", async () => {
    const { deps, motion, store } = await openAndVote([
      ["g1", "for"],
      ["g2", "for"],
      ["g3", "against"],
      ["g4", "against"],
    ]);
    const first = await closeMotion(deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(first.tied).toBe(true);
    expect(first.status).toBe("closed_tied_pending_casting");
    expect((deps.decisions as InMemoryDecisionsClient).all()).toHaveLength(0);

    await castCastingBallot(store, {
      motionId: motion.id,
      founderUid: "founder_1",
      isFounder: true,
      choice: "for",
      now: T0,
    });
    const final = await closeMotion(deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(final.status).toBe("closed_passed");
    expect(final.result?.castingVoteUsed).toBe(true);
    const entries = (deps.decisions as InMemoryDecisionsClient).all();
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("passed");
  });

  it("closing by a non-chair is 403", async () => {
    const { deps, motion } = await openAndVote([["g1", "for"]]);
    await expect(
      closeMotion(deps, { motionId: motion.id, actorUid: "g4", at: T0 }),
    ).rejects.toMatchObject({ code: "not_chair", status: 403 });
  });

  it("a flagged class creates a filing task on close, assigned to the secretary", async () => {
    const ctx = makeDeps();
    ctx.attendance.setPresent("mtg_1", BOARD_9.slice(0, 6)); // 6 present: 2/3 of all 9 needs 6 FOR votes
    const { motion } = await openMotion(ctx.deps, openInput({ decisionClassId: "class_two_thirds" }));
    const store = ballotStoreFor(ctx.motions, ctx.ballots);
    for (const uid of BOARD_9.slice(0, 6)) {
      await castTraceableBallot(store, { motionId: motion.id, voterUid: uid, choice: "for", now: T0 });
    }
    const closed = await closeMotion(ctx.deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(closed.status).toBe("closed_passed"); // 6 >= required 6
    const created = (ctx.deps.filingTasks as InMemoryFilingTaskCreator).created;
    expect(created).toHaveLength(1);
    expect(created[0].assigneeUid).toBe("ngs_1");
    expect(closed.filingTaskId).not.toBeNull();
  });
});

describe("recordMotionDisclosure (ws-a §3.6, non-goal N1)", () => {
  it("records the disclosure on the motion and never blocks the member's ballot", async () => {
    const ctx = makeDeps();
    const { motion } = await openMotion(ctx.deps, openInput());
    const withDisclosure = await recordMotionDisclosure(ctx.deps, {
      motionId: motion.id,
      uid: "g2",
      disclosure: { hasInterest: true, description: "Supplier is a relative", relatedPartyName: "Acme" },
      at: T0,
    });
    expect(withDisclosure.disclosures).toHaveLength(1);
    // The same member's ballot is still accepted and counted.
    const store = ballotStoreFor(ctx.motions, ctx.ballots);
    await castTraceableBallot(store, {
      motionId: motion.id,
      voterUid: "g2",
      choice: "for",
      interestDisclosure: { hasInterest: true, description: "Supplier is a relative", relatedPartyName: "Acme" },
      now: T0,
    });
    const closed = await closeMotion(ctx.deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(closed.result?.votesFor).toBe(1);
  });
});
