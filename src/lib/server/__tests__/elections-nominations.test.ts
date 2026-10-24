/**
 * Nominations suite (spec Section 7, tests 14-16).
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

import { createFakeDb, setFakeNow } from "./helpers/fake-firestore";
import {
  createDefaultPorts,
  type ElectionPorts,
  type FullMemberRecord,
} from "../election-ports";
import { createElection, publishTimetable, transitionElection } from "../elections";
import { buildRoll, freezeRoll } from "../election-roll";
import {
  submitNomination,
  decideNomination,
  certifyCandidates,
  type SubmitNominationInput,
} from "../election-nominations";

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const DAY = Date.UTC(2026, 11, 31);
const T_CREATE = Date.UTC(2026, 10, 1); // 1 Nov 2026
const T_SUBMIT = Date.UTC(2026, 11, 15); // inside the nomination window
const T_CLOSE = Date.UTC(2026, 11, 25); // after close (24 Dec)

function member(uid: string, since = Date.UTC(2025, 0, 1)): FullMemberRecord {
  return {
    uid,
    displayName: `Member ${uid}`,
    chapterId: "ist",
    fullMemberSinceMillis: since,
    registerEntryDateMillis: since,
    duesYear: "2026-27",
  };
}

const MEMBERS = [
  member("cand"),
  member("cand2"),
  member("young", Date.UTC(2026, 8, 1)), // < 6 months standing at close
  member("n1"),
  member("n2"),
  member("n3"),
  member(RO),
];

async function setup(strikes: number | null = 2) {
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
    discipline: {
      activeStrikes: async () =>
        strikes === null
          ? { activeStrikes: null, source: "ro_attestation" as const }
          : { activeStrikes: strikes, source: "port" as const },
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
  return { db, ports, electionId };
}

function nominationInput(
  overrides: Partial<SubmitNominationInput> = {},
): SubmitNominationInput {
  return {
    submitterUid: "n1",
    candidateUid: "cand",
    candidateName: "Candidate One",
    nominatorUids: ["n1", "n2"],
    candidateStatement: "I will serve.",
    consent: {
      driveFileId: "drive-file-1",
      driveLink: "https://drive.example/file-1",
      fileName: "consent.pdf",
      sha256: "a".repeat(64),
      uploadedByUid: "cand",
    },
    campaignCodeAccepted: true,
    ...overrides,
  };
}

describe("election nominations", () => {
  it("14. rejects 1 or 3 nominators, a nominator equal to the candidate, and duplicate nominators", async () => {
    const { db, ports, electionId } = await setup();
    await expect(
      submitNomination(db, ports, electionId, nominationInput({ nominatorUids: ["n1"] }), T_SUBMIT),
    ).rejects.toMatchObject({ code: "nominator_count" });
    await expect(
      submitNomination(db, ports, electionId, nominationInput({ nominatorUids: ["n1", "n2", "n3"] }), T_SUBMIT),
    ).rejects.toMatchObject({ code: "nominator_count" });
    await expect(
      submitNomination(db, ports, electionId, nominationInput({ nominatorUids: ["cand", "n2"] }), T_SUBMIT),
    ).rejects.toMatchObject({ code: "nominator_is_candidate" });
    await expect(
      submitNomination(db, ports, electionId, nominationInput({ nominatorUids: ["n1", "n1"] }), T_SUBMIT),
    ).rejects.toMatchObject({ code: "nominator_duplicate" });
  });

  it("15. rejects a nomination naming the RO as candidate at submit, and again at RO accept", async () => {
    const { db, ports, electionId } = await setup();
    await expect(
      submitNomination(
        db,
        ports,
        electionId,
        nominationInput({ candidateUid: RO, candidateName: "R Officer" }),
        T_SUBMIT,
      ),
    ).rejects.toMatchObject({ code: "ro_is_candidate" });

    // Defence in depth: a seeded RO nomination reaching the queue still
    // cannot be accepted by the RO.
    const ref = db
      .collection("elections")
      .doc(electionId)
      .collection("nominations")
      .doc();
    await ref.set({
      electionId,
      candidateUid: RO,
      candidateName: "R Officer",
      nominatorUids: ["n1", "n2"],
      candidateStatement: "",
      consent: { driveFileId: "x", driveLink: "", fileName: "c.pdf", sha256: "b".repeat(64), uploadedByUid: RO },
      campaignCodeAcceptedAt: null,
      eligibility: { isFullMember: true, fullMemberSince: null, sixMonthStandingMet: false, activeStrikes: null, strikesCheckSource: "ro_attestation", checkedAt: null },
      status: "submitted",
      roDecision: null,
      certifiedAt: null,
    });
    await expect(
      decideNomination(db, electionId, ref.id, RO, "accepted", null, T_SUBMIT),
    ).rejects.toMatchObject({ code: "ro_is_candidate" });
  });

  it("16. records standing + strikes facts; certification blocked while unvetted; reject without reason is 400", async () => {
    const { db, ports, electionId } = await setup(2);

    const good = await submitNomination(db, ports, electionId, nominationInput(), T_SUBMIT);
    expect(good.eligibility.sixMonthStandingMet).toBe(true);
    expect(good.eligibility.activeStrikes).toBe(2);
    expect(good.eligibility.strikesCheckSource).toBe("port");

    const young = await submitNomination(
      db,
      ports,
      electionId,
      nominationInput({ candidateUid: "young", candidateName: "Young One" }),
      T_SUBMIT,
    );
    expect(young.eligibility.sixMonthStandingMet).toBe(false);

    // RO reject without a reason -> 400.
    await expect(
      decideNomination(db, electionId, young.id, RO, "rejected", null, T_SUBMIT),
    ).rejects.toMatchObject({ code: "reject_reason_required", httpStatus: 400 });
    await expect(
      decideNomination(db, electionId, young.id, RO, "rejected", "  ", T_SUBMIT),
    ).rejects.toMatchObject({ code: "reject_reason_required" });

    // Certification blocked while any nomination is unvetted.
    await transitionElection(db, electionId, RO, "close_nominations", {}, T_CLOSE);
    await expect(certifyCandidates(db, ports, electionId, RO, T_CLOSE)).rejects.toMatchObject({
      code: "vetting_incomplete",
    });

    // Decide both, then certification succeeds.
    await decideNomination(db, electionId, young.id, RO, "rejected", "Less than 6 months standing (Sec 7.3).", T_CLOSE);
    await decideNomination(db, electionId, good.id, RO, "accepted", null, T_CLOSE);
    const certified = await certifyCandidates(db, ports, electionId, RO, T_CLOSE);
    expect(certified.certifiedCandidateUids).toEqual(["cand"]);
  });

  it("marks the strikes check as ro_attestation (manual) when the discipline port cannot answer", async () => {
    const { db, ports, electionId } = await setup(null);
    const n = await submitNomination(db, ports, electionId, nominationInput(), T_SUBMIT);
    expect(n.eligibility.activeStrikes).toBeNull();
    expect(n.eligibility.strikesCheckSource).toBe("ro_attestation");
  });
});
