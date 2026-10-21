/**
 * AGM suite (spec Section 7, tests 23-25).
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
import {
  createAgm,
  finaliseAgenda,
  updateAgenda,
  issueNotice,
  addAgmDocument,
  getAgmDocumentForUser,
  createAuditorAppointment,
} from "../agm";

const NGS = "ngs-uid";
const AGM_DAY = Date.UTC(2026, 11, 31);
const T_CREATE = Date.UTC(2026, 10, 15);
const T_20_DAYS = Date.UTC(2026, 11, 11); // 20 days before 31 Dec
const T_21_DAYS = Date.UTC(2026, 11, 10); // exactly 21 days before

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

const MEMBERS = ["m1", "m2", "m3", "m4", "m5"].map(member);

function setup(seatsDue = true) {
  const db = createFakeDb();
  setFakeNow(T_CREATE);
  const ports: ElectionPorts = {
    ...createDefaultPorts(db),
    fullMembers: {
      listFullMembers: async () => MEMBERS,
      getFullMember: async (uid) => MEMBERS.find((m) => m.uid === uid) ?? null,
      isFullMember: async (uid) => MEMBERS.some((m) => m.uid === uid),
    },
    board: {
      ...createDefaultPorts(db).board,
      readSeatsDue: async () => ({ seatsDue }),
    },
  };
  return { db, ports };
}

async function makeAgm(db: ReturnType<typeof createFakeDb>, ports: ElectionPorts) {
  return createAgm(
    db,
    ports,
    {
      actorUid: NGS,
      actorMayConvene: true,
      year: 2026,
      scheduledAtMillis: AGM_DAY,
      locationOrLink: "IST BIC Room 131 + online",
    },
    T_CREATE,
  );
}

describe("AGM", () => {
  it("23. notice issue 20 days before returns 422; 21 days succeeds with one recipient doc per frozen Full Member", async () => {
    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);

    await expect(issueNotice(db, ports, agm.id, NGS, T_20_DAYS)).rejects.toMatchObject({
      code: "notice_too_late",
      httpStatus: 422,
    });

    const issued = await issueNotice(db, ports, agm.id, NGS, T_21_DAYS);
    expect(issued.recipientCount).toBe(5);
    expect(issued.recipientsHash).toMatch(/^[0-9a-f]{64}$/);

    const recipients = await db
      .collection("agm_events")
      .doc(agm.id)
      .collection("notices")
      .doc(issued.noticeId)
      .collection("recipients")
      .get();
    expect(recipients.size).toBe(5);
    for (const r of recipients.docs) {
      expect(r.data().deliveryStatus.inApp).toBe("created");
    }

    const noticeSnap = await db
      .collection("agm_events")
      .doc(agm.id)
      .collection("notices")
      .doc(issued.noticeId)
      .get();
    expect(noticeSnap.data().agendaSnapshot.some((i: { kind: string }) => i.kind === "governor_election")).toBe(true);
  });

  it("24. a Basic Member gets 403 on audited accounts and never a Drive link; a Full Member succeeds", async () => {
    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);
    const doc = await addAgmDocument(db, agm.id, NGS, {
      kind: "audited_accounts",
      title: "Audited accounts FY 2025-26",
      driveFileId: "drive-accounts",
      driveLink: "https://drive.example/accounts",
      fileName: "accounts.pdf",
      sha256: "e".repeat(64),
      sizeBytes: 12345,
      sourceModule: "workstream_c_finance",
    });
    expect(doc.fullMembersOnly).toBe(true);

    await expect(
      getAgmDocumentForUser(db, doc.id, { isFullMember: false }),
    ).rejects.toMatchObject({ code: "full_member_required", httpStatus: 403 });

    const forMember = await getAgmDocumentForUser(db, doc.id, { isFullMember: true });
    expect(forMember.driveLink).toBe("https://drive.example/accounts");

    // Even an ungated document never leaks its Drive link to a non-Full Member.
    const open = await addAgmDocument(db, agm.id, NGS, {
      kind: "agenda",
      title: "Agenda",
      driveFileId: "drive-agenda",
      driveLink: "https://drive.example/agenda",
      fileName: "agenda.pdf",
      sha256: "f".repeat(64),
      sizeBytes: 100,
      sourceModule: "manual_upload",
    });
    const forBasic = await getAgmDocumentForUser(db, open.id, { isFullMember: false });
    expect(forBasic.driveLink).toBeNull();
  });

  it("25. agenda finalisation without the governor election item while seats are due returns 422 election_item_required", async () => {
    const { db, ports } = setup(true);
    const agm = await makeAgm(db, ports);
    // Seats due: create pre-populates the item; the gate is proved by
    // removing it and attempting finalisation.
    expect(agm.seatsDue).toBe(true);
    expect(agm.agenda.some((i) => i.kind === "governor_election")).toBe(true);

    const withoutElection = agm.agenda.filter((i) => i.kind !== "governor_election");
    await updateAgenda(db, agm.id, NGS, withoutElection);
    await expect(finaliseAgenda(db, agm.id, NGS)).rejects.toMatchObject({
      code: "election_item_required",
      httpStatus: 422,
    });

    await updateAgenda(db, agm.id, NGS, agm.agenda);
    const finalised = await finaliseAgenda(db, agm.id, NGS);
    expect(finalised.agendaFinalised).toBe(true);
  });

  it("auditor appointment by Founder fallback requires the reason (Constitution 13.13)", async () => {
    const { db } = setup();
    await expect(
      createAuditorAppointment(db, {
        actorUid: NGS,
        financialYear: "2025-26",
        firmName: "Example Audit Co",
        auditorName: "A Auditor",
        appointedBy: "founder_fallback",
      }),
    ).rejects.toMatchObject({ code: "fallback_reason_required" });

    const ok = await createAuditorAppointment(db, {
      actorUid: NGS,
      financialYear: "2025-26",
      firmName: "Example Audit Co",
      auditorName: "A Auditor",
      appointedBy: "founder_fallback",
      founderFallbackReason: "Board had not appointed by 31 August",
    });
    expect(ok.status).toBe("appointed");
  });
});
