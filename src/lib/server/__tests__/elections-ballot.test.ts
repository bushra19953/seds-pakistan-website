/**
 * Ballot suite (spec Section 7, tests 11A, 17A, 18A, 19).
 * (A) = anonymity cases, release-blocking.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-ballot-suite-0123456789";

import { createFakeDb, setFakeNow, FakeTimestamp } from "./helpers/fake-firestore";
import {
  createDefaultPorts,
  type ElectionPorts,
  type FullMemberRecord,
} from "../election-ports";
import { createElection, publishTimetable, transitionElection } from "../elections";
import { buildRoll, freezeRoll } from "../election-roll";
import { submitNomination, decideNomination, certifyCandidates } from "../election-nominations";
import { issueBallotToken, castBallot, getTurnout } from "../election-ballot";
import { hashBallotToken } from "@/lib/elections/anonymity";

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const DAY = Date.UTC(2026, 11, 31);
const T_CREATE = Date.UTC(2026, 10, 1);
const T_SUBMIT = Date.UTC(2026, 11, 15);
const T_CLOSE = Date.UTC(2026, 11, 25);
const T_POLL = Date.UTC(2026, 11, 31, 10, 0); // inside poll hours 09:00-17:00
const T_LATE = Date.UTC(2026, 11, 31, 18, 0); // after poll close

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

const MEMBERS = ["cand", "cand2", "n1", "n2", "v1", "v2", "v3", "v4", RO].map(member);

async function setup() {
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
  const election = await createElection(
    db,
    ports,
    {
      actorUid: FOUNDER,
      actorIsFounder: true,
      title: "Member Governor Election 2026",
      electionDayMillis: DAY,
      returningOfficerUid: RO,
      returningOfficerName: "R Officer",
    },
    T_CREATE,
  );
  const electionId = election.id;
  await publishTimetable(db, electionId, RO, {}, T_CREATE);
  await buildRoll(db, ports, electionId, RO, T_CREATE);
  await freezeRoll(db, electionId, RO, T_CREATE);
  await transitionElection(db, electionId, RO, "open_nominations", {}, T_CREATE);
  for (const cand of ["cand", "cand2"]) {
    const n = await submitNomination(
      db,
      ports,
      electionId,
      {
        submitterUid: "n1",
        candidateUid: cand,
        candidateName: `Candidate ${cand}`,
        nominatorUids: ["n1", "n2"],
        candidateStatement: "Statement.",
        consent: {
          driveFileId: `file-${cand}`,
          driveLink: "",
          fileName: "consent.pdf",
          sha256: "c".repeat(64),
          uploadedByUid: cand,
        },
        campaignCodeAccepted: true,
      },
      T_SUBMIT,
    );
    await decideNomination(db, electionId, n.id, RO, "accepted", null, T_SUBMIT);
  }
  await transitionElection(db, electionId, RO, "close_nominations", {}, T_CLOSE);
  await certifyCandidates(db, ports, electionId, RO, T_CLOSE);
  await transitionElection(db, electionId, RO, "open_poll", {}, T_POLL);
  return { db, ports, electionId };
}

describe("election ballot (anonymity engine)", () => {
  it("17A. a second cast for the same voter fails on the cast marker and no second ballot doc exists", async () => {
    const { db, electionId } = await setup();
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    const first = await castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL);
    expect(first.recorded).toBe(true);

    // A fresh token cannot even be issued once the marker exists.
    await expect(issueBallotToken(db, electionId, "v1", {}, T_POLL)).rejects.toMatchObject({
      code: "already_cast",
    });

    // Even with a manually seeded second (valid, unexpired) token, the
    // cast fails on the cast marker.
    const token2 = "manually-seeded-second-token";
    await db
      .collection("elections")
      .doc(electionId)
      .collection("eligibility_tokens")
      .doc(hashBallotToken(token2, electionId))
      .set({
        electionId,
        issuedAt: FakeTimestamp.fromMillis(T_POLL),
        expiresAt: FakeTimestamp.fromMillis(T_POLL + 60 * 60 * 1000),
        redeemedAt: null,
        redeemedDay: null,
      });
    await expect(
      castBallot(db, electionId, { uid: "v1", token: token2, choices: ["cand2"] }, T_POLL),
    ).rejects.toMatchObject({ code: "already_cast" });

    const ballots = await db
      .collection("elections")
      .doc(electionId)
      .collection("ballots")
      .get();
    expect(ballots.size).toBe(1);
  });

  it("18A. reconciliation: ballots == markers == redeemed tokens after N casts including a blank, with no joins", async () => {
    const { db, electionId } = await setup();
    const casts: Array<[string, string[]]> = [
      ["v1", ["cand"]],
      ["v2", ["cand", "cand2"]],
      ["v3", []], // blank ballot
      ["v4", ["cand2"]],
    ];
    for (const [uid, choices] of casts) {
      const { token } = await issueBallotToken(db, electionId, uid, {}, T_POLL);
      await castBallot(db, electionId, { uid, token, choices }, T_POLL);
    }
    const turnout = await getTurnout(db, electionId);
    expect(turnout.ballotsCast).toBe(4);
    expect(turnout.markersCast).toBe(4);
    expect(turnout.tokensRedeemed).toBe(4);
    expect(turnout.reconciled).toBe(true);
  });

  it("19. cast outside poll hours is rejected by the transaction even when the status still reads poll_open", async () => {
    const { db, electionId } = await setup();
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    await expect(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_LATE),
    ).rejects.toMatchObject({ code: "poll_closed", httpStatus: 410 });
    const turnout = await getTurnout(db, electionId);
    expect(turnout.ballotsCast).toBe(0);
  });

  it("11A. the stored ballot doc has exactly the allowed field set, even for hostile input", async () => {
    const { db, electionId } = await setup();
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    const hostile = {
      uid: "v1",
      token,
      choices: ["cand"],
      ipAddress: "203.0.113.9",
      userAgent: "hostile-agent",
      markerId: "forged",
      tokenHash: "forged",
      voterName: "V One",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await castBallot(db, electionId, hostile, T_POLL);

    const ballots = await db
      .collection("elections")
      .doc(electionId)
      .collection("ballots")
      .get();
    expect(ballots.size).toBe(1);
    const stored = ballots.docs[0].data() as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(
      ["castDay", "choices", "electionId", "isBlank"].sort(),
    );
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain("v1");
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain("203.0.113.9");
  });

  it("rejects bad tokens (401), invalid choices (422), and token issue to non-roll members (403)", async () => {
    const { db, electionId } = await setup();
    await expect(
      castBallot(db, electionId, { uid: "v1", token: "not-a-real-token", choices: [] }, T_POLL),
    ).rejects.toMatchObject({ code: "bad_token", httpStatus: 401 });

    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    await expect(
      castBallot(db, electionId, { uid: "v1", token, choices: ["ghost"] }, T_POLL),
    ).rejects.toMatchObject({ code: "invalid_choice", httpStatus: 422 });
    await expect(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand", "cand", "cand2"] }, T_POLL),
    ).rejects.toMatchObject({ code: "invalid_choice" });

    await expect(issueBallotToken(db, electionId, "outsider", {}, T_POLL)).rejects.toMatchObject({
      code: "not_on_roll",
    });
  });

  it("token reissue invalidates the previous token; the old token can no longer cast", async () => {
    const { db, electionId } = await setup();
    const first = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    await expect(issueBallotToken(db, electionId, "v1", {}, T_POLL)).rejects.toMatchObject({
      code: "token_already_issued",
    });
    const second = await issueBallotToken(db, electionId, "v1", { reissue: true }, T_POLL);
    expect(second.token).not.toBe(first.token);
    await expect(
      castBallot(db, electionId, { uid: "v1", token: first.token, choices: ["cand"] }, T_POLL),
    ).rejects.toMatchObject({ code: "bad_token" });
    const ok = await castBallot(db, electionId, { uid: "v1", token: second.token, choices: ["cand"] }, T_POLL);
    expect(ok.recorded).toBe(true);
  });
});
