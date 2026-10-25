/**
 * @jest-environment node
 *
 * Flag-ON mocked-adapter tests for the G2 seam (motions-supa.ts):
 * - the full open -> secret-ballot -> close service flow runs over
 *   SupaMotionStore/SupaBallotStore with the G4 SupaDecisionsClient,
 *   proving frozen thresholds/snapshots round-trip through jsonb and
 *   secret choices are stored with NO voter linkage;
 * - the token issue log is deleted at close (H-8 loop-and-verify);
 * - H-09 SURVIVAL (plan §6.3): through the votes facade over a mocked
 *   adapter, an authenticated outsider can still open a vote with a
 *   body-supplied electorate and close/certify it — the hole is
 *   preserved, not fixed.
 */
jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

import { createFakeSupaAdapter } from "./fake-supa-adapter";
import { SupaMotionStore, SupaBallotStore } from "../motions-supa";
import { SupaDecisionsClient } from "../decisions-supa";
import { SupaFirestoreFacade } from "../supa-facade";
import {
  InMemoryAttendanceReader,
  InMemoryMeetingReader,
  ballotStoreFor,
  closeMotion,
  openMotion,
  type MeetingView,
  type MotionDeps,
} from "../motions";
import { InMemoryBallotStore, castSecretBallot, issueSecretToken } from "../ballots";
import { InMemoryDecisionsClient } from "../decisions-client";
import { InMemoryDecisionClassesReader, type ServerDecisionClassView } from "../decision-classes";
import { InMemoryBodyReader, InMemoryFilingTaskCreator, type BodyView } from "../shared";
import { closeVote, getVote, openVote } from "@/lib/server/governance-votes";

const T0 = new Date("2026-10-21T10:00:00Z");
const BOARD_9 = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];

const boardBody: BodyView = {
  id: "board_body", name: "Board of Governors", type: "board",
  chairUid: "g1", secretaryUid: "ngs_1", memberUids: [...BOARD_9],
  quorumOverride: null, chapterId: null,
};
const meeting: MeetingView = {
  id: "mtg_1", bodyId: "board_body", bodyType: "board", chairUid: "g1",
  secretaryUid: "ngs_1", status: "convened", quorumRequired: 5, quorumVerifiedAt: T0,
};
const ordinaryClass: ServerDecisionClassView = {
  id: "class_ordinary", label: "Ordinary", assignedBodyType: "board",
  majorityType: "ordinary_present_and_voting", numerator: null,
  denominatorKind: "present_and_voting", consentRequired: false,
  isReservedMatter: false, filingFlag: false, sourceRow: "4.3", enforcementMode: "enforce",
};

function makeDeps() {
  const adapter = createFakeSupaAdapter();
  const fsMotions = { nextId: () => "unused" } as never;
  const motions = new SupaMotionStore(adapter, fsMotions);
  const ballots = new SupaBallotStore(adapter, motions, new InMemoryBallotStore());
  const decisions = new SupaDecisionsClient(adapter, new InMemoryDecisionsClient() as never);
  const deps: MotionDeps = {
    motions, ballots,
    meetings: new InMemoryMeetingReader([{ ...meeting }]),
    attendance: new InMemoryAttendanceReader({ mtg_1: BOARD_9.slice(0, 5) }),
    bodies: new InMemoryBodyReader([boardBody]),
    classes: new InMemoryDecisionClassesReader([ordinaryClass]),
    decisions,
    filingTasks: new InMemoryFilingTaskCreator(),
    newId: () => motions.nextId(),
  };
  return { adapter, deps, motions, ballots, decisions };
}

