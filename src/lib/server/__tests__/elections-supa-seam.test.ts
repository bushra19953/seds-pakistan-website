/**
 * Supa seam suite for the elections core group (G1).
 *
 * Covers the fallback contract of election-supa.ts as consumed by
 * election-db.ts, election-ports.ts and elections.ts:
 *   flag OFF            -> adapter never called, Firestore serves
 *   flag ON + adapter   -> adapter serves, ISO timestamps converted
 *   flag ON + no adapter-> Firestore serves
 *   flag ON + adapter error -> Firestore serves (per operation)
 * All data is mocked (fake Firestore + in-memory fake adapter);
 * no live Firestore or Supabase reads.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

import { createFakeDb, setFakeNow } from "./helpers/fake-firestore";
import {
  registerElectionSupaAdapter,
  resetElectionSupaAdapter,
  useSupaElections,
  toSupaDoc,
  fromSupaDoc,
  type ElectionSupaAdapter,
} from "../election-supa";
import { getElectionOrThrow, millisOf } from "../election-db";
import { createDefaultPorts } from "../election-ports";
import {
  createElection,
  publishTimetable,
  runElectionLifecycleSweeps,
} from "../elections";

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const DAY = Date.UTC(2026, 11, 31);
const NOW = Date.UTC(2026, 10, 1);

/* --------------------------------------------------------- fake adapter */

class FakeSupaAdapter implements ElectionSupaAdapter {
  store = new Map<string, Record<string, unknown>>();
  calls: string[] = [];
  failOn: Set<string> = new Set();

  private key(collection: string, id: string) {
    return `${collection}/${id}`;
  }
  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failOn.has(op) || this.failOn.has("*")) {
      throw new Error(`fake adapter failure on ${op}`);
    }
  }
  seed(collection: string, id: string, data: Record<string, unknown>) {
    this.store.set(this.key(collection, id), { ...data });
  }
  async getDoc(collection: string, id: string) {
    this.maybeFail("getDoc");
    const data = this.store.get(this.key(collection, id));
    return data ? { id, ...data } : null;
  }
  async listDocs(collection: string) {
    this.maybeFail("listDocs");
    const prefix = `${collection}/`;
    const out: Array<Record<string, unknown>> = [];
    for (const [k, data] of this.store.entries()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({ id: rest, ...data });
    }
    return out;
  }
  async countDocs(
    collection: string,
    where?: Array<[string, string, unknown]>,
  ) {
    this.maybeFail("countDocs");
    const prefix = `${collection}/`;
    let n = 0;
    for (const [k, data] of this.store.entries()) {
      if (!k.startsWith(prefix)) continue;
      let match = true;
      for (const [field, op, value] of where ?? []) {
        const actual = (data as Record<string, unknown>)[field];
        if (op === "in") {
          if (!Array.isArray(value) || !value.includes(actual)) match = false;
        } else if (op === "==") {
          if (actual !== value) match = false;
        }
      }
      if (match) n += 1;
    }
    return n;
  }
  async setDoc(collection: string, id: string, data: Record<string, unknown>) {
    this.maybeFail("setDoc");
    this.store.set(this.key(collection, id), { ...data });
    return { id, ...data };
  }
  async updateDoc(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ) {
    this.maybeFail("updateDoc");
    const existing = this.store.get(this.key(collection, id));
    if (!existing) throw new Error(`updateDoc on missing ${collection}/${id}`);
    const next = { ...existing, ...data };
    this.store.set(this.key(collection, id), next);
    return { id, ...next };
  }
  async deleteDoc(collection: string, id: string) {
    this.maybeFail("deleteDoc");
    this.store.delete(this.key(collection, id));
  }
}

/* -------------------------------------------------------------- helpers */

const ORIGINAL_ENV = process.env.SUPA_SURFACES;

function supaElectionDoc(overrides: Record<string, unknown> = {}) {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    title: "Member Governor Election 2026",
    kind: "member_governor",
    seatCategory: "member_elected",
    seats: 2,
    governorSeatIds: [],
    status: "draft",
    returningOfficerUid: RO,
    returningOfficerName: "R Officer",
    appointedByUid: FOUNDER,
    appointedAt: iso(NOW),
    roTermEndsAt: null,
    timetable: {
      electionDay: iso(DAY),
      timetablePublishedAt: null,
      timetableLateReason: null,
      nominationOpenAt: iso(NOW + 1000),
      nominationCloseAt: iso(NOW + 2000),
      vettingDeadlineAt: iso(NOW + 3000),
      candidateListDate: iso(NOW + 4000),
      candidateListPublishedAt: null,
      pollOpenAt: iso(NOW + 5000),
      pollCloseAt: iso(NOW + 6000),
      challengeWindowClosesAt: null,
      certificateDeadlineAt: null,
    },
    voterRoll: { status: "not_built", builtAt: null, frozenAt: null, rollSize: 0, rollHash: "" },
    campaignCodeUrl: null,
    campaignCodeDriveFileId: null,
    complianceObligationIds: { timetable: "t", agmNotice: null, agm: null, certificate: "c", registrarFiling: "" },
    meetingId: null,
    agmId: null,
    counters: { ballotsCast: 0, markersCast: 0, tokensRedeemed: 0 },
    createdByUid: FOUNDER,
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
    cancelledReason: null,
    vettingOverdue: false,
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  resetElectionSupaAdapter();
  setFakeNow(NOW);
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = ORIGINAL_ENV;
  resetElectionSupaAdapter();
});

