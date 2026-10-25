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

// ---------------------------------------------------------------------------
// CONTRACT 3 — castBallot validation order, fallback, turnout counters
// CONTRACT 4 — ballot anonymity separation (structural, both stores)
// ---------------------------------------------------------------------------

async function runCastScript(mode: Mode) {
  const adapter = new FakeDomainSupaAdapter();
  setMode(mode, adapter);
  const { db, electionId } = await setupLifecycle();
  const seq: Array<{ code: string; httpStatus: number }> = [];

  // a. unknown token
  seq.push(
    await errCode(
      castBallot(db, electionId, { uid: "v1", token: "unknown-token", choices: ["cand"] }, T_POLL),
    ),
  );
  // issue a live token to v1
  const { token: t1 } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
  // b. outside the poll window (valid token, before pollOpenAt)
  seq.push(
    await errCode(
      castBallot(db, electionId, { uid: "v1", token: t1, choices: ["cand"] }, T_CREATE),
    ),
  );
  // c. ineligible voter: token issue to a uid not on the frozen roll
  seq.push(await errCode(issueBallotToken(db, electionId, "outsider", {}, T_POLL)));
  // d. the one valid cast
  const ok1 = await castBallot(db, electionId, { uid: "v1", token: t1, choices: ["cand"] }, T_POLL);
  // e. reused (redeemed) token
  seq.push(
    await errCode(
      castBallot(db, electionId, { uid: "v1", token: t1, choices: ["cand"] }, T_POLL),
    ),
  );
  // f. double cast: v1's session presenting v2's live token hits v1's marker
  const { token: t2 } = await issueBallotToken(db, electionId, "v2", {}, T_POLL);
  seq.push(
    await errCode(
      castBallot(db, electionId, { uid: "v1", token: t2, choices: ["cand"] }, T_POLL),
    ),
  );
  // g. v2 casts with its own token
  const ok2 = await castBallot(db, electionId, { uid: "v2", token: t2, choices: ["cand2"] }, T_POLL);

  const turnout = await getTurnout(db, electionId);
  const election = await getElectionOrThrow(db, electionId);
  return {
    seq,
    ok1,
    ok2,
    turnout,
    counters: election.counters,
    db,
    adapter,
    electionId,
    tokens: { t1, t2 },
  };
}

const EXPECTED_CAST_SEQ = [
  { code: "bad_token", httpStatus: 401 },
  { code: "poll_closed", httpStatus: 410 },
  { code: not_on_roll_code(), httpStatus: 403 },
  { code: "bad_token", httpStatus: 401 },
  { code: "already_cast", httpStatus: 409 },
];
function not_on_roll_code(): string {
  return "not_on_roll";
}

describe("contract 3: castBallot validation order + counters", () => {
  it("the scripted invalid-cast sequence yields identical codes in identical order on both backends", async () => {
    const off = await runCastScript("off");
    const on = await runCastScript("on");
    expect(off.seq).toEqual(EXPECTED_CAST_SEQ);
    expect(on.seq).toEqual(EXPECTED_CAST_SEQ);
    expect(on.seq).toEqual(off.seq);
    expect(on.ok1).toEqual(off.ok1);
    expect(on.ok2).toEqual(off.ok2);
  });

  it("the three turnout counters stay equal on both paths", async () => {
    const off = await runCastScript("off");
    const on = await runCastScript("on");
    for (const r of [off, on]) {
      expect(r.counters.ballotsCast).toBe(2);
      expect(r.counters.markersCast).toBe(2);
      expect(r.counters.tokensRedeemed).toBe(2);
      expect(r.turnout.ballotsCast).toBe(2);
      expect(r.turnout.markersCast).toBe(2);
      expect(r.turnout.tokensRedeemed).toBe(2);
      expect(r.turnout.reconciled).toBe(true);
    }
    expect(on.turnout).toEqual(off.turnout);
  });

  it("forced adapter error mid-cast (ballots write) falls back and still succeeds exactly once", async () => {
    const adapter = new FakeDomainSupaAdapter();
    setMode("on", adapter);
    const { db, electionId } = await setupLifecycle();
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);

    adapter.failBallotWrites = true;
    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);

    // Exactly one ballot exists across BOTH stores combined.
    const supaBallots = adapter.docsAt(`elections/${electionId}/ballots`).size;
    const fsBallots = [...db._dump().keys()].filter((k) =>
      k.startsWith(`elections/${electionId}/ballots/`),
    ).length;
    expect(supaBallots + fsBallots).toBe(1);

    // Counters still move exactly once, and all three stay equal.
    const election = await getElectionOrThrow(db, electionId);
    expect(election.counters).toEqual({
      ballotsCast: 1,
      markersCast: 1,
      tokensRedeemed: 1,
    });

    // Replay of the same token is refused: the cast happened once only.
    adapter.failBallotWrites = false;
    await expect(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
    ).rejects.toMatchObject({ code: "bad_token" });
    const after = await getElectionOrThrow(db, electionId);
    expect(after.counters.ballotsCast).toBe(1);
  });
});

