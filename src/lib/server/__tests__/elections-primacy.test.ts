/**
 * @jest-environment node
 *
 * ELECTIONS WRITE PRIMACY suite (cutover program, Option A).
 *
 * Pins the SUPA_PRIMARY=elections behaviour (isSupaPrimary gates on
 * the token being in BOTH SUPA_SURFACES and SUPA_PRIMARY):
 *
 *   ON — castBallot is exactly ONE tx() call to
 *        tx_elections_cast_ballot (call-shape pin below); the TS
 *        layer performs ZERO adapter doc writes and ZERO Firestore
 *        writes for the cast. The Postgres function (simulated here
 *        by FakeTxAdapter, which implements the SQL file's stated
 *        semantics against the same stores) applies marker claim ->
 *        conditional token redemption -> ballot -> counters inside
 *        one transaction.
 *   ON — per-store write counting, RE-PINNED DELIBERATELY (step-17
 *        pattern): the F3 atomicity suite counts the sequential
 *        path's seam writes; on the primary path those counts are
 *        zero BY DESIGN and the effects land inside the tx instead.
 *        Two deliberate verdict changes vs the sequential path are
 *        pinned with comments where they occur: an idempotent
 *        replay of an applied cast reads already_cast 409 (the tx
 *        template's replay short-circuit), not bad_token 401.
 *   ON — a tx() failure that is not SupaUnavailableError surfaces
 *        SupaCastPrimaryError with NO Firestore fallback (F3);
 *        pre-write unavailability (no tx adapter, or
 *        SupaUnavailableError) falls back to the Firestore
 *        transaction as a whole, exactly once.
 *   ON — plain seam writes (election doc create, AGM create) whose
 *        Supabase write fails throw SupaPrimaryWriteError and write
 *        NOTHING to Firestore; with primacy OFF the same failure
 *        falls back byte-identically (control case).
 *   ON — voter-roll hash parity re-proven on the primary path
 *        against the literal-pinned contract-2 hash.
 *   ON — ELECTIONS_ENABLED remains a separate closed gate: a
 *        mutating ballot route still 503s with it off.
 *   OFF — the tx adapter is never called; the sequential flipped
 *        path runs unchanged.
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
    error: "primacy test: unauthenticated",
  })),
}));

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-primacy-0123456789";

import { NextRequest } from "next/server";
import {
  createFakeDb,
  setFakeNow,
  FakeTimestamp,
} from "./helpers/fake-firestore";
import {
  createDefaultPorts,
  ElectionError,
  type ElectionPorts,
  type FullMemberRecord,
} from "../election-ports";
import {
  createElection,
  publishTimetable,
  transitionElection,
} from "../elections";
import { buildRoll, freezeRoll } from "../election-roll";
import {
  submitNomination,
  decideNomination,
  certifyCandidates,
} from "../election-nominations";
import {
  issueBallotToken,
  castBallot,
  SupaCastPrimaryError,
} from "../election-ballot";
import { getElectionOrThrow, millisOf } from "../election-db";
import { hashBallotToken, castMarkerId } from "@/lib/elections/anonymity";
import { SupaUnavailableError } from "@/lib/supa/adapter";
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
} from "../election-supa";
import {
  __setCastTxAdapterForTests,
  castIdempotencyKey,
  type CastTxAdapter,
} from "../election-cast-primary";
import {
  SupaPrimaryWriteError,
} from "../supa-primary";
import { createAgm } from "../agm";
import {
  __setAgmSupaAdapterForTests,
  type AgmSupaAdapter,
} from "../agm-domain-supa";
import { POST as ballotPOST } from "@/app/api/elections/[electionId]/ballot/route";

type AnyRec = Record<string, unknown>;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Fake domain adapter (G2 seam): plain doc surface + write counting.
// The tx simulation below writes DIRECTLY into this store's maps —
// that models Postgres applying the tx function's statements; the
// adapter's own writeLog therefore counts only TS-layer writes.
// ---------------------------------------------------------------------------

class FakeDomainAdapter implements ElectionSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  readonly writeLog: Array<{ op: string; path: string; id: string }> = [];
  failWrites = false;

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
    if (this.failWrites) throw new Error("fake domain: simulated write failure");
    this.bucket(path).set(id, jsonClone(data));
    this.writeLog.push({ op: "setDoc", path, id });
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    if (this.failWrites) throw new Error("fake domain: simulated write failure");
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake domain: updateDoc missing ${path}/${id}`);
    const next = { ...existing, ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    this.writeLog.push({ op: "updateDoc", path, id });
    return { id, ...jsonClone(next) };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
    if (this.failWrites) throw new Error("fake domain: simulated write failure");
    this.bucket(path).delete(id);
    this.writeLog.push({ op: "deleteDoc", path, id });
  }

  docsAt(path: string): Map<string, SupaDocData> {
    return this.store.get(path) ?? new Map();
  }

  /** The LIVE bucket (created if absent) — the tx simulation's
   *  handle on the simulated Postgres tables. */
  pgBucket(path: string): Map<string, SupaDocData> {
    return this.bucket(path);
  }
}

