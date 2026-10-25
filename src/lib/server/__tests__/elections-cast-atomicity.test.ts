/**
 * @jest-environment node
 *
 * F2/F3 — CAST ATOMICITY suite (BUILDOUT_AUDIT §5, flip-blockers
 * F2 + F3). These tests DEFINE the flip bar for castBallot on the
 * Supa path; they are written against the briefed fixed semantics:
 *
 *   - Whole-operation fallback: a Supa infrastructure failure may
 *     fall back to the Firestore transaction ONLY if no Supa write
 *     has landed yet. Once any write has landed, the cast must fail
 *     loudly with a NON-domain (infrastructure) error — never split
 *     ballot / marker / token / counters across two backends, and
 *     never double-persist.
 *   - A token-READ bridge error is infrastructure, not bad_token:
 *     pre-write it falls back (and the Firestore path's own verdict
 *     is authoritative); it must never be converted into a 401.
 *   - Exactly-once under concurrency: the marker claim is an
 *     atomic insert-if-absent FIRST, token redemption is a
 *     conditional update SECOND, the ballot write THIRD, counters
 *     LAST. Same voter+token raced -> one ballot, loser
 *     already_cast 409. Same token, different voter raced -> one
 *     ballot, loser bad_token 401 (conditional redemption decides).
 *   - Counters live on the CASTING backend: they are re-derived
 *     from the Supa election doc's current state at write time
 *     (never from a stale pre-cast snapshot, never written to the
 *     Firestore election doc on a flipped cast), and concurrent
 *     casts lose no increments.
 *
 * The existing contract suite's mid-cast test counts ballots across
 * BOTH stores combined, which masks exactly the split this suite
 * pins: here Firestore writes are counted SEPARATELY (full fake-db
 * dump comparison before/after the cast).
 *
 * Fakes: the domain fake implements the standard adapter surface
 * PLUS the atomic seam primitives (insert-if-absent, conditional
 * update, increment) under their natural names, and a Proxy
 * fallback that implements any other atomic-primitive name the
 * implementation chooses, with the same semantics. Failure
 * injection is per operation + path, armed AFTER setup so only the
 * cast under test is affected.
 *
 * Zero live reads: fake Firestore + in-memory fake adapters only.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-atomicity-0123456789";

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
import { issueBallotToken, castBallot } from "../election-ballot";
import { getElectionOrThrow, millisOf } from "../election-db";
import { hashBallotToken } from "@/lib/elections/anonymity";
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

// ---------------------------------------------------------------------------
// Condition evaluation for conditional-update primitives
// ---------------------------------------------------------------------------

type AnyRec = Record<string, unknown>;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fieldEquals(actual: unknown, expected: unknown): boolean {
  const a = actual === undefined ? null : actual;
  const e = expected === undefined ? null : expected;
  return a === e;
}

function evalClause(data: AnyRec, clause: unknown): boolean {
  if (Array.isArray(clause)) {
    const [field, op, value] = clause as [string, string, unknown];
    const actual = data[field];
    switch (op) {
      case "==":
        return fieldEquals(actual, value);
      case "!=":
        return !fieldEquals(actual, value);
      case "<":
        return (actual as number) < (value as number);
      case "<=":
        return (actual as number) <= (value as number);
      case ">":
        return (actual as number) > (value as number);
      case ">=":
        return (actual as number) >= (value as number);
      case "in":
        return Array.isArray(value) && value.some((v) => fieldEquals(actual, v));
      default:
        throw new Error(`fake supa: unsupported condition op ${op}`);
    }
  }
  if (clause !== null && typeof clause === "object") {
    const c = clause as AnyRec;
    if (typeof c.field === "string") {
      return evalClause(data, [c.field, (c.op as string) ?? "==", c.value]);
    }
    // Plain { field: expected } map.
    return Object.entries(c).every(([f, v]) => fieldEquals(data[f], v));
  }
  return true;
}

function matchesCondition(data: AnyRec, condition: unknown): boolean {
  if (condition === null || condition === undefined) return true;
  if (typeof condition === "function") {
    return Boolean((condition as (d: AnyRec) => unknown)(jsonClone(data)));
  }
  if (Array.isArray(condition)) return condition.every((c) => evalClause(data, c));
  return evalClause(data, condition);
}

function applyUpdates(existing: AnyRec, updates: AnyRec): AnyRec {
  const next: AnyRec = { ...jsonClone(existing) };
  for (const [key, value] of Object.entries(jsonClone(updates))) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let cur: AnyRec = next;
      for (const p of parts.slice(0, -1)) {
        const child = cur[p];
        cur[p] =
          child !== null && typeof child === "object" && !Array.isArray(child)
            ? { ...(child as AnyRec) }
            : {};
        cur = cur[p] as AnyRec;
      }
      cur[parts[parts.length - 1]] = value;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function applyIncrements(existing: AnyRec, deltas: AnyRec): AnyRec {
  const next: AnyRec = jsonClone(existing);
  const walk = (target: AnyRec, d: AnyRec) => {
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "number") {
        target[k] = (typeof target[k] === "number" ? (target[k] as number) : 0) + v;
      } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const child =
          target[k] !== null && typeof target[k] === "object"
            ? (target[k] as AnyRec)
            : {};
        target[k] = child;
        walk(child, v as AnyRec);
      } else {
        target[k] = v;
      }
    }
  };
  walk(next, deltas);
  return next;
}

// ---------------------------------------------------------------------------
// Fake domain adapter (G2 seam) with failure injection + atomic primitives
// ---------------------------------------------------------------------------

type OpPredicate = (op: string, path: string, id: string) => boolean;

class FakeDomainAdapter implements ElectionSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  readonly writeLog: Array<{ op: string; path: string; id: string }> = [];
  failRead: OpPredicate | null = null;
  failWrite: OpPredicate | null = null;

  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }

  private guardRead(op: string, path: string, id: string): void {
    if (this.failRead?.(op, path, id)) {
      throw new Error(`fake supa: simulated infra error on ${op} ${path}/${id}`);
    }
  }

  private guardWrite(op: string, path: string, id: string): void {
    if (this.failWrite?.(op, path, id)) {
      throw new Error(`fake supa: simulated infra error on ${op} ${path}/${id}`);
    }
  }

  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    this.guardRead("getDoc", path, id);
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }

  async listDocs(
    path: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
    this.guardRead("listDocs", path, "");
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

  async setDoc(
    path: string,
    id: string,
    data: SupaDocData,
    options?: AnyRec,
  ): Promise<SupaDoc> {
    this.guardWrite("setDoc", path, id);
    const bucket = this.bucket(path);
    const existing = bucket.get(id);
    if (
      existing &&
      options &&
      (options.ifAbsent === true ||
        options.createOnly === true ||
        options.onlyIfAbsent === true)
    ) {
      this.writeLog.push({ op: "setDocIfAbsent-conflict", path, id });
      return { id, ...jsonClone(existing) };
    }
    if (existing && options?.merge === true) {
      const merged = { ...existing, ...jsonClone(data) };
      bucket.set(id, merged);
      this.writeLog.push({ op: "setDoc", path, id });
      return { id, ...jsonClone(merged) };
    }
    bucket.set(id, jsonClone(data));
    this.writeLog.push({ op: "setDoc", path, id });
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    this.guardWrite("updateDoc", path, id);
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: updateDoc missing ${path}/${id}`);
    const next = applyUpdates(existing, updates);
    this.bucket(path).set(id, next as SupaDocData);
    this.writeLog.push({ op: "updateDoc", path, id });
    return { id, ...jsonClone(next) };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
    this.guardWrite("deleteDoc", path, id);
    this.bucket(path).delete(id);
    this.writeLog.push({ op: "deleteDoc", path, id });
  }

  /* -------- atomic primitives (insert-if-absent / conditional / increment)
   * Each body runs synchronously to completion once called, so the
   * check-and-write is atomic against other casts in the same tick
   * sequence — the semantics the real bridge gets from PostgREST
   * insert-ignore / conditional PATCH. Return convention: the doc on
   * success, null when the claim/condition did not hold. -------- */

  async setDocIfAbsent(
    path: string,
    id: string,
    data: SupaDocData,
  ): Promise<SupaDoc | null> {
    this.guardWrite("setDocIfAbsent", path, id);
    const bucket = this.bucket(path);
    if (bucket.has(id)) return null;
    bucket.set(id, jsonClone(data));
    this.writeLog.push({ op: "setDocIfAbsent", path, id });
    return { id, ...jsonClone(data) };
  }

  async insertDocIfAbsent(
    path: string,
    id: string,
    data: SupaDocData,
  ): Promise<SupaDoc | null> {
    return this.setDocIfAbsent(path, id, data);
  }

  async updateDocIf(
    path: string,
    id: string,
    updates: SupaDocData,
    condition?: unknown,
  ): Promise<SupaDoc | null> {
    this.guardWrite("updateDocIf", path, id);
    const existing = this.bucket(path).get(id);
    if (!existing) return null;
    if (!matchesCondition(existing, condition)) return null;
    const next = applyUpdates(existing, updates);
    this.bucket(path).set(id, next as SupaDocData);
    this.writeLog.push({ op: "updateDocIf", path, id });
    return { id, ...jsonClone(next) };
  }

  async conditionalUpdateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
    condition?: unknown,
  ): Promise<SupaDoc | null> {
    return this.updateDocIf(path, id, updates, condition);
  }

  async updateDocWhere(
    path: string,
    id: string,
    updates: SupaDocData,
    condition?: unknown,
  ): Promise<SupaDoc | null> {
    return this.updateDocIf(path, id, updates, condition);
  }

  async incrementDoc(
    path: string,
    id: string,
    deltas: AnyRec,
  ): Promise<SupaDoc> {
    this.guardWrite("incrementDoc", path, id);
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: incrementDoc missing ${path}/${id}`);
    const next = applyIncrements(existing, deltas);
    this.bucket(path).set(id, next as SupaDocData);
    this.writeLog.push({ op: "incrementDoc", path, id });
    return { id, ...jsonClone(next) };
  }

  /** Proxy fallback for any other atomic-primitive name. */
  async _generic(name: string, args: unknown[]): Promise<unknown> {
    // eslint-disable-next-line no-console
    console.warn(`[fake-domain-adapter] generic atomic primitive invoked: ${name}`);
    const [path, id] = args as [string, string];
    if (/increment/i.test(name)) {
      return this.incrementDoc(path, id, (args[2] ?? {}) as AnyRec);
    }
    if (/ifabsent|insertif|claim/i.test(name)) {
      return this.setDocIfAbsent(path, id, (args[2] ?? {}) as SupaDocData);
    }
    if (/update|redeem|patch/i.test(name)) {
      return this.updateDocIf(
        path,
        id,
        (args[2] ?? {}) as SupaDocData,
        args[3],
      );
    }
    throw new Error(`fake supa: unimplemented adapter method ${name}`);
  }

  docsAt(path: string): Map<string, SupaDocData> {
    return this.store.get(path) ?? new Map();
  }
}

/** G1 core adapter fake (election doc), same primitive superset. */
class FakeCoreAdapter implements CoreSupaAdapter {
  readonly store = new Map<string, AnyRec>();
  readonly writeLog: Array<{ op: string; collection: string; id: string }> = [];
  failWrites = false;

  private guardWrite(op: string, collection: string, id: string): void {
    if (this.failWrites) {
      throw new Error(`fake core: simulated infra error on ${op} ${collection}/${id}`);
    }
  }

  private key(collection: string, id: string) {
    return `${collection}/${id}`;
  }

  seed(collection: string, id: string, data: AnyRec) {
    this.store.set(this.key(collection, id), jsonClone(data));
  }

  raw(collection: string, id: string): AnyRec | undefined {
    const d = this.store.get(this.key(collection, id));
    return d ? jsonClone(d) : undefined;
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

  async countDocs(collection: string, where?: Array<[string, string, unknown]>) {
    const docs = await this.listDocs(collection);
    return docs.filter((d) =>
      (where ?? []).every(([f, , v]) => d[f] === v),
    ).length;
  }

  async setDoc(collection: string, id: string, data: AnyRec, options?: AnyRec) {
    this.guardWrite("setDoc", collection, id);
    const k = this.key(collection, id);
    const existing = this.store.get(k);
    if (
      existing &&
      options &&
      (options.ifAbsent === true || options.createOnly === true)
    ) {
      this.writeLog.push({ op: "setDocIfAbsent-conflict", collection, id });
      return { id, ...jsonClone(existing) };
    }
    const next =
      existing && options?.merge === true
        ? { ...existing, ...jsonClone(data) }
        : jsonClone(data);
    this.store.set(k, next);
    this.writeLog.push({ op: "setDoc", collection, id });
    return { id, ...jsonClone(next) };
  }

  async updateDoc(collection: string, id: string, data: AnyRec) {
    this.guardWrite("updateDoc", collection, id);
    const k = this.key(collection, id);
    const existing = this.store.get(k);
    if (!existing) throw new Error(`fake core: updateDoc missing ${collection}/${id}`);
    const next = applyUpdates(existing, data);
    this.store.set(k, next);
    this.writeLog.push({ op: "updateDoc", collection, id });
    return { id, ...jsonClone(next) };
  }

  async deleteDoc(collection: string, id: string) {
    this.store.delete(this.key(collection, id));
    this.writeLog.push({ op: "deleteDoc", collection, id });
  }

  async setDocIfAbsent(collection: string, id: string, data: AnyRec) {
    this.guardWrite("setDocIfAbsent", collection, id);
    const k = this.key(collection, id);
    if (this.store.has(k)) return null;
    this.store.set(k, jsonClone(data));
    this.writeLog.push({ op: "setDocIfAbsent", collection, id });
    return { id, ...jsonClone(data) };
  }

  async updateDocIf(
    collection: string,
    id: string,
    updates: AnyRec,
    condition?: unknown,
  ) {
    this.guardWrite("updateDocIf", collection, id);
    const k = this.key(collection, id);
    const existing = this.store.get(k);
    if (!existing) return null;
    if (!matchesCondition(existing, condition)) return null;
    const next = applyUpdates(existing, updates);
    this.store.set(k, next);
    this.writeLog.push({ op: "updateDocIf", collection, id });
    return { id, ...jsonClone(next) };
  }

  async incrementDoc(collection: string, id: string, deltas: AnyRec) {
    this.guardWrite("incrementDoc", collection, id);
    const k = this.key(collection, id);
    const existing = this.store.get(k);
    if (!existing) throw new Error(`fake core: incrementDoc missing ${collection}/${id}`);
    const next = applyIncrements(existing, deltas);
    this.store.set(k, next);
    this.writeLog.push({ op: "incrementDoc", collection, id });
    return { id, ...jsonClone(next) };
  }

  async _generic(name: string, args: unknown[]): Promise<unknown> {
    // eslint-disable-next-line no-console
    console.warn(`[fake-core-adapter] generic atomic primitive invoked: ${name}`);
    const [collection, id] = args as [string, string];
    if (/increment/i.test(name)) {
      return this.incrementDoc(collection, id, (args[2] ?? {}) as AnyRec);
    }
    if (/ifabsent|insertif|claim/i.test(name)) {
      return this.setDocIfAbsent(collection, id, (args[2] ?? {}) as AnyRec);
    }
    if (/update|redeem|patch/i.test(name)) {
      return this.updateDocIf(collection, id, (args[2] ?? {}) as AnyRec, args[3]);
    }
    throw new Error(`fake core: unimplemented adapter method ${name}`);
  }
}

/** Proxy: unknown adapter methods dispatch to the fake's _generic. */
function withGenericPrimitives<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string" && !(prop in t)) {
        if (prop === "then" || prop === "toJSON" || prop === "inspect") {
          return undefined;
        }
        return (...args: unknown[]) =>
          (t as { _generic: (n: string, a: unknown[]) => Promise<unknown> })._generic(
            prop,
            args,
          );
      }
      const v = Reflect.get(t, prop, t);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle (mirrors the contracts/domain suites; election doc on
// Firestore with the G1 core seam pinned unconfigured — the standard
// flipped-cast configuration — subcollections on the domain seam)
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

async function setupLifecycle(domain: FakeDomainAdapter) {
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
  // In production the G1 core seam and the domain seam resolve to the
  // SAME fs_elections table; the two test fakes are separate stores,
  // so mirror the finished election doc into the domain fake's
  // top-level "elections" bucket too (the counter step of the fixed
  // cast reads/writes the election doc through the domain seam).
  const fsElectionData = db._dump().get(`elections/${electionId}`) as AnyRec;
  await domain.setDoc(
    "elections",
    electionId,
    toSupaShape(fsElectionData) as SupaDocData,
  );
  return { db, ports, electionId };
}

/** Deep-convert a Firestore-shaped doc into the core fake's jsonb shape. */
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

/**
 * Mirror the Firestore election doc into the G1 core fake (its
 * flipped home) with DIVERGENT counters: Supa `supaCounters`,
 * Firestore 0/0/0. Returns nothing; register the core adapter
 * BEFORE calling this if the mirror must be the read source, or
 * after — seeding is direct on the fake either way.
 */
async function mirrorElectionDocToSupa(
  db: ReturnType<typeof createFakeDb>,
  electionId: string,
  core: FakeCoreAdapter,
  supaCounters: number,
  domain?: FakeDomainAdapter,
): Promise<void> {
  const fsElectionData = db._dump().get(`elections/${electionId}`) as AnyRec;
  core.seed("elections", electionId, toSupaShape(fsElectionData) as AnyRec);
  await core.updateDoc("elections", electionId, {
    counters: {
      ballotsCast: supaCounters,
      markersCast: supaCounters,
      tokensRedeemed: supaCounters,
    },
  });
  if (domain) {
    await domain.setDoc(
      "elections",
      electionId,
      toSupaShape(fsElectionData) as SupaDocData,
    );
    await domain.updateDoc("elections", electionId, {
      counters: {
        ballotsCast: supaCounters,
        markersCast: supaCounters,
        tokensRedeemed: supaCounters,
      },
    });
  }
  await db.collection("elections").doc(electionId).update({
    counters: { ballotsCast: 0, markersCast: 0, tokensRedeemed: 0 },
  });
}


/**
 * Harness glue for the two-fake artifact: in production the G1
 * core seam and the domain seam resolve to the SAME fs_elections
 * table, but the two test fakes keep separate stores. After a cast,
 * copy the election doc from whichever fake the cast's counter step
 * wrote into the other, so both read paths can be asserted against
 * the one logical Supa doc. A cast that wrote counters to NEITHER
 * fake (e.g. the old Firestore-direct write) syncs nothing and the
 * assertions below fail on both.
 */
function syncElectionFakes(
  core: FakeCoreAdapter,
  domain: FakeDomainAdapter,
  electionId: string,
): void {
  const coreDoc = core.raw("elections", electionId) as AnyRec | undefined;
  const domainDoc = domain.docsAt("elections").get(electionId) as
    | AnyRec
    | undefined;
  const coreCounters = (coreDoc?.counters as AnyRec | undefined)?.ballotsCast;
  const domainCounters = (domainDoc?.counters as AnyRec | undefined)
    ?.ballotsCast;
  if (domainDoc && domainCounters !== coreCounters) {
    if (
      typeof domainCounters === "number" &&
      typeof coreCounters === "number" &&
      domainCounters > coreCounters
    ) {
      core.seed("elections", electionId, domainDoc);
    } else if (
      coreDoc &&
      typeof coreCounters === "number" &&
      typeof domainCounters === "number" &&
      coreCounters > domainCounters
    ) {
      domain.store.set(
        "elections",
        new Map(domain.docsAt("elections")).set(electionId, coreDoc as SupaDocData),
      );
    }
  }
}

/** Full Firestore-side snapshot, for SEPARATE Firestore-write counting. */
function fsSnapshot(db: ReturnType<typeof createFakeDb>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of db._dump().entries()) out[k] = JSON.stringify(v);
  return out;
}

function fsSubcollectionCount(
  db: ReturnType<typeof createFakeDb>,
  electionId: string,
  sub: string,
): number {
  const prefix = `elections/${electionId}/${sub}/`;
  return [...db._dump().keys()].filter((k) => k.startsWith(prefix)).length;
}

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

function expectDomainError(err: unknown, code: string, httpStatus: number): void {
  expect(err).toBeInstanceOf(ElectionError);
  expect(err).toMatchObject({ code, httpStatus });
}

// ---------------------------------------------------------------------------

describe("F2/F3 castBallot atomicity on the Supa path", () => {
  const savedSurfaces = process.env.SUPA_SURFACES;
  let rawDomain: FakeDomainAdapter;
  let rawCore: FakeCoreAdapter;

  beforeEach(() => {
    process.env.SUPA_SURFACES = "elections";
    rawDomain = new FakeDomainAdapter();
    rawCore = new FakeCoreAdapter();
    __setElectionSupaAdapterForTests(
      withGenericPrimitives(rawDomain) as unknown as ElectionSupaAdapter,
    );
    // Standard configuration: G1 core seam pinned unconfigured, so
    // the election doc lives on Firestore except in the F2 test,
    // which mirrors it into the core fake explicitly.
    registerElectionSupaAdapter(null);
  });

  afterEach(() => {
    __setElectionSupaAdapterForTests(undefined);
    resetElectionSupaAdapter();
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it("(a) MID-CAST FAILURE: bridge fails AFTER the first Supa write lands -> non-domain error, ZERO Firestore writes, no split", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);

    // Fail the BALLOT write: with the briefed order (marker claim,
    // redemption, ballot, counters) at least one Supa write has
    // already landed when this failure fires.
    rawDomain.failWrite = (_op, path) => path.endsWith("/ballots");
    rawDomain.writeLog.length = 0;
    const fsBefore = fsSnapshot(db);

    const err = await captureError(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
    );

    // The cast REJECTS, and the error is infrastructure-class:
    // NOT an ElectionError (not bad_token, not already_cast, ...).
    expect(err).not.toBeNull();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ElectionError);
    expect((err as { code?: string }).code).toBeUndefined();

    // Proof the failure really was mid-cast: >= 1 Supa write landed.
    expect(rawDomain.writeLog.length).toBeGreaterThanOrEqual(1);

    // Single-backend consistency, counted SEPARATELY: the Firestore
    // fake received ZERO writes from this cast — no ballot, no
    // marker, no token update, no election-doc (counter) update.
    expect(fsSnapshot(db)).toEqual(fsBefore);
    expect(fsSubcollectionCount(db, electionId, "ballots")).toBe(0);
    expect(fsSubcollectionCount(db, electionId, "cast_markers")).toBe(0);
    // And no ballot was persisted on Supa either (its write failed).
    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
  });

  it("(a2) MID-CAST FAILURE at the COUNTER step (last write) -> non-domain error, ZERO Firestore writes, Supa counters unmoved", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);

    // Flipped configuration: the election doc lives in the core
    // fake (counters 7/7/7), Firestore's copy is a divergent 0/0/0
    // bystander. Counters are the LAST write of the cast.
    await mirrorElectionDocToSupa(db, electionId, rawCore, 7, rawDomain);
    registerElectionSupaAdapter(
      withGenericPrimitives(rawCore) as unknown as CoreSupaAdapter,
    );

    // Arm BOTH possible counter surfaces: the core seam (election
    // doc's flipped home) and a top-level "elections" write through
    // the domain adapter. The ballot/marker/redemption writes on
    // the domain seam's subcollection paths stay healthy, so the
    // failure fires only when the counter step is reached — after
    // earlier Supa writes have landed.
    rawCore.failWrites = true;
    rawDomain.failWrite = (_op, path) => path === "elections";
    rawDomain.writeLog.length = 0;
    const fsBefore = fsSnapshot(db);

    const err = await captureError(
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
    );

    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(ElectionError);
    // Mid-cast proof: the ballot write (step 3 of 4) landed on Supa.
    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    // No fallback: Firestore received zero writes from this cast,
    // and the Supa counters were not partially moved.
    expect(fsSnapshot(db)).toEqual(fsBefore);
    expect(rawCore.raw("elections", electionId)?.counters).toEqual({
      ballotsCast: 7,
      markersCast: 7,
      tokensRedeemed: 7,
    });
    expect(rawDomain.docsAt("elections").get(electionId)?.counters).toEqual({
      ballotsCast: 7,
      markersCast: 7,
      tokensRedeemed: 7,
    });
  });

  it("(b) PRE-WRITE FAILURE: token READ fails before any write -> whole cast falls back to Firestore exactly once and succeeds", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);

    // Mirror the issued token onto Firestore, as the fallback
    // transaction requires: the fallback is a WHOLE cast on
    // Firestore, so its token/marker/ballot/counters all land there.
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

    rawDomain.failRead = (op, path) =>
      op === "getDoc" && path.endsWith("/eligibility_tokens");
    rawDomain.writeLog.length = 0;

    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);

    // Exactly once, all on Firestore: one ballot, one marker, the
    // token redeemed, counters 1/1/1 on the Firestore election doc.
    expect(fsSubcollectionCount(db, electionId, "ballots")).toBe(1);
    expect(fsSubcollectionCount(db, electionId, "cast_markers")).toBe(1);
    const fsToken = await db
      .collection("elections")
      .doc(electionId)
      .collection("eligibility_tokens")
      .doc(tokenHash)
      .get();
    expect(fsToken.exists).toBe(true);
    expect((fsToken.data() as AnyRec).redeemedAt).not.toBeNull();
    const fsElection = await getElectionOrThrow(db, electionId);
    expect(fsElection.counters).toEqual({
      ballotsCast: 1,
      markersCast: 1,
      tokensRedeemed: 1,
    });

    // Zero Supa writes were persisted by the cast, and the Supa
    // token was NOT redeemed (no double-persist across backends).
    expect(rawDomain.writeLog).toHaveLength(0);
    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
    expect(rawDomain.docsAt(`elections/${electionId}/cast_markers`).size).toBe(0);
    const supaToken = rawDomain
      .docsAt(`elections/${electionId}/eligibility_tokens`)
      .get(tokenHash);
    expect(supaToken?.redeemedAt ?? null).toBeNull();
  });

  it("(c) token READ fails AND the token is genuinely absent on Firestore too -> the Firestore path's authoritative bad_token 401 (domain error)", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    // No token issued anywhere; the Supa token read is armed to fail.
    rawDomain.failRead = (op, path) =>
      op === "getDoc" && path.endsWith("/eligibility_tokens");
    rawDomain.writeLog.length = 0;

    const err = await captureError(
      castBallot(
        db,
        electionId,
        { uid: "v1", token: "never-issued-token", choices: ["cand"] },
        T_POLL,
      ),
    );
    // Provenance: the surfaced error is the Firestore fallback's
    // domain verdict, NOT the bridge's infrastructure error and NOT
    // a bad_token manufactured from the bridge failure in (b)'s
    // world — (b) succeeding is what proves the distinction.
    expectDomainError(err, "bad_token", 401);
    expect(rawDomain.writeLog).toHaveLength(0);
    expect(fsSubcollectionCount(db, electionId, "ballots")).toBe(0);
    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(0);
  });

  it("(d) CONCURRENT casts, same voter + same token -> exactly ONE Supa ballot, one success, loser already_cast 409", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);

    const input = { uid: "v1", token, choices: ["cand"] };
    const results = await Promise.allSettled([
      castBallot(db, electionId, input, T_POLL),
      castBallot(db, electionId, { ...input }, T_POLL),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectDomainError(
      (rejected[0] as PromiseRejectedResult).reason,
      "already_cast",
      409,
    );

    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    expect(rawDomain.docsAt(`elections/${electionId}/cast_markers`).size).toBe(1);
    // Nothing leaked onto Firestore subcollections.
    expect(fsSubcollectionCount(db, electionId, "ballots")).toBe(0);
    expect(fsSubcollectionCount(db, electionId, "cast_markers")).toBe(0);
  });

  it("(e) CONCURRENT casts, same token, DIFFERENT voter (different marker) -> exactly one ballot, loser bad_token 401", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    // Token issued to v2; v1 presents the same bearer token. The
    // markers differ, so the marker race cannot decide this one:
    // the CONDITIONAL REDEMPTION must.
    const { token } = await issueBallotToken(db, electionId, "v2", {}, T_POLL);

    const results = await Promise.allSettled([
      castBallot(db, electionId, { uid: "v1", token, choices: ["cand"] }, T_POLL),
      castBallot(db, electionId, { uid: "v2", token, choices: ["cand"] }, T_POLL),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectDomainError(
      (rejected[0] as PromiseRejectedResult).reason,
      "bad_token",
      401,
    );

    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    expect(fsSubcollectionCount(db, electionId, "ballots")).toBe(0);
  });

  it("(f) COUNTERS on the casting backend: Supa doc 7/7/7 vs Firestore doc 0/0/0 -> one flipped cast makes Supa 8/8/8, Firestore untouched", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const { token } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);

    // Mirror the election doc into the G1 core fake (its flipped
    // home), with DIVERGENT counters on purpose: Supa 7/7/7,
    // Firestore 0/0/0. A cast that reads or writes the wrong
    // backend — or the wrong backend's snapshot — cannot produce
    // 8/8/8 on Supa with Firestore untouched.
    await mirrorElectionDocToSupa(db, electionId, rawCore, 7, rawDomain);
    registerElectionSupaAdapter(
      withGenericPrimitives(rawCore) as unknown as CoreSupaAdapter,
    );

    const fsBefore = fsSnapshot(db);
    const cast = await castBallot(
      db,
      electionId,
      { uid: "v1", token, choices: ["cand"] },
      T_POLL,
    );
    expect(cast.recorded).toBe(true);

    // Supa counters re-derived from Supa's CURRENT state (7 + 1).
    syncElectionFakes(rawCore, rawDomain, electionId);
    expect(rawDomain.docsAt("elections").get(electionId)?.counters).toEqual({
      ballotsCast: 8,
      markersCast: 8,
      tokensRedeemed: 8,
    });
    const supaElection = await getElectionOrThrow(db, electionId);
    expect(supaElection.counters).toEqual({
      ballotsCast: 8,
      markersCast: 8,
      tokensRedeemed: 8,
    });
    expect(rawCore.raw("elections", electionId)?.counters).toEqual({
      ballotsCast: 8,
      markersCast: 8,
      tokensRedeemed: 8,
    });

    // The Firestore election doc is completely untouched by the cast.
    expect(fsSnapshot(db)).toEqual(fsBefore);
    const fsRaw = db._dump().get(`elections/${electionId}`) as AnyRec;
    expect(fsRaw.counters).toEqual({
      ballotsCast: 0,
      markersCast: 0,
      tokensRedeemed: 0,
    });
  });

  it("(f2) COUNTERS under concurrency: two concurrent flipped casts move Supa counters by exactly 2 (no lost increments)", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const { token: t1 } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    const { token: t2 } = await issueBallotToken(db, electionId, "v2", {}, T_POLL);

    await mirrorElectionDocToSupa(db, electionId, rawCore, 7, rawDomain);
    registerElectionSupaAdapter(
      withGenericPrimitives(rawCore) as unknown as CoreSupaAdapter,
    );

    const fsBefore = fsSnapshot(db);
    const results = await Promise.allSettled([
      castBallot(db, electionId, { uid: "v1", token: t1, choices: ["cand"] }, T_POLL),
      castBallot(db, electionId, { uid: "v2", token: t2, choices: ["cand2"] }, T_POLL),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(2);

    // Snapshot-based counters would land on 8 (both casts computed
    // 7 + 1); re-derived / atomic counters land on exactly 9.
    syncElectionFakes(rawCore, rawDomain, electionId);
    expect(rawDomain.docsAt("elections").get(electionId)?.counters).toEqual({
      ballotsCast: 9,
      markersCast: 9,
      tokensRedeemed: 9,
    });
    expect(rawCore.raw("elections", electionId)?.counters).toEqual({
      ballotsCast: 9,
      markersCast: 9,
      tokensRedeemed: 9,
    });
    expect(fsSnapshot(db)).toEqual(fsBefore);
  });

  it("(g) validation ORDER on the Supa path: bad_token 401 / poll_closed 410 / already_cast 409 / invalid_choice 422 sequence holds", async () => {
    const { db, electionId } = await setupLifecycle(rawDomain);
    const seq: Array<{ code: string; httpStatus: number }> = [];
    const record = async (p: Promise<unknown>) => {
      const err = (await captureError(p)) as {
        code?: string;
        httpStatus?: number;
      } | null;
      seq.push({
        code: err?.code ?? "NO_ERROR",
        httpStatus: err?.httpStatus ?? 0,
      });
    };

    // 1. Unknown token -> bad_token 401.
    await record(
      castBallot(db, electionId, { uid: "v1", token: "unknown-token", choices: ["cand"] }, T_POLL),
    );
    // 2. Valid token, before the poll window -> poll_closed 410.
    const { token: t1 } = await issueBallotToken(db, electionId, "v1", {}, T_POLL);
    await record(
      castBallot(db, electionId, { uid: "v1", token: t1, choices: ["cand"] }, T_CREATE),
    );
    // 3. The one valid cast.
    const ok = await castBallot(
      db,
      electionId,
      { uid: "v1", token: t1, choices: ["cand"] },
      T_POLL,
    );
    expect(ok.recorded).toBe(true);
    // 4. Reused (redeemed) token -> bad_token 401 (token check first).
    await record(
      castBallot(db, electionId, { uid: "v1", token: t1, choices: ["cand"] }, T_POLL),
    );
    // 5. v1 presenting v2's live token -> already_cast 409 (marker
    //    read-check fast path, after token validity, before choices).
    const { token: t2 } = await issueBallotToken(db, electionId, "v2", {}, T_POLL);
    await record(
      castBallot(db, electionId, { uid: "v1", token: t2, choices: ["cand"] }, T_POLL),
    );
    // 6. v2 with own live token but an uncertified choice -> 422.
    await record(
      castBallot(db, electionId, { uid: "v2", token: t2, choices: ["not-a-candidate"] }, T_POLL),
    );

    expect(seq).toEqual([
      { code: "bad_token", httpStatus: 401 },
      { code: "poll_closed", httpStatus: 410 },
      { code: "bad_token", httpStatus: 401 },
      { code: "already_cast", httpStatus: 409 },
      { code: "invalid_choice", httpStatus: 422 },
    ]);

    // Only the one valid cast persisted anything, and only on Supa.
    expect(rawDomain.docsAt(`elections/${electionId}/ballots`).size).toBe(1);
    expect(rawDomain.docsAt(`elections/${electionId}/cast_markers`).size).toBe(1);
    expect(fsSubcollectionCount(db, electionId, "ballots")).toBe(0);
    expect(fsSubcollectionCount(db, electionId, "cast_markers")).toBe(0);
    expect(fsSubcollectionCount(db, electionId, "eligibility_tokens")).toBe(0);
  });
});