// --- Contract 4 helpers: harvest the raw stored payloads -------------

interface StoredDoc {
  id: string;
  data: Record<string, unknown>;
}

function harvestStores(
  r: Awaited<ReturnType<typeof runCastScript>>,
  mode: Mode,
): Record<"ballots" | "cast_markers" | "eligibility_tokens" | "token_issuance", StoredDoc[]> {
  const subs = ["ballots", "cast_markers", "eligibility_tokens", "token_issuance"] as const;
  const out = {} as Record<(typeof subs)[number], StoredDoc[]>;
  if (mode === "off") {
    const dump = r.db._dump();
    for (const sub of subs) {
      const prefix = `elections/${r.electionId}/${sub}/`;
      out[sub] = [...dump.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, data]) => ({ id: k.slice(prefix.length), data }));
    }
  } else {
    for (const sub of subs) {
      out[sub] = [...r.adapter.docsAt(`elections/${r.electionId}/${sub}`).entries()].map(
        ([id, data]) => ({ id, data }),
      );
    }
  }
  return out;
}

describe("contract 4: ballot anonymity separation (structural)", () => {
  it("no stored payload on either backend carries a join key linking a ballot to a voter", async () => {
    const results: Array<{ mode: Mode; r: Awaited<ReturnType<typeof runCastScript>> }> = [
      { mode: "off", r: await runCastScript("off") },
      { mode: "on", r: await runCastScript("on") },
    ];
    for (const { mode, r } of results) {
      const stores = harvestStores(r, mode);
      const voters = ["v1", "v2"];
      const ballotIds = stores.ballots.map((b) => b.id);
      const markerIds = stores.cast_markers.map((m) => m.id);
      const tokenIds = stores.eligibility_tokens.map((t) => t.id);
      const plaintextTokens = [r.tokens.t1, r.tokens.t2];

      expect(stores.ballots).toHaveLength(2);
      expect(stores.cast_markers).toHaveLength(2);
      expect(stores.eligibility_tokens).toHaveLength(2);

      // Ballots: exactly the anonymous schema; nothing voter-shaped.
      for (const b of stores.ballots) {
        expect(Object.keys(b.data).sort()).toEqual([
          "castDay",
          "choices",
          "electionId",
          "isBlank",
        ]);
        const json = JSON.stringify(b.data);
        for (const v of voters) expect(json).not.toContain(v);
        for (const t of plaintextTokens) expect(json).not.toContain(t);
        for (const id of [...markerIds, ...tokenIds]) expect(json).not.toContain(id);
      }
      // Markers: prove a cast happened; carry no choice, no token, no
      // ballot id, and the marker id itself is not the uid.
      for (const m of stores.cast_markers) {
        expect(Object.keys(m.data).sort()).toEqual([
          "castDay",
          "electionId",
          "pollWindow",
        ]);
        const json = JSON.stringify(m.data);
        for (const id of ballotIds) expect(json).not.toContain(id);
        for (const t of plaintextTokens) expect(json).not.toContain(t);
        for (const v of voters) expect(m.id).not.toContain(v);
      }
      // Tokens: bearer hashes only; no uid, no ballot id.
      for (const t of stores.eligibility_tokens) {
        expect(Object.keys(t.data).sort()).toEqual([
          "electionId",
          "expiresAt",
          "issuedAt",
          "redeemedAt",
          "redeemedDay",
        ]);
        const json = JSON.stringify(t.data);
        for (const v of voters) expect(json).not.toContain(`"${v}"`);
        for (const id of ballotIds) expect(json).not.toContain(id);
        for (const p of plaintextTokens) expect(json).not.toContain(p);
      }
      // Issuance index: keyed by one-way HMAC, holds only the live
      // token hash; no uid anywhere.
      for (const i of stores.token_issuance) {
        expect(Object.keys(i.data).sort()).toEqual(["issuedAt", "tokenHash"]);
        for (const v of voters) {
          expect(i.id).not.toContain(v);
          expect(JSON.stringify(i.data)).not.toContain(`"${v}"`);
        }
        for (const id of ballotIds) expect(JSON.stringify(i.data)).not.toContain(id);
      }
      // No id is shared across any two of the four stores.
      const allIds = [...ballotIds, ...markerIds, ...tokenIds];
      expect(new Set(allIds).size).toBe(allIds.length);
    }
  });
});