/** G1 core adapter fake (same shape as the contracts suite's). */
class FakeCoreAdapter {
  store = new Map<string, AnyRec>();

  private key(collection: string, id: string) {
    return `${collection}/${id}`;
  }
  seed(collection: string, id: string, data: AnyRec) {
    this.store.set(this.key(collection, id), { ...data });
  }
  async getDoc(collection: string, id: string) {
    const data = this.store.get(this.key(collection, id));
    return data ? { id, ...jsonClone(data) } : null;
  }
  async listDocs(collection: string) {
    const prefix = `${collection}/`;
    const out: Array<AnyRec> = [];
    for (const [k, data] of this.store.entries()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({ id: rest, ...jsonClone(data) });
    }
    return out;
  }
  async countDocs(collection: string) {
    return (await this.listDocs(collection)).length;
  }
  async setDoc(collection: string, id: string, data: AnyRec) {
    this.store.set(this.key(collection, id), jsonClone(data));
    return { id, ...jsonClone(data) };
  }
  async updateDoc(collection: string, id: string, data: AnyRec) {
    const existing = this.store.get(this.key(collection, id));
    if (!existing) throw new Error(`updateDoc on missing ${collection}/${id}`);
    const next = { ...existing, ...jsonClone(data) };
    this.store.set(this.key(collection, id), next);
    return { id, ...next };
  }
  async deleteDoc(collection: string, id: string) {
    this.store.delete(this.key(collection, id));
  }
}

// ---------------------------------------------------------------------------
// Fake tx adapter: implements tx_elections_cast_ballot's SQL
// semantics (see src/lib/supa/sql/tx_elections_cast_ballot.sql) over
// the domain fake's stores, and records every call for shape pins.
// ---------------------------------------------------------------------------

interface TxCall {
  fn: string;
  args: AnyRec;
  options?: { idempotencyKey?: string };
}

class FakeTxAdapter implements CastTxAdapter {
  readonly calls: TxCall[] = [];
  /** key -> recorded result; the SQL stores ONLY {applied, duplicate}. */
  readonly idempotency = new Map<string, { applied: boolean; duplicate: boolean }>();
  failMode: "none" | "throw" | "unavailable" = "none";

  constructor(private readonly domain: FakeDomainAdapter) {}

  async tx<T = unknown>(
    fn: string,
    args: AnyRec = {},
    options?: { idempotencyKey?: string },
  ): Promise<T> {
    this.calls.push({ fn, args: jsonClone(args), options: jsonClone(options) });
    if (this.failMode === "throw") {
      throw new Error("fake tx: simulated transport failure mid-call");
    }
    if (this.failMode === "unavailable") {
      throw new SupaUnavailableError();
    }
    const out = this.apply(args, options?.idempotencyKey);
    return out as T;
  }

