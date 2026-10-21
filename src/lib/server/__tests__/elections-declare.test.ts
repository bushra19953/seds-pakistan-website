/**
 * Declaration suite (spec Section 7, tests 20-22).
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

// jsPDF's dist pulls ESM dependencies that this repo's jest config
// does not transform, so PDF rendering is stubbed in this suite (the
// certificate module's payload/signature logic has its own suite).
// Declaration logic - the subject here - is unaffected.
jest.mock("@/lib/election-certificate-pdf", () => ({
  buildElectionCertificatePdf: async () => {
    const { createHash } = require("crypto");
    const pdfBytes = new Uint8Array(Buffer.from("%PDF-stub-certificate"));
    return {
      pdfBytes,
      signature: "stub-signature",
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
    };
  },
}));

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-declare-suite-0123456789";
process.env.CERTIFICATE_SALT = "test-certificate-salt-for-elections";

import { createFakeDb, setFakeNow } from "./helpers/fake-firestore";
import {
  createDefaultPorts,
  type ElectionPorts,
  type FullMemberRecord,
} from "../election-ports";
import { createElection, publishTimetable, transitionElection } from "../elections";
import { buildRoll, freezeRoll } from "../election-roll";
import { submitNomination, decideNomination, certifyCandidates } from "../election-nominations";
import { issueBallotToken, castBallot } from "../election-ballot";
import {
  appointTeller,
  registerObserver,
  openCount,
  signOffCount,
  recordTieLot,
  declareResult,
  retryGovernorWriteback,
} from "../election-count";
import { millisOf } from "../election-db";

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const DAY = Date.UTC(2026, 11, 31);
const T_CREATE = Date.UTC(2026, 10, 1);
const T_SUBMIT = Date.UTC(2026, 11, 15);
const T_CLOSE_NOM = Date.UTC(2026, 11, 25);
const T_POLL = Date.UTC(2026, 11, 31, 10, 0);
const T_POLL_CLOSED = Date.UTC(2026, 11, 31, 17, 30);
const T_SIGN = Date.UTC(2026, 11, 31, 19, 0);
const T_DECLARE = Date.UTC(2026, 11, 31, 20, 0);

function member(uid: string): FullMemberRecord {
  return {
    uid,
    displayName: `Member ${uid}`,
    chapterId: "ist",
    membershipClass: "full_member",
    fullMemberSinceMillis: Date.UTC(2025, 0, 1),
    registerEntryDateMillis: Date.UTC(2025, 0, 1),
    duesYear: "2026-27",
  };
}

const MEMBER_UIDS = [
  "cand", "cand2", "cand3", "n1", "n2",
  "v1", "v2", "v3", "v4", "v5", "v6", "v7", RO,
];
const MEMBERS = MEMBER_UIDS.map(member);

async function setup(boardOverride?: ElectionPorts["board"]) {
  const db = createFakeDb();
  setFakeNow(T_CREATE);
  await db.collection("roles").doc(RO).set({ role: "returning_officer" });
  const ports: ElectionPorts = {
    ...createDefaultPorts(db),
    fullMembers: {
      listFullMembers: async () => MEMBERS,
      getFullMember: async (uid) => MEMBERS.find((m) => m.uid === uid) ?? null,
      isFullMember: async (uid) => MEMBERS.some((m) => m.uid === uid),
    },
  };
  if (boardOverride) ports.board = boardOverride;

  const election = await createElection(
    db, ports,
    {
      actorUid: FOUNDER, actorIsFounder: true,
      title: "Member Governor Election 2026",
      electionDayMillis: DAY,
      returningOfficerUid: RO, returningOfficerName: "R Officer",
    },
    T_CREATE,
  );
  const electionId = election.id;
  await publishTimetable(db, electionId, RO, {}, T_CREATE);
  await buildRoll(db, ports, electionId, RO, T_CREATE);
  await freezeRoll(db, electionId, RO, T_CREATE);
  await transitionElection(db, electionId, RO, "open_nominations", {}, T_CREATE);
  for (const cand of ["cand", "cand2", "cand3"]) {
    const n = await submitNomination(
      db, ports, electionId,
      {
        submitterUid: "n1", candidateUid: cand, candidateName: `Candidate ${cand}`,
        nominatorUids: ["n1", "n2"], candidateStatement: "Statement.",
        consent: { driveFileId: `file-${cand}`, driveLink: "", fileName: "consent.pdf", sha256: "d".repeat(64), uploadedByUid: cand },
        campaignCodeAccepted: true,
      },
      T_SUBMIT,
    );
    await decideNomination(db, electionId, n.id, RO, "accepted", null, T_SUBMIT);
  }
  await transitionElection(db, electionId, RO, "close_nominations", {}, T_CLOSE_NOM);
  await certifyCandidates(db, ports, electionId, RO, T_CLOSE_NOM);
  await registerObserver(db, electionId, "cand3", { uid: "obs1", name: "Observer One", forCandidateUid: "cand3" }, T_CLOSE_NOM);
  await transitionElection(db, electionId, RO, "open_poll", {}, T_POLL);

  // Votes: cand 3, cand2 2, cand3 2 -> tie at the second-seat cutoff.
  const casts: Array<[string, string[]]> = [
    ["v1", ["cand"]], ["v2", ["cand"]], ["v3", ["cand"]],
    ["v4", ["cand2"]], ["v5", ["cand2"]],
    ["v6", ["cand3"]], ["v7", ["cand3"]],
  ];
  for (const [uid, choices] of casts) {
    const { token } = await issueBallotToken(db, electionId, uid, {}, T_POLL);
    await castBallot(db, electionId, { uid, token, choices }, T_POLL);
  }
  await transitionElection(db, electionId, RO, "close_poll", {}, T_POLL_CLOSED);
  await appointTeller(db, electionId, RO, { uid: "t1", name: "Teller One" }, T_POLL_CLOSED);
  await appointTeller(db, electionId, RO, { uid: "t2", name: "Teller Two" }, T_POLL_CLOSED);
  return { db, ports, electionId };
}

async function countAndSignOff(db: ReturnType<typeof createFakeDb>, electionId: string) {
  const record = await openCount(db, electionId, RO, T_POLL_CLOSED);
  await signOffCount(db, electionId, RO, T_SIGN);
  await signOffCount(db, electionId, "t1", T_SIGN);
  const signed = await signOffCount(db, electionId, "t2", T_SIGN);
  return { record, signed };
}

describe("election declaration", () => {
  it("20. declaration is blocked while a cutoff tie has no tie_lots record, and succeeds after one is recorded with witnesses present", async () => {
    const { db, ports, electionId } = await setup();
    const { record } = await countAndSignOff(db, electionId);
    expect(record.cutoffTie).toEqual({
      tiedCandidateUids: ["cand2", "cand3"],
      votesEach: 2,
      seatsContested: 1,
    });

    await expect(declareResult(db, ports, electionId, RO, {}, T_DECLARE)).rejects.toMatchObject({
      code: "tie_unresolved",
    });

    // Presence incomplete (cand2 not confirmed) -> record refused.
    await expect(
      recordTieLot(db, electionId, RO, {
        method: "sealed tokens drawn from an opaque container",
        witnesses: [
          { uid: "obs1", name: "Observer One", capacity: "observer", presenceConfirmed: true },
        ],
        outcomeWinningCandidateUid: "cand3",
        drawnAtMillis: T_DECLARE,
        evidence: null,
      }, T_DECLARE),
    ).rejects.toMatchObject({ code: "lot_presence_unconfirmed" });

    await recordTieLot(db, electionId, RO, {
      method: "sealed tokens drawn from an opaque container",
      witnesses: [
        { uid: "cand2", name: "Candidate cand2", capacity: "candidate", presenceConfirmed: true },
        { uid: "obs1", name: "Observer One", capacity: "observer", presenceConfirmed: true },
      ],
      outcomeWinningCandidateUid: "cand3",
      drawnAtMillis: T_DECLARE,
      evidence: null,
    }, T_DECLARE);

    const result = await declareResult(db, ports, electionId, RO, {}, T_DECLARE);
    expect(result.elected.map((e) => e.candidateUid)).toEqual(["cand", "cand3"]);
    expect(result.tieLotId).toBeTruthy();
  });

  it("21. declaration writes the result, calls the Board port once per elected Governor, and marks a port failure as failed (not silent) with a working retry", async () => {
    const calls: string[] = [];
    const db0 = createFakeDb();
    void db0;
    const board: ElectionPorts["board"] = {
      readSeatsDue: async () => ({ seatsDue: true }),
      writeMemberGovernor: async (input) => {
        calls.push(input.candidateUid);
        return { governorId: `gov-${input.candidateUid}`, termEndMillis: null };
      },
    };
    const ok = await setup(board);
    await countAndSignOff(ok.db, ok.electionId);
    // Resolve the tie first (cand2 wins the lot in this run).
    await recordTieLot(ok.db, ok.electionId, RO, {
      method: "sealed tokens drawn from an opaque container",
      witnesses: [
        { uid: "cand2", name: "Candidate cand2", capacity: "candidate", presenceConfirmed: true },
        { uid: "obs1", name: "Observer One", capacity: "observer", presenceConfirmed: true },
      ],
      outcomeWinningCandidateUid: "cand2",
      drawnAtMillis: T_DECLARE,
      evidence: null,
    }, T_DECLARE);
    const result = await declareResult(ok.db, ok.ports, ok.electionId, RO, {}, T_DECLARE);
    expect(calls.sort()).toEqual(["cand", "cand2"]);
    expect(result.governorRegisterWriteback.status).toBe("written");
    expect(result.governorRegisterWriteback.governorIds.sort()).toEqual(["gov-cand", "gov-cand2"]);

    // Failing port: declaration stands, writeback is marked failed.
    const failing: ElectionPorts["board"] = {
      readSeatsDue: async () => ({ seatsDue: true }),
      writeMemberGovernor: async () => {
        throw new Error("board module unavailable");
      },
    };
    const bad = await setup(failing);
    await countAndSignOff(bad.db, bad.electionId);
    await recordTieLot(bad.db, bad.electionId, RO, {
      method: "sealed tokens drawn from an opaque container",
      witnesses: [
        { uid: "cand2", name: "Candidate cand2", capacity: "candidate", presenceConfirmed: true },
        { uid: "obs1", name: "Observer One", capacity: "observer", presenceConfirmed: true },
      ],
      outcomeWinningCandidateUid: "cand2",
      drawnAtMillis: T_DECLARE,
      evidence: null,
    }, T_DECLARE);
    const failedResult = await declareResult(bad.db, bad.ports, bad.electionId, RO, {}, T_DECLARE);
    expect(failedResult.governorRegisterWriteback.status).toBe("failed");
    expect(failedResult.governorRegisterWriteback.error).toContain("board module unavailable");

    // Retry with a working port completes the writeback.
    bad.ports.board = board;
    const retried = await retryGovernorWriteback(bad.db, bad.ports, bad.electionId, RO, T_DECLARE);
    expect(retried.governorRegisterWriteback.status).toBe("written");
  });

  it("22. certificate delivery deadline is count end plus 24 hours and the RO term end is stamped at declaration", async () => {
    const { db, ports, electionId } = await setup();
    await countAndSignOff(db, electionId);
    await recordTieLot(db, electionId, RO, {
      method: "sealed tokens drawn from an opaque container",
      witnesses: [
        { uid: "cand2", name: "Candidate cand2", capacity: "candidate", presenceConfirmed: true },
        { uid: "obs1", name: "Observer One", capacity: "observer", presenceConfirmed: true },
      ],
      outcomeWinningCandidateUid: "cand2",
      drawnAtMillis: T_DECLARE,
      evidence: null,
    }, T_DECLARE);
    const result = await declareResult(db, ports, electionId, RO, {}, T_DECLARE);

    expect(millisOf(result.certificate.deliveryDeadlineAt)).toBe(T_SIGN + 24 * 60 * 60 * 1000);
    expect(result.certificate.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.certificate.deliveredTo).toEqual([
      "national_general_secretary",
      "board_of_governors",
      "founder",
    ]);

    const electionSnap = await db.collection("elections").doc(electionId).get();
    const election = electionSnap.data();
    expect(election.status).toBe("declared");
    expect(millisOf(election.roTermEndsAt)).toBe(T_DECLARE);
    expect(millisOf(election.timetable.challengeWindowClosesAt)).toBe(
      T_DECLARE + 7 * 24 * 60 * 60 * 1000,
    );
  });
});
