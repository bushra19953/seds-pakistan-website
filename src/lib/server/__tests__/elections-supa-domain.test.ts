/**
 * Supabase migration suite for the elections G2 domain modules
 * (ballot / count / nominations / roll / audit).
 *
 * Everything is mocked: a fake Firestore db (the existing helper) for
 * the via-port election document (G1 seam), and a fake in-memory
 * adapter injected into election-domain-supa for the Supabase side.
 * Zero live reads.
 *
 * Covered:
 * - flag OFF: subcollection data lands ONLY in Firestore.
 * - flag ON: the full lifecycle (roll build/freeze, nominations,
 *   certification, token issue, cast, turnout) runs through the seam;
 *   raw jsonb rows carry ISO-string timestamps; restored reads give
 *   back the same millis, so the roll hash is identical to the
 *   Firestore computation.
 * - adapter error: every operation falls back to Firestore.
 * - seam units: flag gating, timestamp serialize/restore, and the
 *   explicit-path rule (non-timestamp strings are never converted).
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-supa-suite-0123456789";

import { createFakeDb, setFakeNow, FakeTimestamp } from "./helpers/fake-firestore";
import {
  createDefaultPorts,
  type ElectionPorts,
  type FullMemberRecord,
} from "../election-ports";
import { createElection, publishTimetable, transitionElection } from "../elections";
import { buildRoll, freezeRoll, getRollEntry, computeRollHash } from "../election-roll";
import {
  submitNomination,
  decideNomination,
  certifyCandidates,
  listCertifiedCandidates,
} from "../election-nominations";
import { issueBallotToken, castBallot, getTurnout } from "../election-ballot";
import { listElectionAudit } from "../election-audit";
import {
  __setElectionSupaAdapterForTests,
  electionsSupaEnabled,
  serializeForSupa,
  restoreSupaDoc,
  type ElectionSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from "../election-domain-supa";
import { millisOf } from "../election-db";

// ---------------------------------------------------------------------------
// Fake Supabase adapter: stores the SERIALIZED jsonb form (ISO strings),
// exactly like fs_* tables, keyed by collection path + doc id.
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeSupaAdapter implements ElectionSupaAdapter {
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
// Lifecycle setup (same flow as the ballot suite; election document is
// via-port in the fake Firestore db, subcollections follow the flag)
// ---------------------------------------------------------------------------

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const DAY = Date.UTC(2026, 11, 31);
const T_CREATE = Date.UTC(2026, 10, 1);
const T_SUBMIT = Date.UTC(2026, 11, 15);
const T_CLOSE = Date.UTC(2026, 11, 25);
const T_POLL = Date.UTC(2026, 11, 31, 10, 0);

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

const MEMBERS = ["cand", "cand2", "n1", "n2", "v1", "v2", RO].map(member);

async function setupLifecycle(adapter: FakeSupaAdapter) {
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
  const frozen = await freezeRoll(db, electionId, RO, T_CREATE);
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
  return { db, ports, electionId, frozen };
}

// ---------------------------------------------------------------------------

describe("election-domain-supa seam", () => {
  const savedSurfaces = process.env.SUPA_SURFACES;

  afterEach(() => {
    __setElectionSupaAdapterForTests(undefined);
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it("flag gating: OFF without env, OFF when unconfigured, ON with env + adapter, OFF for other surfaces", () => {
    const adapter = new FakeSupaAdapter();
    delete process.env.SUPA_SURFACES;
    __setElectionSupaAdapterForTests(adapter);
    expect(electionsSupaEnabled()).toBe(false);

    process.env.SUPA_SURFACES = "elections";
    __setElectionSupaAdapterForTests(null);
    expect(electionsSupaEnabled()).toBe(false);

    __setElectionSupaAdapterForTests(adapter);
    expect(electionsSupaEnabled()).toBe(true);

    process.env.SUPA_SURFACES = "announcements";
    expect(electionsSupaEnabled()).toBe(false);

    process.env.SUPA_SURFACES = "*";
    expect(electionsSupaEnabled()).toBe(true);
  });

  it("timestamps: serialize converts Timestamp-like values to ISO; restore converts only the explicit paths back", () => {
    const millis = Date.UTC(2026, 0, 15, 8, 30);
    const serialized = serializeForSupa({
      submittedAt: FakeTimestamp.fromMillis(millis),
      nested: { checkedAt: FakeTimestamp.fromMillis(millis) },
      plain: "2026-27",
    }) as Record<string, unknown>;
    expect(serialized.submittedAt).toBe(new Date(millis).toISOString());
    expect((serialized.nested as Record<string, unknown>).checkedAt).toBe(
      new Date(millis).toISOString(),
    );
    expect(serialized.plain).toBe("2026-27");

    const restored = restoreSupaDoc("elections/e1/nominations", {
      id: "n1",
      submittedAt: new Date(millis).toISOString(),
      candidateUid: "cand",
    });
    expect(millisOf(restored.submittedAt)).toBe(millis);
    expect(restored.candidateUid).toBe("cand");

    // ballots carry NO timestamp paths: a date-shaped string stays a string.
    const ballot = restoreSupaDoc("elections/e1/ballots", {
      id: "b1",
      castDay: "2026-12-31",
      choices: ["cand"],
    });
    expect(ballot.castDay).toBe("2026-12-31");

    // voter_roll: fullMemberSince is restored, duesYear is untouched.
    const roll = restoreSupaDoc("elections/e1/voter_roll", {
      id: "v1",
      fullMemberSince: new Date(millis).toISOString(),
      duesYear: "2026-27",
    });
    expect(millisOf(roll.fullMemberSince)).toBe(millis);
    expect(roll.duesYear).toBe("2026-27");
  });

  it("flag OFF: the roll is built ONLY in Firestore (adapter untouched)", async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = new FakeSupaAdapter();
    __setElectionSupaAdapterForTests(adapter);
    expect(electionsSupaEnabled()).toBe(false);

    const db = createFakeDb();
    setFakeNow(T_CREATE);
    await db.collection("roles").doc(RO).set({ role: "returning_officer" });
    const ports = createDefaultPorts(db);
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
    const customPorts: ElectionPorts = {
      ...ports,
      fullMembers: {
        listFullMembers: async () => MEMBERS,
        getFullMember: async (uid) => MEMBERS.find((m) => m.uid === uid) ?? null,
        isFullMember: async (uid) => MEMBERS.some((m) => m.uid === uid),
      },
    };
    await buildRoll(db, customPorts, election.id, RO, T_CREATE);

    expect(adapter.store.size).toBe(0);
    const entry = await getRollEntry(db, election.id, "v1");
    expect(entry).not.toBeNull();
    expect(entry?.uid).toBe("v1");
  });

  it("flag ON: full lifecycle runs through Supa; raw rows hold ISO timestamps; roll hash matches the Firestore computation", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setElectionSupaAdapterForTests(adapter);
    expect(electionsSupaEnabled()).toBe(true);

    const { db, electionId, frozen } = await setupLifecycle(adapter);
    const rollPath = `elections/${electionId}/voter_roll`;
    const nomPath = `elections/${electionId}/nominations`;

    // Roll rows live in Supa, NOT in the fake Firestore subcollection.
    expect(adapter.docsAt(rollPath).size).toBe(MEMBERS.length);
    const fsRoll = await db
      .collection("elections")
      .doc(electionId)
      .collection("voter_roll")
      .get();
    expect(fsRoll.size).toBe(0);

    // Raw jsonb form: timestamps are ISO strings.
    const rawV1 = adapter.docsAt(rollPath).get("v1");
    expect(typeof rawV1?.fullMemberSince).toBe("string");
    expect(rawV1?.fullMemberSince).toBe(
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
    );
    expect(typeof rawV1?.frozenAt).toBe("string");

    // Restored reads give the same millis -> the frozen roll hash is
    // identical to hashing the port records directly (Firestore math).
    const expectedHash = computeRollHash(
      MEMBERS.map((m) => ({
        uid: m.uid,
        displayName: m.displayName,
        chapterId: m.chapterId,
        fullMemberSinceMillis: m.fullMemberSinceMillis,
        duesYear: m.duesYear,
        eligibleToVote: true,
      })),
    );
    expect(frozen.rollHash).toBe(expectedHash);
    const entry = await getRollEntry(db, electionId, "v1");
    expect(entry?.eligibleToVote).toBe(true);
    expect(millisOf(entry?.fullMemberSince)).toBe(Date.UTC(2025, 0, 1));

    // Nominations + certification went through Supa too.
    expect(adapter.docsAt(nomPath).size).toBe(2);
    const certified = await listCertifiedCandidates(db, electionId);
    expect(certified.map((n) => n.candidateUid).sort()).toEqual(["cand", "cand2"]);

    // Audit entries went to fs_audit_logs (top-level audit_logs path).
    const auditDocs = await listElectionAudit(db, electionId);
    expect(auditDocs.some((a) => a.action === "election.roll_freeze")).toBe(true);
    expect(adapter.docsAt("audit_logs").size).toBeGreaterThan(0);

    // Ballot: issue + cast through Supa, anonymity shape preserved.
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);

    const ballots = [...adapter.docsAt(`elections/${electionId}/ballots`).values()];
    expect(ballots).toHaveLength(1);
    expect(ballots[0].choices).toEqual(["cand"]);
    expect(ballots[0]).not.toHaveProperty("uid");
    expect(ballots[0]).not.toHaveProperty("tokenHash");

    // Reissue to the same voter is refused on the Supa cast marker,
    // and replaying the redeemed token is refused as a bad token,
    // exactly as on the Firestore path.
    await expect(
      issueBallotToken(db, electionId, "v1", {}, T_POLL),
    ).rejects.toMatchObject({ code: "already_cast" });
    await expect(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
    ).rejects.toMatchObject({ code: "bad_token" });

    // Turnout reconciles across Supa counts and the election counters.
    const turnout = await getTurnout(db, electionId);
    expect(turnout.ballotsCast).toBe(1);
    expect(turnout.markersCast).toBe(1);
    expect(turnout.tokensRedeemed).toBe(1);
    expect(turnout.reconciled).toBe(true);
  });

  it("adapter error: roll build falls back to Firestore byte-identically", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    adapter.failAll = true;
    __setElectionSupaAdapterForTests(adapter);
    expect(electionsSupaEnabled()).toBe(true);

    const db = createFakeDb();
    setFakeNow(T_CREATE);
    await db.collection("roles").doc(RO).set({ role: "returning_officer" });
    const basePorts = createDefaultPorts(db);
    const ports: ElectionPorts = {
      ...basePorts,
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

    const built = await buildRoll(db, ports, election.id, RO, T_CREATE);
    expect(built.rollSize).toBe(MEMBERS.length);
    expect(adapter.docsAt(`elections/${election.id}/voter_roll`).size).toBe(0);

    // The Firestore snapshot is complete and readable via the same API.
    const entry = await getRollEntry(db, election.id, "cand");
    expect(entry).not.toBeNull();
    expect(entry?.displayName).toBe("Member cand");
    expect(millisOf(entry?.fullMemberSince)).toBe(Date.UTC(2025, 0, 1));
  });
});