  private apply(args: AnyRec, key?: string) {
    const reject = (reason: string) => [
      { applied: false, duplicate: false, reason },
    ];
    if (key && this.idempotency.has(key)) {
      return [{ applied: false, duplicate: true, reason: "already_cast" }];
    }
    const electionId = args.p_election_id as string;
    const parent = `elections/${electionId}`;
    const election = this.domain.docsAt("elections").get(electionId);
    if (!election) return reject("election_not_found");
    const now = Date.parse(args.p_now as string);
    const tokenHash = args.p_token_hash as string;
    const tokens = this.domain.pgBucket(`${parent}/eligibility_tokens`);
    const token = tokens.get(tokenHash);
    if (!token) return reject("bad_token");
    if (token.redeemedAt != null) return reject("bad_token");
    if (now > Date.parse(token.expiresAt as string)) return reject("poll_closed");
    const tt = election.timetable as AnyRec;
    if (
      election.status !== "poll_open" ||
      now < Date.parse(tt.pollOpenAt as string) ||
      now > Date.parse(tt.pollCloseAt as string)
    ) {
      return reject("poll_closed");
    }
    const markers = this.domain.pgBucket(`${parent}/cast_markers`);
    const markerId = args.p_marker_id as string;
    if (markers.has(markerId)) return reject("already_cast");
    const ballot = args.p_ballot as AnyRec;
    const choices = (ballot.choices as string[]) ?? [];
    const certified = new Set(args.p_certified_candidate_uids as string[]);
    if (
      choices.length > (args.p_seats as number) ||
      new Set(choices).size !== choices.length ||
      !choices.every((c) => certified.has(c))
    ) {
      return reject("invalid_choice");
    }
    // D1 claim, D2 conditional redemption, D3 ballot, D4 counters
    // re-derived from the election row's CURRENT counters (F2).
    markers.set(markerId, jsonClone(args.p_marker) as SupaDocData);
    tokens.set(tokenHash, {
      ...token,
      redeemedAt: args.p_now as string,
      redeemedDay: args.p_cast_day as string,
    });
    this.domain
      .pgBucket(`${parent}/ballots`)
      .set(args.p_ballot_id as string, jsonClone(ballot) as SupaDocData);
    const c = (election.counters ?? {}) as AnyRec;
    this.domain.pgBucket("elections").set(electionId, {
      ...election,
      counters: {
        ballotsCast: ((c.ballotsCast as number) ?? 0) + 1,
        markersCast: ((c.markersCast as number) ?? 0) + 1,
        tokensRedeemed: ((c.tokensRedeemed as number) ?? 0) + 1,
      },
    });
    if (key) this.idempotency.set(key, { applied: true, duplicate: false });
    return [{ applied: true, duplicate: false, reason: null }];
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (mirrors the atomicity suite's setup)
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

function toSupaShape(v: unknown): unknown {
  if (v instanceof FakeTimestamp) return new Date(v.toMillis()).toISOString();
  if (Array.isArray(v)) return v.map(toSupaShape);
  if (v !== null && typeof v === "object") {
    const out: AnyRec = {};
    for (const [k, val] of Object.entries(v as AnyRec)) out[k] = toSupaShape(val);
    return out;
  }
  return v;
}

async function setupLifecycle(domain: FakeDomainAdapter) {
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
  const fsElectionData = db._dump().get(`elections/${electionId}`) as AnyRec;
  await domain.setDoc(
    "elections",
    electionId,
    toSupaShape(fsElectionData) as SupaDocData,
  );
  return { db, ports, electionId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fsSnapshot(db: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of db._dump().entries()) out[k] = JSON.stringify(v);
  return out}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fsSubCount(db: any, electionId: string, sub: string): number {
  const prefix = `elections/${electionId}/${sub}/`;
  return [...db._dump().keys()].filter((k: string) => k.startsWith(prefix)).length;
}

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------

describe("elections WRITE PRIMACY (SUPA_PRIMARY=elections)", () => {
  const saved = {
    surfaces: process.env.SUPA_SURFACES,
    primary: process.env.SUPA_PRIMARY,
    enabled: process.env.ELECTIONS_ENABLED,
  };
  let domain: FakeDomainAdapter;
  let tx: FakeTxAdapter;

  beforeEach(() => {
    process.env.SUPA_SURFACES = "elections";
    delete process.env.SUPA_PRIMARY;
    domain = new FakeDomainAdapter();
    tx = new FakeTxAdapter(domain);
    __setElectionSupaAdapterForTests(domain);
    __setCastTxAdapterForTests(tx);
    registerElectionSupaAdapter(null);
  });

  afterEach(() => {
    __setElectionSupaAdapterForTests(undefined);
    __setCastTxAdapterForTests(undefined);
    __setAgmSupaAdapterForTests(undefined);
    resetElectionSupaAdapter();
    for (const [k, v] of [
      ["SUPA_SURFACES", saved.surfaces],
      ["SUPA_PRIMARY", saved.primary],
      ["ELECTIONS_ENABLED", saved.enabled],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function primaryOn() {
    process.env.SUPA_PRIMARY = "elections";
  }

  it("ON cast: exactly ONE tx call, zero TS-layer adapter writes, zero Firestore writes; effects land inside the tx with F2 counters re-derived (7/7/7 -> 8/8/8)", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    // Divergent counters (F2 model): Supa election doc 7/7/7,
    // Firestore election doc 0/0/0.
    await domain.updateDoc("elections", electionId, {
      counters: { ballotsCast: 7, markersCast: 7, tokensRedeemed: 7 },
    });
    await db.collection("elections").doc(electionId).update({
      counters: { ballotsCast: 0, markersCast: 0, tokensRedeemed: 0 },
    });

    primaryOn();
    domain.writeLog.length = 0;
    const fsBefore = fsSnapshot(db);

    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast).toEqual({ recorded: true, castDay: "2026-12-31" });

    // Call shape: ONE call, the conventional function name.
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0].fn).toBe("tx_elections_cast_ballot");
    // Per-store counts, re-pinned for primacy: the TS layer wrote
    // NOTHING through either adapter and NOTHING to Firestore; the
    // sequential path's seam writes (marker/redemption/ballot/
    // counters) all happened inside the single tx.
    expect(domain.writeLog).toHaveLength(0);
    expect(fsSnapshot(db)).toEqual(fsBefore);
    // Effects in the (simulated) Postgres state:
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    expect(domain.docsAt(`elections/${electionId}/cast_markers`).size).toBe(1);
    const tokenHash = hashBallotToken(token, electionId);
    expect(
      domain.docsAt(`elections/${electionId}/eligibility_tokens`).get(tokenHash)
        ?.redeemedAt,
    ).not.toBeNull();
    // F2: counters re-derived from the Supa doc's current 7/7/7.
    expect(domain.docsAt("elections").get(electionId)?.counters).toEqual({
      ballotsCast: 8,
      markersCast: 8,
      tokensRedeemed: 8,
    });
    // Firestore subcollections stay empty.
    expect(fsSubCount(db, electionId, "ballots")).toBe(0);
    expect(fsSubCount(db, electionId, "cast_markers")).toBe(0);
  });

  it("ON cast call shape + ANONYMITY pin: args carry no uid, no plaintext token, no voter->choice linkage; the idempotency record stores ONLY {applied, duplicate}", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    primaryOn();

    await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );

    expect(tx.calls).toHaveLength(1);
    const { args, options } = tx.calls[0];
    // Exact argument names (the SQL function's signature).
    expect(Object.keys(args).sort()).toEqual([
      "p_ballot",
      "p_ballot_id",
      "p_cast_day",
      "p_certified_candidate_uids",
      "p_election_id",
      "p_marker",
      "p_marker_id",
      "p_now",
      "p_seats",
      "p_token_hash",
    ]);
    // Idempotency: deterministic key via tx options, foundation form.
    expect(options).toEqual({
      idempotencyKey: castIdempotencyKey(electionId, "v1"),
    });
    expect(options?.idempotencyKey).toBe(`ballot:${electionId}:v1`);

    // The plaintext token and the uid appear NOWHERE in the args:
    // the token travels only as its hash, the voter only as the
    // HMAC marker id (and inside the mandated idempotency key).
    const argsJson = JSON.stringify(args);
    expect(argsJson).not.toContain(token);
    expect(argsJson).not.toContain('"v1"');
    expect(args.p_token_hash).toBe(hashBallotToken(token, electionId));
    expect(args.p_marker_id).toBe(castMarkerId(electionId, "v1"));

    // Ballot argument: EXACTLY the anonymous payload; choices live
    // only here, and nothing here names the voter, token, or marker.
    const ballot = args.p_ballot as AnyRec;
    expect(Object.keys(ballot).sort()).toEqual([
      "castDay",
      "choices",
      "electionId",
      "isBlank",
    ]);
    expect(ballot.choices).toEqual(["cand"]);
    const ballotJson = JSON.stringify(ballot);
    expect(ballotJson).not.toContain("v1");
    expect(ballotJson).not.toContain(token);
    expect(ballotJson).not.toContain(args.p_marker_id as string);
    expect(ballotJson).not.toContain(args.p_ballot_id as string);

    // Marker argument: exactly the Firestore marker payload.
    const marker = args.p_marker as AnyRec;
    expect(Object.keys(marker).sort()).toEqual([
      "castDay",
      "electionId",
      "pollWindow",
    ]);
    expect(JSON.stringify(marker)).not.toContain("cand");

    // The idempotency key links the voter to the OPERATION only:
    // it contains no choice, no ballot id, no token (plain or hash).
    const key = options?.idempotencyKey as string;
    expect(key).not.toContain("cand");
    expect(key).not.toContain(token);
    expect(key).not.toContain(args.p_ballot_id as string);
    expect(key).not.toContain(args.p_token_hash as string);

    // The recorded idempotency result stores ONLY the outcome.
    const recorded = tx.idempotency.get(key);
    expect(recorded).toEqual({ applied: true, duplicate: false });
    expect(Object.keys(recorded ?? {}).sort()).toEqual([
      "applied",
      "duplicate",
    ]);
    expect(JSON.stringify(recorded)).not.toContain("cand");
  });

  it("ON replay: the same cast re-presented resolves through the idempotency record as already_cast 409, still exactly one ballot (deliberate re-pin: the sequential path's token-reuse verdict is bad_token; the tx template's replay short-circuit governs primacy)", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    primaryOn();

    const first = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(first.recorded).toBe(true);

    const err = await captureError(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
    );
    expect(err).toBeInstanceOf(ElectionError);
    expect(err).toMatchObject({ code: "already_cast", httpStatus: 409 });
    expect(tx.calls).toHaveLength(2);
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    expect(domain.docsAt("elections").get(electionId)?.counters).toEqual({
      ballotsCast: 1,
      markersCast: 1,
      tokensRedeemed: 1,
    });
  });

  it("ON business rejections map to the F3 codes: bad_token 401 / poll_closed 410 / invalid_choice 422, with zero ballots and zero Firestore writes", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    primaryOn();
    const fsBefore = fsSnapshot(db);

    const seq: Array<{ code: string; httpStatus: number }> = [];
    const record = async (p: Promise<unknown>) => {
      const err = (await captureError(p)) as {
        code?: string;
        httpStatus?: number;
      } | null;
      seq.push({ code: err?.code ?? "NO_ERROR", httpStatus: err?.httpStatus ?? 0 });
    };
    await record(
      castBallot(db, electionId, { uid: "v1", token: "unknown-token", choices: ["cand"] }, T_POLL),
    );
    await record(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_CREATE),
    );
    await record(
      castBallot(db, electionId, { uid: "v1", token, choices: ["not-a-candidate"] }, T_POLL),
    );
    expect(seq).toEqual([
      { code: "bad_token", httpStatus: 401 },
      { code: "poll_closed", httpStatus: 410 },
      { code: "invalid_choice", httpStatus: 422 },
    ]);
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
    expect(fsSnapshot(db)).toEqual(fsBefore);
  });

