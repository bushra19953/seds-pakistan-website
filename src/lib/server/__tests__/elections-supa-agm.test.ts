/**
 * Supabase migration suite for the elections G3 AGM module (agm.ts).
 *
 * Everything is mocked: a fake Firestore db (the existing helper)
 * for the Firestore side + ports, and a fake in-memory adapter
 * injected into agm-domain-supa for the Supabase side. Zero live
 * reads.
 *
 * Covered:
 * - flag gating for the agm seam (same 'elections' surface as G1/G2).
 * - flag OFF parity: AGM data lands ONLY in Firestore.
 * - flag ON happy paths: create / agenda gate / notice / documents /
 *   auditor appointment run through the seam; raw jsonb rows carry
 *   ISO-string timestamps at the enumerated paths, and
 *   auditor_appointments.appointedAt stays a plain date string.
 * - AGM notice 21-day rule ON path: 20 days -> 422 notice_too_late
 *   with no notice written; exactly 21 days succeeds with one
 *   recipient doc per frozen Full Member in fs_group_recipients.
 * - Agenda-finalisation gate ON path: 422 election_item_required
 *   while governor seats are due.
 * - Convene permission ON path: 403 agm_convene_forbidden.
 * - Unconfigured fallback and bridge-error fallback to Firestore.
 * - Seam units: timestamp serialize/restore at explicit paths only.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

import { createFakeDb, setFakeNow, FakeTimestamp } from "./helpers/fake-firestore";
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
  listAgmDocuments,
  createAuditorAppointment,
  getAgmOrThrow,
} from "../agm";
import {
  __setAgmSupaAdapterForTests,
  agmSupaEnabled,
  serializeForSupa,
  restoreSupaDoc,
  type AgmSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from "../agm-domain-supa";
import { millisOf } from "../election-db";

// ---------------------------------------------------------------------------
// Fake Supabase adapter: stores the SERIALIZED jsonb form (ISO
// strings), exactly like fs_* tables, keyed by collection path + id.
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeSupaAdapter implements AgmSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  failAll = false;

  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }

  private guard(): void {
    if (this.failAll) throw new Error("fake supa: simulated outage");
  }

  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    this.guard();
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }

  async listDocs(
    path: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
    this.guard();
    const out: SupaDoc[] = [];
    for (const [id, data] of this.bucket(path)) {
      const matches = (options?.where ?? []).every(
        ([field, , value]) => data[field] === value,
      );
      if (matches) out.push({ id, ...jsonClone(data) });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  }

  async setDoc(path: string, id: string, data: SupaDocData): Promise<SupaDoc> {
    this.guard();
    this.bucket(path).set(id, jsonClone(data));
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    this.guard();
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: updateDoc missing ${path}/${id}`);
    const next = { ...existing, ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    return { id, ...next };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
    this.guard();
    this.bucket(path).delete(id);
  }

  docsAt(path: string): Map<string, SupaDocData> {
    return this.store.get(path) ?? new Map();
  }
}

// ---------------------------------------------------------------------------

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
    fullMemberSinceMillis: Date.UTC(2025, 0, 1),
    registerEntryDateMillis: Date.UTC(2025, 0, 1),
    duesYear: "2026-27",
  };
}

const MEMBERS = ["m1", "m2", "m3", "m4", "m5"].map(member);

function setup(seatsDue = true) {
  const db = createFakeDb();
  setFakeNow(T_CREATE);
  const base = createDefaultPorts(db);
  const ports: ElectionPorts = {
    ...base,
    fullMembers: {
      listFullMembers: async () => MEMBERS,
      getFullMember: async (uid) => MEMBERS.find((m) => m.uid === uid) ?? null,
      isFullMember: async (uid) => MEMBERS.some((m) => m.uid === uid),
    },
    board: {
      ...base.board,
      readSeatsDue: async () => ({ seatsDue }),
    },
  };
  return { db, ports };
}

async function makeAgm(
  db: ReturnType<typeof createFakeDb>,
  ports: ElectionPorts,
) {
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

describe("agm-domain-supa seam", () => {
  const savedSurfaces = process.env.SUPA_SURFACES;

  afterEach(() => {
    __setAgmSupaAdapterForTests(undefined);
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it("flag gating: OFF without env, OFF when unconfigured, ON with env + adapter, OFF for other surfaces", () => {
    const adapter = new FakeSupaAdapter();
    delete process.env.SUPA_SURFACES;
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(false);

    process.env.SUPA_SURFACES = "elections";
    __setAgmSupaAdapterForTests(null);
    expect(agmSupaEnabled()).toBe(false);

    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);

    process.env.SUPA_SURFACES = "announcements";
    expect(agmSupaEnabled()).toBe(false);

    process.env.SUPA_SURFACES = "*";
    expect(agmSupaEnabled()).toBe(true);
  });

  it("timestamps: serialize converts Timestamp-like values to ISO; restore converts only the explicit paths back", () => {
    const millis = Date.UTC(2026, 0, 15, 8, 30);
    const serialized = serializeForSupa({
      scheduledAt: FakeTimestamp.fromMillis(millis),
      quorum: { verifiedAt: FakeTimestamp.fromMillis(millis) },
      plain: "2026-27",
    }) as Record<string, unknown>;
    expect(serialized.scheduledAt).toBe(new Date(millis).toISOString());
    expect(
      (serialized.quorum as Record<string, unknown>).verifiedAt,
    ).toBe(new Date(millis).toISOString());
    expect(serialized.plain).toBe("2026-27");

    const agm = restoreSupaDoc("agm_events", {
      id: "a1",
      scheduledAt: new Date(millis).toISOString(),
      quorum: { verifiedAt: new Date(millis).toISOString(), verifiedByUid: "x" },
      title: "AGM 2026-12-31",
    });
    expect(millisOf(agm.scheduledAt)).toBe(millis);
    expect(
      millisOf((agm.quorum as Record<string, unknown>).verifiedAt),
    ).toBe(millis);
    expect(agm.title).toBe("AGM 2026-12-31");

    const notice = restoreSupaDoc("agm_events/a1/notices", {
      id: "n1",
      issuedAt: new Date(millis).toISOString(),
      dispatch: {
        startedAt: new Date(millis).toISOString(),
        completedAt: null,
      },
    });
    expect(millisOf(notice.issuedAt)).toBe(millis);
    const dispatch = notice.dispatch as Record<string, unknown>;
    expect(millisOf(dispatch.startedAt)).toBe(millis);
    expect(dispatch.completedAt).toBeNull();

    const recipient = restoreSupaDoc("agm_events/a1/notices/n1/recipients", {
      id: "m1",
      servedAt: new Date(millis).toISOString(),
    });
    expect(millisOf(recipient.servedAt)).toBe(millis);

    // auditor_appointments.appointedAt is a plain date string by
    // design (Finance-canonical shape): never restored.
    const appt = restoreSupaDoc("auditor_appointments", {
      id: "fy2025-26",
      appointedAt: "2026-11-15",
    });
    expect(appt.appointedAt).toBe("2026-11-15");

    const vote = restoreSupaDoc("governance_votes", {
      id: "v1",
      createdAt: new Date(millis).toISOString(),
      result: { votesFor: 6, passed: true },
    });
    expect(millisOf(vote.createdAt)).toBe(millis);
    expect(vote.result).toEqual({ votesFor: 6, passed: true });

    const ballot = restoreSupaDoc("governance_votes/v1/ballots", {
      id: "gov-1",
      castAt: new Date(millis).toISOString(),
      choice: "for",
    });
    expect(millisOf(ballot.castAt)).toBe(millis);
    expect(ballot.choice).toBe("for");
  });

  it("flag OFF: the AGM is created ONLY in Firestore (adapter untouched)", async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(false);

    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);
    expect(adapter.store.size).toBe(0);
    const snap = await db.collection("agm_events").doc(agm.id).get();
    expect(snap.exists).toBe(true);
    expect(millisOf((snap.data() as Record<string, unknown>).scheduledAt)).toBe(AGM_DAY);
  });

  it("flag ON: create + agenda gate + finalise run through Supa with ISO raw timestamps", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);

    const { db, ports } = setup(true);
    const agm = await makeAgm(db, ports);

    // The AGM doc lives in Supa, NOT in the fake Firestore collection.
    expect(adapter.docsAt("agm_events").size).toBe(1);
    const fsSnap = await db.collection("agm_events").doc(agm.id).get();
    expect(fsSnap.exists).toBe(false);

    // Raw jsonb form: timestamps are ISO strings at the listed paths.
    const raw = adapter.docsAt("agm_events").get(agm.id);
    expect(raw?.scheduledAt).toBe(new Date(AGM_DAY).toISOString());
    expect(raw?.createdAt).toBe(new Date(T_CREATE).toISOString());
    expect(typeof raw?.updatedAt).toBe("string");

    // Restored reads give the same millis and the same record shape.
    expect(millisOf(agm.scheduledAt)).toBe(AGM_DAY);
    expect(millisOf(agm.createdAt)).toBe(T_CREATE);
    expect(agm.seatsDue).toBe(true);
    expect(agm.agenda.some((i) => i.kind === "governor_election")).toBe(true);

    // Agenda gate ON path: removing the election item blocks
    // finalisation with 422 election_item_required.
    const withoutElection = agm.agenda.filter(
      (i) => i.kind !== "governor_election",
    );
    await updateAgenda(db, agm.id, NGS, withoutElection);
    await expect(finaliseAgenda(db, agm.id, NGS)).rejects.toMatchObject({
      code: "election_item_required",
      httpStatus: 422,
    });

    await updateAgenda(db, agm.id, NGS, agm.agenda);
    const finalised = await finaliseAgenda(db, agm.id, NGS);
    expect(finalised.agendaFinalised).toBe(true);
    expect(adapter.docsAt("agm_events").get(agm.id)?.agendaFinalised).toBe(true);
  });

  it("flag ON: convene permission is enforced before any write (403 agm_convene_forbidden)", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

    const { db, ports } = setup();
    await expect(
      createAgm(
        db,
        ports,
        {
          actorUid: "random-member",
          actorMayConvene: false,
          year: 2026,
          scheduledAtMillis: AGM_DAY,
          locationOrLink: "IST BIC Room 131 + online",
        },
        T_CREATE,
      ),
    ).rejects.toMatchObject({ code: "agm_convene_forbidden", httpStatus: 403 });
    expect(adapter.docsAt("agm_events").size).toBe(0);
  });

  it("flag ON: getAgmOrThrow on a missing AGM returns 404 agm_not_found", async () => {
    process.env.SUPA_SURFACES = "elections";
    __setAgmSupaAdapterForTests(new FakeSupaAdapter());
    const { db } = setup();
    await expect(getAgmOrThrow(db, "no-such-agm")).rejects.toMatchObject({
      code: "agm_not_found",
      httpStatus: 404,
    });
  });

  it("flag ON: notice 20 days before returns 422 with nothing written; 21 days succeeds with one recipient doc per Full Member", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);
    const noticesPath = `agm_events/${agm.id}/notices`;

    await expect(
      issueNotice(db, ports, agm.id, NGS, T_20_DAYS),
    ).rejects.toMatchObject({ code: "notice_too_late", httpStatus: 422 });
    expect(adapter.docsAt(noticesPath).size).toBe(0);

    const issued = await issueNotice(db, ports, agm.id, NGS, T_21_DAYS);
    expect(issued.recipientCount).toBe(5);
    expect(issued.recipientsHash).toMatch(/^[0-9a-f]{64}$/);

    expect(adapter.docsAt(noticesPath).size).toBe(1);
    const rawNotice = adapter.docsAt(noticesPath).get(issued.noticeId);
    expect(rawNotice?.issuedAt).toBe(new Date(T_21_DAYS).toISOString());
    expect(
      (
        rawNotice?.agendaSnapshot as Array<{ kind: string }>
      ).some((i) => i.kind === "governor_election"),
    ).toBe(true);
    const dispatch = rawNotice?.dispatch as Record<string, unknown>;
    expect(dispatch.startedAt).toBe(new Date(T_21_DAYS).toISOString());
    expect(typeof dispatch.completedAt).toBe("string");

    const recipientsPath = `${noticesPath}/${issued.noticeId}/recipients`;
    expect(adapter.docsAt(recipientsPath).size).toBe(5);
    for (const [, rawRecipient] of adapter.docsAt(recipientsPath)) {
      expect(rawRecipient.servedAt).toBe(new Date(T_21_DAYS).toISOString());
      expect(
        (rawRecipient.deliveryStatus as { inApp: string }).inApp,
      ).toBe("created");
    }

    // The AGM itself transitioned in Supa only.
    expect(adapter.docsAt("agm_events").get(agm.id)?.status).toBe(
      "notice_issued",
    );
    const fsRecipients = await db
      .collection("agm_events")
      .doc(agm.id)
      .collection("notices")
      .doc(issued.noticeId)
      .collection("recipients")
      .get();
    expect(fsRecipients.size).toBe(0);
  });

  it("flag ON: documents are member-gated through Supa and the auditor appointment keeps its date-string appointedAt", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);
    const doc = await addAgmDocument(
      db,
      agm.id,
      NGS,
      {
        kind: "audited_accounts",
        title: "Audited accounts FY 2025-26",
        driveFileId: "drive-accounts",
        driveLink: "https://drive.example/accounts",
        fileName: "accounts.pdf",
        sha256: "e".repeat(64),
        sizeBytes: 12345,
        sourceModule: "workstream_c_finance",
      },
      T_CREATE,
    );
    expect(doc.fullMembersOnly).toBe(true);
    expect(millisOf(doc.uploadedAt)).toBe(T_CREATE);
    expect(adapter.docsAt("agm_documents").size).toBe(1);
    const rawDoc = adapter.docsAt("agm_documents").get(doc.id);
    expect(rawDoc?.uploadedAt).toBe(new Date(T_CREATE).toISOString());
    // The AGM back-reference was updated in Supa.
    expect(adapter.docsAt("agm_events").get(agm.id)?.accountsDocumentId).toBe(
      doc.id,
    );

    await expect(
      getAgmDocumentForUser(db, doc.id, { isFullMember: false }),
    ).rejects.toMatchObject({ code: "full_member_required", httpStatus: 403 });
    const forMember = await getAgmDocumentForUser(db, doc.id, {
      isFullMember: true,
    });
    expect(forMember.driveLink).toBe("https://drive.example/accounts");
    expect(millisOf(forMember.uploadedAt)).toBe(T_CREATE);

    const memberList = await listAgmDocuments(db, agm.id, {
      isFullMember: true,
    });
    expect(memberList).toHaveLength(1);
    const basicList = await listAgmDocuments(db, agm.id, {
      isFullMember: false,
    });
    expect(basicList).toHaveLength(0);

    // Auditor appointment: fallback reason gate first, then the write.
    await expect(
      createAuditorAppointment(
        db,
        {
          actorUid: NGS,
          financialYear: "2025-26",
          firmName: "Example Audit Co",
          auditorName: "A Auditor",
          appointedBy: "founder_fallback",
        },
        T_CREATE,
      ),
    ).rejects.toMatchObject({ code: "fallback_reason_required" });
    expect(adapter.docsAt("auditor_appointments").size).toBe(0);

    const appt = await createAuditorAppointment(
      db,
      {
        actorUid: NGS,
        financialYear: "2025-26",
        firmName: "Example Audit Co",
        auditorName: "A Auditor",
        appointedBy: "founder_fallback",
        founderFallbackReason: "Board had not appointed by 31 August",
      },
      T_CREATE,
    );
    expect(appt.status).toBe("appointed");
    expect(millisOf(appt.appointedAt)).toBe(T_CREATE);
    const rawAppt = adapter.docsAt("auditor_appointments").get("fy2025-26");
    // Stored shape is the Finance-canonical date STRING, untouched.
    expect(rawAppt?.appointedAt).toBe("2026-11-15");
    expect(rawAppt?.fallback).toBe(true);
  });

  it("unconfigured (flag ON, no adapter): AGM work falls back to Firestore", async () => {
    process.env.SUPA_SURFACES = "elections";
    __setAgmSupaAdapterForTests(null);
    expect(agmSupaEnabled()).toBe(false);

    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);
    const snap = await db.collection("agm_events").doc(agm.id).get();
    expect(snap.exists).toBe(true);
  });

  it("adapter error: create + notice fall back to Firestore byte-identically", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    adapter.failAll = true;
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);

    const { db, ports } = setup();
    const agm = await makeAgm(db, ports);
    expect(adapter.docsAt("agm_events").size).toBe(0);

    const issued = await issueNotice(db, ports, agm.id, NGS, T_21_DAYS);
    expect(issued.recipientCount).toBe(5);
    const recipients = await db
      .collection("agm_events")
      .doc(agm.id)
      .collection("notices")
      .doc(issued.noticeId)
      .collection("recipients")
      .get();
    expect(recipients.size).toBe(5);
    const stored = await getAgmOrThrow(db, agm.id);
    expect(stored.status).toBe("notice_issued");
    expect(millisOf(stored.scheduledAt)).toBe(AGM_DAY);
  });
});
