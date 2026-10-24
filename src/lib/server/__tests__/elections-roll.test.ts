/**
 * Roll suite (spec Section 7, tests 12-13).
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
import { createElection } from "../elections";
import { buildRoll, freezeRoll, getRollEntry, computeRollHash } from "../election-roll";

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const DAY = Date.UTC(2026, 11, 31);
const NOW = Date.UTC(2026, 10, 1);

function member(uid: string, extra: Partial<FullMemberRecord> = {}): FullMemberRecord {
  return {
    uid,
    displayName: `Member ${uid}`,
    chapterId: "ist",
    fullMemberSinceMillis: Date.UTC(2025, 0, 1),
    registerEntryDateMillis: Date.UTC(2025, 0, 1),
    duesYear: "2026-27",
    ...extra,
  };
}

async function setup(members: FullMemberRecord[]) {
  const db = createFakeDb();
  setFakeNow(NOW);
  await db.collection("roles").doc(RO).set({ role: "returning_officer" });
  const ports: ElectionPorts = {
    ...createDefaultPorts(db),
    fullMembers: {
      listFullMembers: async () => members,
      getFullMember: async (uid) => members.find((m) => m.uid === uid) ?? null,
      isFullMember: async (uid) => members.some((m) => m.uid === uid),
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
    NOW,
  );
  return { db, ports, electionId: election.id };
}

describe("election voter roll", () => {
  it("12. freeze locks the roll: late Full Members are not added, removed members stay, post-freeze writes are rejected", async () => {
    const members = [member("u1"), member("u2")];
    const { db, ports, electionId } = await setup(members);

    await buildRoll(db, ports, electionId, RO, NOW);
    const frozen = await freezeRoll(db, electionId, RO, NOW);
    expect(frozen.rollSize).toBe(2);
    expect(frozen.rollHash).toMatch(/^[0-9a-f]{64}$/);

    // The world changes after the freeze: u2 loses status, u3 gains it.
    members.splice(0, members.length, member("u1"), member("u3"));

    // Rebuild attempts are refused...
    await expect(buildRoll(db, ports, electionId, RO, NOW)).rejects.toMatchObject({
      code: "roll_frozen",
    });
    await expect(freezeRoll(db, electionId, RO, NOW)).rejects.toMatchObject({
      code: "roll_frozen",
    });
    // ...and the snapshot is untouched.
    expect(await getRollEntry(db, electionId, "u2")).not.toBeNull();
    expect(await getRollEntry(db, electionId, "u3")).toBeNull();
  });

  it("13. rollHash changes if any snapshot field changes", () => {
    const base = [
      {
        uid: "u1",
        displayName: "Member u1",
        chapterId: "ist",
        fullMemberSinceMillis: 123,
        duesYear: "2026-27",
        eligibleToVote: true,
      },
    ];
    const h1 = computeRollHash(base);
    const h2 = computeRollHash([{ ...base[0], displayName: "Changed Name" }]);
    const h3 = computeRollHash([{ ...base[0], fullMemberSinceMillis: 456 }]);
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    // Order of entries does not matter.
    const two = [base[0], { ...base[0], uid: "u2" }];
    expect(computeRollHash(two)).toBe(computeRollHash([...two].reverse()));
  });

  it("refuses to freeze before a build, and non-RO callers are refused", async () => {
    const { db, ports, electionId } = await setup([member("u1")]);
    await expect(freezeRoll(db, electionId, RO, NOW)).rejects.toMatchObject({
      code: "roll_not_built",
    });
    await buildRoll(db, ports, electionId, RO, NOW);
    await expect(freezeRoll(db, electionId, "someone-else", NOW)).rejects.toMatchObject({
      code: "not_returning_officer",
    });
  });
});