/* ---------------------------------------------------------------- tests */

describe("election supa seam", () => {
  it("flag OFF: adapter is never consulted and Firestore serves the read", async () => {
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    registerElectionSupaAdapter(adapter);
    adapter.seed("elections", "e1", supaElectionDoc({ title: "SUPA TITLE" }));
    // Read a doc that exists only in Firestore.
    await db.collection("elections").doc("fs-only").set({
      title: "FS ONLY",
      status: "draft",
      returningOfficerUid: RO,
      timetable: (supaElectionDoc().timetable as Record<string, unknown>),
    });
    expect(useSupaElections()).toBe(false);
    const got = await getElectionOrThrow(db, "fs-only");
    expect(got.title).toBe("FS ONLY");
    expect(adapter.calls).toEqual([]);
  });

  it("flag ON + adapter: election read comes from Supa with ISO timestamps converted to millis", async () => {
    process.env.SUPA_SURFACES = "elections";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    registerElectionSupaAdapter(adapter);
    adapter.seed("elections", "e1", supaElectionDoc());
    const got = await getElectionOrThrow(db, "e1");
    expect(got.title).toBe("Member Governor Election 2026");
    expect(millisOf(got.timetable.electionDay)).toBe(DAY);
    expect(millisOf(got.timetable.nominationOpenAt)).toBe(NOW + 1000);
    expect(millisOf(got.createdAt)).toBe(NOW);
    expect(millisOf(got.appointedAt)).toBe(NOW);
    expect(adapter.calls).toContain("getDoc");
    // Not-found stays a 404 ElectionError on the Supa path.
    await expect(getElectionOrThrow(db, "missing")).rejects.toMatchObject({
      code: "election_not_found",
      httpStatus: 404,
    });
  });

  it("flag ON + unconfigured adapter (null): Firestore serves", async () => {
    process.env.SUPA_SURFACES = "elections";
    registerElectionSupaAdapter(null);
    const db = createFakeDb();
    await db.collection("elections").doc("e9").set({ title: "FS", status: "draft" });
    const got = await getElectionOrThrow(db, "e9");
    expect(got.title).toBe("FS");
  });

  it("flag ON + adapter error: read falls back to Firestore byte-identically", async () => {
    process.env.SUPA_SURFACES = "elections";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    adapter.failOn.add("*");
    registerElectionSupaAdapter(adapter);
    await db.collection("elections").doc("e7").set({ title: "FS FALLBACK", status: "draft" });
    const got = await getElectionOrThrow(db, "e7");
    expect(got.title).toBe("FS FALLBACK");
    expect(adapter.calls.length).toBeGreaterThan(0);
  });

  it("createElection on Supa: election, compliance and role-history writes land in the adapter as ISO jsonb", async () => {
    process.env.SUPA_SURFACES = "elections";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    registerElectionSupaAdapter(adapter);
    adapter.seed("roles", RO, { role: "returning_officer" });
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
      NOW,
    );
    expect(election.status).toBe("draft");
    expect(millisOf(election.timetable.electionDay)).toBe(DAY);
    expect(millisOf(election.createdAt)).toBe(NOW);
    // The stored jsonb shape: timestamps are ISO strings, no sentinels.
    const stored = adapter.store.get(`elections/${election.id}`);
    expect(stored).toBeDefined();
    expect(typeof stored!.createdAt).toBe("string");
    expect(stored!.createdAt).toBe(new Date(NOW).toISOString());
    expect(typeof stored!.updatedAt).toBe("string");
    const tt = stored!.timetable as Record<string, unknown>;
    expect(tt.electionDay).toBe(new Date(DAY).toISOString());
    // Compliance obligations + role history were written via the seam.
    const collections = [...adapter.store.keys()].map((k) => k.split("/")[0]);
    expect(collections).toContain("compliance_obligations");
    expect(collections).toContain("roleHistory");
    // Nothing for this election landed in Firestore (audit bypass aside).
    const fsSnap = await db.collection("elections").doc(election.id).get();
    expect(fsSnap.exists).toBe(false);
  });

  it("createElection with a failing adapter falls back to Firestore writes", async () => {
    process.env.SUPA_SURFACES = "elections";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    // Every adapter operation fails: each one falls back to Firestore
    // per-operation. (A *successful* adapter response is authoritative
    // — e.g. a successful getDoc returning null is a real 404, not a
    // fallback trigger.)
    adapter.failOn = new Set(["*"]);
    registerElectionSupaAdapter(adapter);
    await db.collection("roles").doc(RO).set({ role: "returning_officer" });
    const ports = createDefaultPorts(db);
    const election = await createElection(
      db,
      ports,
      {
        actorUid: FOUNDER,
        actorIsFounder: true,
        title: "Fallback Election",
        electionDayMillis: DAY,
        returningOfficerUid: RO,
        returningOfficerName: "R Officer",
      },
      NOW,
    );
    expect(election.title).toBe("Fallback Election");
    const fsSnap = await db.collection("elections").doc(election.id).get();
    expect(fsSnap.exists).toBe(true);
  });

  it("publishTimetable on Supa updates via the adapter and returns converted timestamps", async () => {
    process.env.SUPA_SURFACES = "elections";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    registerElectionSupaAdapter(adapter);
    adapter.seed("roles", RO, { role: "returning_officer" });
    const ports = createDefaultPorts(db);
    const election = await createElection(
      db,
      ports,
      {
        actorUid: FOUNDER,
        actorIsFounder: true,
        title: "Publish Election",
        electionDayMillis: DAY,
        returningOfficerUid: RO,
        returningOfficerName: "R Officer",
      },
      NOW,
    );
    const published = await publishTimetable(db, election.id, RO, {}, NOW);
    expect(published.status).toBe("timetable_published");
    expect(millisOf(published.timetable.timetablePublishedAt)).toBe(NOW);
    const stored = adapter.store.get(`elections/${election.id}`);
    expect(stored!.status).toBe("timetable_published");
  });

  it("ports on Supa: listFullMembers applies the role derivation to Supa rows and converts register timestamps", async () => {
    process.env.SUPA_SURFACES = "elections";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    registerElectionSupaAdapter(adapter);
    const since = Date.UTC(2025, 0, 1);
    adapter.seed("roles", "u1", { role: "member" });
    adapter.seed("users", "u1", {
      displayName: "User One",
      chapterId: "ist",
      fullMemberSince: new Date(since).toISOString(),
      registerEntryDate: new Date(since).toISOString(),
      duesYear: "2026-27",
    });
    adapter.seed("roles", "u2", { role: "chapter_admin" });
    adapter.seed("users", "u2", { displayName: "User Two", role: "chapter_admin" });
    const ports = createDefaultPorts(db);
    const members = await ports.fullMembers.listFullMembers();
    expect(members.map((m) => m.uid)).toEqual(["u1"]);
    expect(members[0].fullMemberSinceMillis).toBe(since);
    expect(members[0].registerEntryDateMillis).toBe(since);
    expect(await ports.roles.holdsRole("u1", "member")).toBe(true);
    expect(await ports.roles.holdsRole("u2", "member")).toBe(false);
  });

  it("lifecycle sweeps on Supa list and transition elections through the adapter", async () => {
    process.env.SUPA_SURFACES = "*";
    const db = createFakeDb();
    const adapter = new FakeSupaAdapter();
    registerElectionSupaAdapter(adapter);
    adapter.seed(
      "elections",
      "sweep1",
      supaElectionDoc({ status: "timetable_published" }),
    );
    const result = await runElectionLifecycleSweeps(db, NOW + 1500);
    expect(result.transitioned).toEqual([
      { electionId: "sweep1", to: "nominations_open" },
    ]);
    expect(adapter.store.get("elections/sweep1")!.status).toBe(
      "nominations_open",
    );
  });

  it("conversion helpers: only known timestamp fields convert on read; other strings pass through byte-identical", () => {
    const doc = fromSupaDoc({
      title: "2026-01-01T00:00:00.000Z", // free text that looks ISO: untouched
      createdAt: "2026-01-01T00:00:00.000Z",
      timetable: { electionDay: "2026-12-31T00:00:00.000Z", timetableLateReason: null },
    });
    expect(doc.title).toBe("2026-01-01T00:00:00.000Z");
    expect(millisOf(doc.createdAt)).toBe(Date.UTC(2026, 0, 1));
    const tt = doc.timetable as Record<string, unknown>;
    expect(millisOf(tt.electionDay)).toBe(Date.UTC(2026, 11, 31));
    const back = toSupaDoc({ createdAt: doc.createdAt });
    expect(back.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