// ---------------------------------------------------------------------------
// CONTRACT 5 — AGM pins (current-stack agm.ts behavior; the seam
// contract G3's conversion must preserve)
// ---------------------------------------------------------------------------

const NGS = "ngs-uid";
const AGM_DAY = Date.UTC(2026, 11, 31);
const T_AGM_CREATE = Date.UTC(2026, 10, 15);
const T_20_DAYS = Date.UTC(2026, 11, 11); // exactly 20 days before
const T_21_DAYS = Date.UTC(2026, 11, 10); // exactly 21 days before
const AGM_MEMBERS = ["m1", "m2", "m3", "m4", "m5"].map(member);

async function runAgmScenario(mode: Mode) {
  setMode(mode);
  const db = createFakeDb();
  setFakeNow(T_AGM_CREATE);
  const base = createDefaultPorts(db);
  const ports: ElectionPorts = {
    ...fixturePorts(db, AGM_MEMBERS),
    board: {
      ...base.board,
      readSeatsDue: async () => ({ seatsDue: true }),
    },
  };

  const convene = await errCode(
    createAgm(
      db,
      ports,
      {
        actorUid: NGS,
        actorMayConvene: false,
        year: 2026,
        scheduledAtMillis: AGM_DAY,
        locationOrLink: "IST BIC Room 131 + online",
      },
      T_AGM_CREATE,
    ),
  );

  const agm = await createAgm(
    db,
    ports,
    {
      actorUid: NGS,
      actorMayConvene: true,
      year: 2026,
      scheduledAtMillis: AGM_DAY,
      locationOrLink: "IST BIC Room 131 + online",
    },
    T_AGM_CREATE,
  );

  // Agenda gate: strip the governor_election item, finalisation 422s.
  await updateAgenda(
    db,
    agm.id,
    NGS,
    agm.agenda.filter((i) => i.kind !== "governor_election"),
  );
  const agendaGate = await errCode(finaliseAgenda(db, agm.id, NGS));
  await updateAgenda(db, agm.id, NGS, agm.agenda);

  // 21-day rule: 20 days before => 422; exactly 21 days => issued.
  const notice20 = await errCode(issueNotice(db, ports, agm.id, NGS, T_20_DAYS));
  const notice21 = await issueNotice(db, ports, agm.id, NGS, T_21_DAYS);

  return {
    convene,
    seatsDue: agm.seatsDue,
    hasElectionItem: agm.agenda.some((i) => i.kind === "governor_election"),
    agendaGate,
    notice20,
    recipientCount: notice21.recipientCount,
    recipientsHash: notice21.recipientsHash,
  };
}

