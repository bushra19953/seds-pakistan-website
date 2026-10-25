/**
 * @jest-environment node
 *
 * CROSS-BACKEND BEHAVIOR CONTRACTS for the elections + AGM cluster
 * (Supabase migration, contract-author suite).
 *
 * These contracts pin the cluster's non-negotiables IDENTICALLY on
 * both backends. Every scenario runs twice:
 *   flag OFF -> fake Firestore only (Supa adapters untouched /
 *               pinned unconfigured);
 *   flag ON  -> SUPA_SURFACES=elections with a fake registered Supa
 *               adapter (the G2 domain adapter injected via
 *               __setElectionSupaAdapterForTests; the G1 core adapter
 *               registered via registerElectionSupaAdapter where the
 *               scenario exercises the core seam, pinned null where
 *               the domain seam is the subject — the same
 *               configuration the G1/G2 suites prove).
 * The observable outcomes (result objects, error codes + HTTP
 * statuses in scripted order, stored payload shapes, hashes) must be
 * deep-equal across the two runs. A divergence here is a blocking
 * migration finding, not a test to adjust.
 *
 * Contracts:
 *  1. ELECTIONS_ENABLED off -> mutating route handlers 503
 *     { code: "elections_disabled" } on both backends.
 *  2. Full-member derivation identity + voter-roll freeze produces a
 *     BYTE-IDENTICAL roll hash and identical entries on both backends.
 *  3. castBallot: identical validation ORDER and error codes for a
 *     scripted invalid-cast sequence; forced adapter error mid-cast
 *     falls back and still succeeds exactly once; the three turnout
 *     counters stay equal on both paths.
 *  4. Ballot anonymity separation: no join key linking a ballot to a
 *     voter in ANY stored payload, on either backend.
 *  5. AGM pins: 21-day notice (20 days => 422), agenda gate
 *     (422 election_item_required), convene 403.
 *  6. Governance votes pins: closeVote idempotent, result immutable,
 *     frozen electorate immune to mid-vote seat changes, integer
 *     threshold math identical.
 *
 * Zero live reads: fake Firestore + in-memory fake adapters only.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock("@/lib/auth-middleware", () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: false,
    user: null,
    error: "contract test: unauthenticated",
  })),
}));

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-contracts-0123456789";

import { NextRequest } from "next/server";
import {
  createFakeDb,
  setFakeNow,
  FakeTimestamp,
} from "./helpers/fake-firestore";
import { createFakeDb as createGovFakeDb } from "./fake-firestore";
import {
  createDefaultPorts,
  createDefaultFullMemberPort,
  type ElectionPorts,
  type FullMemberRecord,
} from "../election-ports";
import {
  createElection,
  publishTimetable,
  transitionElection,
} from "../elections";
import { buildRoll, freezeRoll, listRollEntries } from "../election-roll";
import {
  submitNomination,
  decideNomination,
  certifyCandidates,
} from "../election-nominations";
import { issueBallotToken, castBallot, getTurnout } from "../election-ballot";
import { getElectionOrThrow, millisOf } from "../election-db";
import {
  __setElectionSupaAdapterForTests,
  type ElectionSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from "../election-domain-supa";
import {
  registerElectionSupaAdapter,
  resetElectionSupaAdapter,
  type ElectionSupaAdapter as CoreSupaAdapter,
} from "../election-supa";
import {
  createAgm,
  finaliseAgenda,
  updateAgenda,
  issueNotice,
} from "../agm";
import {
  openVote,
  castVote,
  closeVote,
  getCertifiedResult,
  tallyBallots,
  resolveThreshold,
  type ElectorateSeat,
} from "../governance-votes";
import { POST as electionsPOST } from "@/app/api/elections/route";
import { POST as agmPOST } from "@/app/api/agm/route";
import { POST as ballotPOST } from "@/app/api/elections/[electionId]/ballot/route";
import { POST as rollPOST } from "@/app/api/elections/[electionId]/roll/route";

// ---------------------------------------------------------------------------
// Fake Supa adapters
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** G2 domain adapter fake (same shape as elections-supa-domain.test.ts). */
class FakeDomainSupaAdapter implements ElectionSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  failBallotWrites = false;

  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }

  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }

  async listDocs(
    path: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
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
    if (this.failBallotWrites && path.endsWith("/ballots")) {
      throw new Error("fake supa: simulated infra error on ballots write");
    }
    this.bucket(path).set(id, jsonClone(data));
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: updateDoc missing ${path}/${id}`);
    const next = { ...existing, ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    return { id, ...next };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
    this.bucket(path).delete(id);
  }

  docsAt(path: string): Map<string, SupaDocData> {
    return this.store.get(path) ?? new Map();
  }
}

/** G1 core adapter fake (same shape as elections-supa-seam.test.ts). */
class FakeCoreSupaAdapter implements CoreSupaAdapter {
  store = new Map<string, Record<string, unknown>>();

  private key(collection: string, id: string) {
    return `${collection}/${id}`;
  }
  seed(collection: string, id: string, data: Record<string, unknown>) {
    this.store.set(this.key(collection, id), { ...data });
  }
  async getDoc(collection: string, id: string) {
    const data = this.store.get(this.key(collection, id));
    return data ? { id, ...data } : null;
  }
  async listDocs(collection: string) {
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
  async countDocs(collection: string) {
    const prefix = `${collection}/`;
    let n = 0;
    for (const k of this.store.keys()) if (k.startsWith(prefix)) n += 1;
    return n;
  }
  async setDoc(collection: string, id: string, data: Record<string, unknown>) {
    this.store.set(this.key(collection, id), { ...data });
    return { id, ...data };
  }
  async updateDoc(collection: string, id: string, data: Record<string, unknown>) {
    const existing = this.store.get(this.key(collection, id));
    if (!existing) throw new Error(`updateDoc on missing ${collection}/${id}`);
    const next = { ...existing, ...data };
    this.store.set(this.key(collection, id), next);
    return { id, ...next };
  }
  async deleteDoc(collection: string, id: string) {
    this.store.delete(this.key(collection, id));
  }
}

// ---------------------------------------------------------------------------
// Backend mode plumbing
// ---------------------------------------------------------------------------

type Mode = "off" | "on";

const SAVED_ENV = {
  supa: process.env.SUPA_SURFACES,
  elections: process.env.ELECTIONS_ENABLED,
};

function setMode(mode: Mode, domainAdapter?: FakeDomainSupaAdapter): void {
  if (mode === "on") {
    process.env.SUPA_SURFACES = "elections";
    __setElectionSupaAdapterForTests(domainAdapter ?? new FakeDomainSupaAdapter());
  } else {
    delete process.env.SUPA_SURFACES;
    __setElectionSupaAdapterForTests(new FakeDomainSupaAdapter());
  }
  // G1 core seam pinned "unconfigured" except where a scenario
  // registers its own core adapter (contract 2 derivation).
  registerElectionSupaAdapter(null);
}

afterEach(() => {
  __setElectionSupaAdapterForTests(undefined);
  resetElectionSupaAdapter();
  if (SAVED_ENV.supa === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = SAVED_ENV.supa;
  if (SAVED_ENV.elections === undefined) delete process.env.ELECTIONS_ENABLED;
  else process.env.ELECTIONS_ENABLED = SAVED_ENV.elections;
});

// ---------------------------------------------------------------------------
// Shared lifecycle (mirrors elections-supa-domain.test.ts setupLifecycle)
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

function fixturePorts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  members: FullMemberRecord[] = MEMBERS,
): ElectionPorts {
  const base = createDefaultPorts(db);
  return {
    ...base,
    fullMembers: {
      listFullMembers: async () => members,
      getFullMember: async (uid) => members.find((m) => m.uid === uid) ?? null,
      isFullMember: async (uid) => members.some((m) => m.uid === uid),
    },
  };
}

async function setupLifecycle() {
  const db = createFakeDb();
  setFakeNow(T_CREATE);
  await db.collection("roles").doc(RO).set({ role: "returning_officer" });
  const ports = fixturePorts(db);
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

async function errCode(
  p: Promise<unknown>,
): Promise<{ code: string; httpStatus: number }> {
  try {
    await p;
    return { code: "NO_ERROR", httpStatus: 0 };
  } catch (err) {
    const e = err as { code?: string; httpStatus?: number; status?: number };
    return { code: e.code ?? "NO_CODE", httpStatus: e.httpStatus ?? e.status ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// CONTRACT 1 — ELECTIONS_ENABLED 503 on both backends
// ---------------------------------------------------------------------------

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function runDisabledRoutes(mode: Mode) {
  setMode(mode);
  delete process.env.ELECTIONS_ENABLED; // the feature flag is OFF
  const params = { params: Promise.resolve({ electionId: "e1" }) };
  const responses = [
    await electionsPOST(jsonReq("http://x/api/elections", { title: "T" })),
    await agmPOST(jsonReq("http://x/api/agm", { year: 2026 })),
    await ballotPOST(
      jsonReq("http://x/api/elections/e1/ballot", { token: "t", choices: [] }),
      params,
    ),
    await rollPOST(jsonReq("http://x/api/elections/e1/roll", {}), params),
  ];
  const out = [];
  for (const res of responses) {
    out.push({ status: res.status, body: await res.json() });
  }
  return out;
}

describe("contract 1: ELECTIONS_ENABLED off => 503 elections_disabled", () => {
  it("mutating elections + AGM route handlers refuse identically on both backends", async () => {
    const off = await runDisabledRoutes("off");
    const on = await runDisabledRoutes("on");
    for (const r of [...off, ...on]) {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("elections_disabled");
    }
    expect(on).toEqual(off);
  });
});

// ---------------------------------------------------------------------------
// CONTRACT 2 — full-member derivation identity + byte-identical roll hash
// ---------------------------------------------------------------------------

const SINCE = Date.UTC(2025, 0, 1);

async function runDerivation(mode: Mode) {
  const db = createFakeDb();
  setFakeNow(T_CREATE);
  if (mode === "off") {
    setMode("off");
    await db.collection("roles").doc("u-full").set({ role: "member" });
    await db.collection("roles").doc("u-basic").set({ role: "member_basic" });
    await db.collection("roles").doc("u-legacy").set({ role: "member_basic" });
    await db.collection("users").doc("u-full").set({
      displayName: "Full One",
      chapterId: "ist",
      fullMemberSince: FakeTimestamp.fromMillis(SINCE),
      registerEntryDate: FakeTimestamp.fromMillis(SINCE),
      duesYear: "2026-27",
    });
    await db.collection("users").doc("u-basic").set({
      displayName: "Basic One",
      chapterId: "ist",
      duesYear: "2026-27",
    });
    await db.collection("users").doc("u-mirror").set({
      displayName: "Mirror One",
      role: "member",
      chapterId: null,
      duesYear: "2026-27",
    });
    await db.collection("users").doc("u-legacy").set({
      displayName: "Legacy One",
      chapterId: "ist",
      fullMember: true,
      membershipClass: "full_member",
      duesYear: "2026-27",
    });
  } else {
    process.env.SUPA_SURFACES = "elections";
    __setElectionSupaAdapterForTests(new FakeDomainSupaAdapter());
    const core = new FakeCoreSupaAdapter();
    registerElectionSupaAdapter(core);
    const iso = new Date(SINCE).toISOString();
    core.seed("roles", "u-full", { role: "member" });
    core.seed("roles", "u-basic", { role: "member_basic" });
    core.seed("roles", "u-legacy", { role: "member_basic" });
    core.seed("users", "u-full", {
      displayName: "Full One",
      chapterId: "ist",
      fullMemberSince: iso,
      registerEntryDate: iso,
      duesYear: "2026-27",
    });
    core.seed("users", "u-basic", {
      displayName: "Basic One",
      chapterId: "ist",
      duesYear: "2026-27",
    });
    core.seed("users", "u-mirror", {
      displayName: "Mirror One",
      role: "member",
      chapterId: null,
      duesYear: "2026-27",
    });
    core.seed("users", "u-legacy", {
      displayName: "Legacy One",
      chapterId: "ist",
      fullMember: true,
      membershipClass: "full_member",
      duesYear: "2026-27",
    });
  }
  const port = createDefaultFullMemberPort(db);
  const list = await port.listFullMembers();
  const checks: Record<string, boolean> = {};
  for (const uid of ["u-full", "u-basic", "u-mirror", "u-legacy", "u-ghost"]) {
    checks[uid] = await port.isFullMember(uid);
  }
  return { list, checks };
}

/** Edge-case electorate: unsorted uids, a null chapter, a null since. */
const ROLL_FIXTURE: FullMemberRecord[] = [
  {
    uid: "z-last",
    displayName: "Zed Last",
    chapterId: null,
    fullMemberSinceMillis: null,
    registerEntryDateMillis: null,
    duesYear: "2026-27",
  },
  {
    uid: "a-first",
    displayName: "A First",
    chapterId: "ist",
    fullMemberSinceMillis: SINCE,
    registerEntryDateMillis: SINCE,
    duesYear: "2026-27",
  },
  {
    uid: "m-mid",
    displayName: "M Mid",
    chapterId: "other",
    fullMemberSinceMillis: Date.UTC(2024, 5, 15),
    registerEntryDateMillis: Date.UTC(2024, 5, 15),
    duesYear: "2025-26",
  },
];

async function runRollFreeze(mode: Mode) {
  setMode(mode);
  const db = createFakeDb();
  setFakeNow(T_CREATE);
  await db.collection("roles").doc(RO).set({ role: "returning_officer" });
  const ports = fixturePorts(db, ROLL_FIXTURE);
  const election = await createElection(
    db,
    ports,
    {
      actorUid: FOUNDER,
      actorIsFounder: true,
      title: "Roll Hash Contract Election",
      electionDayMillis: DAY,
      returningOfficerUid: RO,
      returningOfficerName: "R Officer",
    },
    T_CREATE,
  );
  await buildRoll(db, ports, election.id, RO, T_CREATE);
  const frozen = await freezeRoll(db, election.id, RO, T_CREATE);
  const entries = (await listRollEntries(db, election.id))
    .map((e) => ({
      uid: e.uid,
      displayName: e.displayName,
      chapterId: e.chapterId ?? null,
      fullMemberSinceMillis:
        e.fullMemberSince != null ? millisOf(e.fullMemberSince) : null,
      duesYear: e.duesYear,
      eligibleToVote: e.eligibleToVote,
    }))
    .sort((a, b) => (a.uid < b.uid ? -1 : 1));
  return { frozen, entries };
}

describe("contract 2: full-member derivation + roll hash identity", () => {
  it("the derivation (member role only; legacy fields confer nothing) is identical on both backends", async () => {
    const off = await runDerivation("off");
    const on = await runDerivation("on");
    expect(on).toEqual(off);
    expect(off.list.map((m) => m.uid)).toEqual(["u-full", "u-mirror"]);
    expect(off.checks).toEqual({
      "u-full": true,
      "u-basic": false,
      "u-mirror": true,
      "u-legacy": false,
      "u-ghost": false,
    });
    expect(off.list[0].fullMemberSinceMillis).toBe(SINCE);
  });

  it("freezeRoll produces a BYTE-IDENTICAL roll hash and identical entries on both backends", async () => {
    const off = await runRollFreeze("off");
    const on = await runRollFreeze("on");
    // Evidence printed for the report: both hash values.
    console.log(`ROLL_HASH flag OFF (Firestore): ${off.frozen.rollHash}`);
    console.log(`ROLL_HASH flag ON  (Supa):      ${on.frozen.rollHash}`);
    expect(on.frozen.rollHash).toBe(off.frozen.rollHash);
    expect(on.frozen.rollSize).toBe(off.frozen.rollSize);
    expect(on.entries).toEqual(off.entries);
    expect(off.entries).toHaveLength(ROLL_FIXTURE.length);
  });
});