  it("ON tx transport failure: SupaCastPrimaryError (infrastructure, no domain code), NO Firestore fallback, no ballot anywhere", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    primaryOn();
    tx.failMode = "throw";
    const fsBefore = fsSnapshot(db);

    const err = await captureError(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
    );
    expect(err).toBeInstanceOf(SupaCastPrimaryError);
    expect(err).not.toBeInstanceOf(ElectionError);
    expect((err as { code?: string }).code).toBeUndefined();
    expect(fsSnapshot(db)).toEqual(fsBefore);
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
    expect(domain.docsAt(`elections/${electionId}/cast_markers`).size).toBe(0);
  });

  it("ON pre-write unavailability (no tx adapter): whole cast falls back to Firestore exactly once; the sequential Supa path is NOT used", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    // Mirror the token onto Firestore, as the whole-cast fallback
    // requires (same model as the atomicity suite's pre-write test).
    const election = await getElectionOrThrow(db, electionId);
    const tokenHash = hashBallotToken(token, electionId);
    await db
      .collection("elections")
      .doc(electionId)
      .collection("eligibility_tokens")
      .doc(tokenHash)
      .set({
        electionId,
        issuedAt: FakeTimestamp.fromMillis(T_POLL),
        expiresAt: FakeTimestamp.fromMillis(millisOf(election.timetable.pollCloseAt)),
        redeemedAt: null,
        redeemedDay: null,
      });

    primaryOn();
    __setCastTxAdapterForTests(null);
    domain.writeLog.length = 0;

    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);
    expect(tx.calls).toHaveLength(0);
    // Exactly once, all on Firestore; zero Supa seam writes.
    expect(fsSubCount(db, electionId, "ballots")).toBe(1);
    expect(fsSubCount(db, electionId, "cast_markers")).toBe(1);
    expect(domain.writeLog).toHaveLength(0);
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
    const fsElection = await getElectionOrThrow(db, electionId);
    expect(fsElection.counters).toEqual({
      ballotsCast: 1,
      markersCast: 1,
      tokensRedeemed: 1,
    });
  });

  it("ON pre-write unavailability (SupaUnavailableError from tx): falls back to Firestore as a whole", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    const election = await getElectionOrThrow(db, electionId);
    const tokenHash = hashBallotToken(token, electionId);
    await db
      .collection("elections")
      .doc(electionId)
      .collection("eligibility_tokens")
      .doc(tokenHash)
      .set({
        electionId,
        issuedAt: FakeTimestamp.fromMillis(T_POLL),
        expiresAt: FakeTimestamp.fromMillis(millisOf(election.timetable.pollCloseAt)),
        redeemedAt: null,
        redeemedDay: null,
      });
    primaryOn();
    tx.failMode = "unavailable";

    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);
    expect(fsSubCount(db, electionId, "ballots")).toBe(1);
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
  });

  it("OFF control: with SUPA_PRIMARY unset the tx adapter is NEVER called and the sequential flipped cast runs unchanged", async () => {
    const { db, electionId } = await setupLifecycle(domain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    // SUPA_PRIMARY stays unset (beforeEach): flipped, not primary.
    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);
    expect(tx.calls).toHaveLength(0);
    expect(domain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    expect(fsSubCount(db, electionId, "ballots")).toBe(0);
  });

  it("ON roll-hash parity: build + freeze under primacy produces the literal contract-2 roll hash", async () => {
    primaryOn();
    // Standard flipped config (as contract 2): the election doc
    // lives on Firestore (core seam unconfigured — under primacy an
    // unconfigured adapter is a pre-write unavailability and the
    // doc writers fall back, exactly as the cast does), while the
    // roll entries write through the domain seam under primacy.
    const db = createFakeDb();
    setFakeNow(T_CREATE);
    await db.collection("roles").doc(RO).set({ role: "returning_officer" });
    const fixture: FullMemberRecord[] = [
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
        fullMemberSinceMillis: Date.UTC(2025, 0, 1),
        registerEntryDateMillis: Date.UTC(2025, 0, 1),
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
    const ports = fixturePorts(db, fixture);
    const election = await createElection(
      db,
      ports,
      {
        actorUid: FOUNDER,
        actorIsFounder: true,
        title: "Roll Hash Primacy Election",
        electionDayMillis: DAY,
        returningOfficerUid: RO,
        returningOfficerName: "R Officer",
      },
      T_CREATE,
    );
    await buildRoll(db, ports, election.id, RO, T_CREATE);
    const frozen = await freezeRoll(db, election.id, RO, T_CREATE);
    expect(frozen.rollHash).toBe(
      "2d1bb639299d6431763408c7c91ae2f7efe7371ddbef3ab6e6f940f2865f3c2b",
    );
  });

  it("ON plain-write inversion: a failing Supabase election-doc write throws SupaPrimaryWriteError and writes NOTHING to Firestore; OFF the same failure falls back (control)", async () => {
    // Setup per run: an election created on Firestore (core seam
    // unconfigured), then mirrored into a core fake whose WRITES
    // fail but whose reads serve the mirrored doc — the flipped
    // configuration with a broken primary writer.
    const runPublish = async (primary: boolean) => {
      // Each run starts from the standard config (core seam
      // unconfigured) and creates its election BEFORE the failing
      // core fake is registered; the publish then runs under the
      // requested primacy state.
      registerElectionSupaAdapter(null);
      if (primary) process.env.SUPA_PRIMARY = "elections";
      else delete process.env.SUPA_PRIMARY;
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
          title: "Primacy Publish Election",
          electionDayMillis: DAY,
          returningOfficerUid: RO,
          returningOfficerName: "R Officer",
        },
        T_CREATE,
      );
      const electionId = election.id;
      const core = new FakeCoreAdapter();
      const fsData = db._dump().get(`elections/${electionId}`) as AnyRec;
      core.seed("elections", electionId, toSupaShape(fsData) as AnyRec);
      core.setDoc = async () => {
        throw new Error("fake core: simulated write failure");
      };
      core.updateDoc = async () => {
        throw new Error("fake core: simulated write failure");
      };
      registerElectionSupaAdapter(
        core as unknown as Parameters<typeof registerElectionSupaAdapter>[0],
      );
      const err = await captureError(
        publishTimetable(db, electionId, RO, {}, T_CREATE),
      );
      const fsStatus = (
        db._dump().get(`elections/${electionId}`) as AnyRec
      )?.status;
      return { err, fsStatus };
    };

    const on = await runPublish(true);
    expect(on.err).toBeInstanceOf(SupaPrimaryWriteError);
    expect((on.err as { code?: string }).code).toBeUndefined();
    // The failed primary write did NOT become a Firestore write:
    // the Firestore doc is still a draft.
    expect(on.fsStatus).toBe("draft");

    const off = await runPublish(false);
    expect(off.err).toBeNull();
    // Control: primacy OFF, the identical seam failure falls back
    // and the Firestore doc is updated, byte-identical to today.
    expect(off.fsStatus).toBe("timetable_published");
  });

  it("ON plain-write inversion (AGM): a failing AGM seam write throws SupaPrimaryWriteError and no agm_events doc lands in Firestore", async () => {
    const failingAgm: AgmSupaAdapter = {
      getDoc: async () => null,
      listDocs: async () => [],
      setDoc: async () => {
        throw new Error("fake agm: simulated write failure");
      },
      updateDoc: async () => {
        throw new Error("fake agm: simulated write failure");
      },
      deleteDoc: async () => undefined,
    };
    __setAgmSupaAdapterForTests(failingAgm);
    primaryOn();

    const db = createFakeDb();
    setFakeNow(T_CREATE);
    const ports = fixturePorts(db);
    const err = await captureError(
      createAgm(
        db,
        ports,
        {
          actorUid: "ngs-uid",
          actorMayConvene: true,
          year: 2026,
          scheduledAtMillis: DAY,
          locationOrLink: "IST BIC Room 131 + online",
        },
        T_CREATE,
      ),
    );
    expect(err).toBeInstanceOf(SupaPrimaryWriteError);
    const agmDocs = [...db._dump().keys()].filter((k: string) =>
      k.startsWith("agm_events/"),
    );
    expect(agmDocs).toHaveLength(0);
  });

  it("ON + ELECTIONS_ENABLED off: the ballot route still 503s elections_disabled (the gate is separate and untouched)", async () => {
    primaryOn();
    delete process.env.ELECTIONS_ENABLED;
    const res = await ballotPOST(
      new NextRequest("http://x/api/elections/e1/ballot", {
        method: "POST",
        body: JSON.stringify({ token: "t", choices: [] }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ electionId: "e1" }) },
    );
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("elections_disabled");
    expect(tx.calls).toHaveLength(0);
  });
});