describe("motions/ballots services over Supa stores (flag ON)", () => {
  it("secret-ballot close counts choices, stores NO uid in any choice doc, and deletes the issue log", async () => {
    const { adapter, deps, ballots } = makeDeps();
    const { motion } = await openMotion(deps, {
      meetingId: "mtg_1", actorUid: "g1", text: "Approve the budget",
      decisionClassId: "class_ordinary", proposerUid: "g2", at: T0, method: "secret_ballot",
    });
    // Frozen snapshot + threshold VALUES survived the jsonb round-trip
    // (the deep-freeze itself is an in-memory open-time property, on
    // both stores; the stored copy is what close evaluates against).
    const stored = await deps.motions.getMotion(motion.id);
    expect(stored?.denominatorSnapshot.presentCount).toBe(5);
    expect(stored?.threshold).toEqual(motion.threshold);

    const store = ballotStoreFor(deps.motions, ballots);
    for (const uid of ["g2", "g3", "g4"]) {
      const { token } = await issueSecretToken(store, { motionId: motion.id, uid });
      await castSecretBallot(store, { token, choice: uid === "g4" ? "against" : "for" });
    }
    expect(adapter.all(`motions/${motion.id}/tokenIssueLog`)).toHaveLength(3);

    const result = await closeMotion(deps, { motionId: motion.id, actorUid: "g1", at: T0 });
    expect(result.status).toBe("closed_passed");
    expect(result.result).toMatchObject({ votesFor: 2, votesAgainst: 1 });

    // Unlinkability: stored choice docs carry ONLY motionId/choice/castAt.
    const choices = adapter.all("secret_ballot_choices");
    expect(choices).toHaveLength(3);
    for (const c of choices) {
      expect(Object.keys(c.data).sort()).toEqual(["castAt", "choice", "motionId"]);
      expect(JSON.stringify(c.data)).not.toMatch(/g[234]/);
    }
    // H-8: the issue log is gone after close.
    expect(adapter.all(`motions/${motion.id}/tokenIssueLog`)).toHaveLength(0);
    // Register entry written through the G4 Supa client.
    expect(adapter.all("decisions")).toHaveLength(1);
    expect(adapter.all("decisions")[0].data.outcome).toBe("passed");
  });

  it("duplicate traceable cast is rejected via the seam's getBallot pre-check (not silently overwritten)", async () => {
    const { deps, ballots } = makeDeps();
    const { motion } = await openMotion(deps, {
      meetingId: "mtg_1", actorUid: "g1", text: "T", decisionClassId: "class_ordinary",
      proposerUid: "g2", at: T0,
    });
    const store = ballotStoreFor(deps.motions, ballots);
    const { castTraceableBallot } = await import("../ballots");
    await castTraceableBallot(store, { motionId: motion.id, voterUid: "g2", choice: "for" });
    await expect(
      castTraceableBallot(store, { motionId: motion.id, voterUid: "g2", choice: "against" }),
    ).rejects.toMatchObject({ code: "already_voted" });
  });
});

// H-09 (FOUNDER_ACCESS_MAP_2026-10-25): governance votes family has NO permission gate by faithful-migration design — any authenticated user can open a vote with a body-supplied electorate and closeVote performs no actor check. DO NOT add a gate in migration work; the fix is a separate, founder-decided change.
describe("H-09 survival through the votes facade (flag ON, mocked adapter)", () => {
  function votesDb() {
    const adapter = createFakeSupaAdapter();
    const db = new SupaFirestoreFacade(adapter, {
      allow: new Set(["governance_votes", "audit_logs"]),
    });
    return { adapter, db };
  }

  it("an outsider opens a vote over a self-supplied electorate and a second outsider closes/certifies it", async () => {
    const { adapter, db } = votesDb();
    const voteId = await openVote(db as never, {
      subjectType: "board_generic",
      electorate: [1, 2, 3].map((i) => ({
        seatKey: `seat-${i}`, roleKey: "governor", uid: `gov-${i}`, vacant: false,
      })),
      createdByUid: "random_member",
    });
    expect(typeof voteId).toBe("string");
    const { castVote } = await import("@/lib/server/governance-votes");
    await castVote(db as never, voteId, "gov-1", "for");
    await castVote(db as never, voteId, "gov-2", "for");
    const result = await closeVote(db as never, voteId, "total_outsider");
    expect(result.passed).toBe(true);
    const vote = await getVote(db as never, voteId);
    expect(vote.status).toBe("closed");
    expect(vote.closedByUid).toBe("total_outsider");
    expect(vote.ballotCount).toBe(2);
    // Audit rows were written through the facade (audit-or-throw held).
    expect(adapter.all("audit_logs").length).toBeGreaterThanOrEqual(2);
    // Idempotent close by yet another outsider: same certified result.
    const again = await closeVote(db as never, voteId, "outsider_b");
    expect(again).toEqual(result);
  });

  it("repeat cast through the facade transaction OVERWRITES (one ballot per voter, structural)", async () => {
    const { db } = votesDb();
    const voteId = await openVote(db as never, {
      subjectType: "board_generic",
      electorate: [1, 2, 3].map((i) => ({
        seatKey: `seat-${i}`, roleKey: "governor", uid: `gov-${i}`, vacant: false,
      })),
      createdByUid: "gov-1",
    });
    const { castVote } = await import("@/lib/server/governance-votes");
    await castVote(db as never, voteId, "gov-1", "against");
    await castVote(db as never, voteId, "gov-1", "for");
    const vote = await getVote(db as never, voteId);
    expect(vote.ballotCount).toBe(1);
    const result = await closeVote(db as never, voteId, "gov-1");
    expect(result.votesFor).toBe(1);
    expect(result.votesAgainst).toBe(0);
  });
});