describe("contract 5: AGM pins", () => {
  it("convene 403, agenda gate 422 election_item_required, 20-day notice 422, 21-day notice issued — identical on both backends", async () => {
    const off = await runAgmScenario("off");
    const on = await runAgmScenario("on");
    expect(on).toEqual(off);
    expect(off.convene).toEqual({ code: "agm_convene_forbidden", httpStatus: 403 });
    expect(off.seatsDue).toBe(true);
    expect(off.hasElectionItem).toBe(true);
    expect(off.agendaGate).toEqual({
      code: "election_item_required",
      httpStatus: 422,
    });
    expect(off.notice20).toEqual({ code: "notice_too_late", httpStatus: 422 });
    expect(off.recipientCount).toBe(AGM_MEMBERS.length);
    expect(off.recipientsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// CONTRACT 6 — governance votes pins (current-stack governance-votes.ts
// behavior; the seam contract the G4/G5 conversion must preserve)
// ---------------------------------------------------------------------------

function govSeats(n: number): ElectorateSeat[] {
  return Array.from({ length: n }, (_, i) => ({
    seatKey: `seat-${i + 1}`,
    roleKey: "governor",
    uid: `gov-${i + 1}`,
    vacant: false,
  }));
}

async function runGovScenario(mode: Mode) {
  setMode(mode);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createGovFakeDb() as any;

  // open -> cast -> close, then close again (idempotence + immutability)
  const voteId = await openVote(db, {
    subjectType: "ratification_refusal",
    electorate: govSeats(9),
    createdByUid: "founder-uid",
  });
  for (let i = 1; i <= 6; i += 1) await castVote(db, voteId, `gov-${i}`, "for");
  for (let i = 7; i <= 9; i += 1) await castVote(db, voteId, `gov-${i}`, "against");
  const first = await closeVote(db, voteId, "founder-uid");
  const storedAfterFirst = db.read("governance_votes", voteId);
  const second = await closeVote(db, voteId, "founder-uid");
  const storedAfterSecond = db.read("governance_votes", voteId);
  const certified = await getCertifiedResult(db, voteId);
  const closeAuditCount = db
    .all("audit_logs")
    .filter(
      (a: { data: { action?: string } }) =>
        a.data.action === "governance_vote_closed",
    ).length;
  const castAfterClose = await errCode(castVote(db, voteId, "gov-1", "against"));
  const certifiedAfter = await getCertifiedResult(db, voteId);

  // Frozen electorate vs a mid-vote seat change: the caller's array is
  // mutated after open (seat reassigned + a seat added); neither the
  // intruder nor the added seat may vote, the original holder may.
  const electorate2 = govSeats(3);
  const vote2 = await openVote(db, {
    subjectType: "board_generic",
    electorate: electorate2,
    createdByUid: "founder-uid",
  });
  electorate2[0].uid = "intruder";
  electorate2.push({
    seatKey: "seat-4",
    roleKey: "governor",
    uid: "gov-4",
    vacant: false,
  });
  const intruderCast = await errCode(castVote(db, vote2, "intruder", "for"));
  const addedSeatCast = await errCode(castVote(db, vote2, "gov-4", "for"));
  await castVote(db, vote2, "gov-1", "for");
  const storedElectorate = db.read("governance_votes", vote2).electorate;

  return {
    first,
    second,
    certified,
    certifiedAfter,
    storedAfterFirst,
    storedAfterSecond,
    closeAuditCount,
    castAfterClose,
    intruderCast,
    addedSeatCast,
    storedElectorate,
  };
}

function ballotsOf(forCount: number, against = 0, abstain = 0) {
  return [
    ...Array.from({ length: forCount }, () => ({ choice: "for" as const })),
    ...Array.from({ length: against }, () => ({ choice: "against" as const })),
    ...Array.from({ length: abstain }, () => ({ choice: "abstain" as const })),
  ];
}

function runThresholdTable() {
  const cases: Array<{ name: string; result: ReturnType<typeof tallyBallots> }> = [];
  const add = (
    name: string,
    subject: Parameters<typeof resolveThreshold>[0],
    size: number,
    b: ReturnType<typeof ballotsOf>,
  ) => {
    cases.push({
      name,
      result: tallyBallots(b, {
        ...resolveThreshold(subject, size),
        electorateSize: size,
      }),
    });
  };
  add("refusal 5/9", "ratification_refusal", 9, ballotsOf(5, 4));
  add("refusal 6/9 (exact 2/3 boundary)", "ratification_refusal", 9, ballotsOf(6, 3));
  add("refusal 2/3 of 3 (exact equality)", "ratification_refusal", 3, ballotsOf(2, 1));
  add("expel 3/6", "chapter_expel", 6, ballotsOf(3, 0));
  add("expel 4/6 (exact 2/3 boundary)", "chapter_expel", 6, ballotsOf(4, 0));
  add("cooption 4/9", "cooption", 9, ballotsOf(4, 0));
  add("cooption 5/9 (floor(9/2)+1)", "cooption", 9, ballotsOf(5, 0));
  add("cooption 4/8", "cooption", 8, ballotsOf(4, 0));
  add("cooption 5/8 (floor(8/2)+1)", "cooption", 8, ballotsOf(5, 0));
  add("governor_removal 4/7", "governor_removal", 7, ballotsOf(4, 0));
  add("strike3 tie fails", "strike3_expulsion", 9, ballotsOf(3, 3));
  add("strike3 4-3", "strike3_expulsion", 9, ballotsOf(4, 3));
  add("strike3 quorum short (4 participating)", "strike3_expulsion", 9, ballotsOf(2, 1, 1));
  add("strike3 quorum met by abstains", "strike3_expulsion", 9, ballotsOf(2, 1, 2));
  return cases;
}

describe("contract 6: governance votes pins", () => {
  it("closeVote is idempotent with no rewrite, the result is immutable, and the frozen electorate ignores mid-vote seat changes — identical on both backends", async () => {
    const off = await runGovScenario("off");
    const on = await runGovScenario("on");
    expect(on).toEqual(off);

    expect(off.first.passed).toBe(true);
    expect(off.first.votesFor).toBe(6);
    expect(off.second).toEqual(off.first);
    expect(off.certified).toEqual(off.first);
    // Second close rewrote nothing and wrote no second audit entry.
    expect(off.storedAfterSecond).toEqual(off.storedAfterFirst);
    expect(off.closeAuditCount).toBe(1);
    // Result immutable: no further ballots, certified result unchanged.
    expect(off.castAfterClose).toEqual({ code: "VOTE_NOT_OPEN", httpStatus: 409 });
    expect(off.certifiedAfter).toEqual(off.first);
    // Frozen electorate.
    expect(off.intruderCast).toEqual({
      code: "VOTER_NOT_IN_ELECTORATE",
      httpStatus: 403,
    });
    expect(off.addedSeatCast).toEqual({
      code: "VOTER_NOT_IN_ELECTORATE",
      httpStatus: 403,
    });
    expect(off.storedElectorate).toHaveLength(3);
    expect(off.storedElectorate[0].uid).toBe("gov-1");
  });

  it("integer threshold math outcomes are identical on both backends", async () => {
    setMode("off");
    const off = runThresholdTable();
    setMode("on");
    const on = runThresholdTable();
    expect(on).toEqual(off);
    const byName = new Map(off.map((c) => [c.name, c.result.passed]));
    expect(byName.get("refusal 5/9")).toBe(false);
    expect(byName.get("refusal 6/9 (exact 2/3 boundary)")).toBe(true);
    expect(byName.get("refusal 2/3 of 3 (exact equality)")).toBe(true);
    expect(byName.get("expel 3/6")).toBe(false);
    expect(byName.get("expel 4/6 (exact 2/3 boundary)")).toBe(true);
    expect(byName.get("cooption 4/9")).toBe(false);
    expect(byName.get("cooption 5/9 (floor(9/2)+1)")).toBe(true);
    expect(byName.get("cooption 4/8")).toBe(false);
    expect(byName.get("cooption 5/8 (floor(8/2)+1)")).toBe(true);
    expect(byName.get("governor_removal 4/7")).toBe(true);
    expect(byName.get("strike3 tie fails")).toBe(false);
    expect(byName.get("strike3 4-3")).toBe(true);
    expect(byName.get("strike3 quorum short (4 participating)")).toBe(false);
    expect(byName.get("strike3 quorum met by abstains")).toBe(true);
  });
});
