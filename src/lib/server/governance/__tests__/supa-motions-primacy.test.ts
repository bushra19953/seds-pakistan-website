/**
 * @jest-environment node
 *
 * CUTOVER write-primacy tests for the meetings family (flag law:
 * isSupaPrimary(<surface>) = token in BOTH SUPA_SURFACES and
 * SUPA_PRIMARY). Everything is mocked — zero live reads/writes.
 *
 * Covered:
 * - governance-votes primary path: open/cast/close each make exactly
 *   ONE tx() call (tx_motions_*), with the idempotency keys the SQL
 *   contract expects; the committed shapes mirror to Firestore
 *   best-effort under the same ids.
 * - H-5 on the primary path: the audit row and the vote mutation are
 *   both effects of the single tx (the fake's reference handlers
 *   write them together, mirroring the SQL); a tx failure leaves the
 *   vote untouched, writes NO audit row, and does NOT fall back to a
 *   Firestore close/open.
 * - H-09 survival on the primary path: an outsider opens a vote over
 *   a self-supplied electorate and a second outsider closes it.
 * - Error mapping: tx outcomes map to the exact VoteError codes of
 *   the Firestore transaction (404/409/403); re-cast overwrites.
 * - getVote ISO-shape delta re-checked on the primary path:
 *   timestamps come back as ISO strings, ballotCount only.
 * - Store primacy for decisions / minutes / motions seams: Supa
 *   commit + Firestore mirror (same id), adapter failure on the
 *   primary path propagates instead of delegating, and with
 *   SUPA_PRIMARY off none of the mirror machinery runs.
 * - Meetings facade primacy: a facade doc write commits in Supa and
 *   mirrors to the real-db doc; a mirror failure is swallowed.
 *
 * The fake's tx handlers are REFERENCE implementations of the SQL
 * functions' contracts over the in-memory store (the tally uses the
 * real tallyBallots). They prove TS call shapes and outcome mapping
 * only — the real-Postgres race proof is the H-3 harness in
 * ~/workspace/supabase-migration/cutover-gates/motions-h3-proof/.
 */
jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

let mockMirrorDb: unknown = null;
jest.mock("@/lib/server/firebase-admin", () => ({
  getDb: () => mockMirrorDb,
  ensureAdminInitialized: () => true,
}));

import { createFakeSupaAdapter, type FakeSupaAdapter } from "./fake-supa-adapter";
import { createFakeDb, type FakeDb } from "../../__tests__/fake-firestore";
import { __setGovSupaAdapterForTests } from "../supa-shared";
import {
  castVote,
  closeVote,
  getVote,
  openVote,
  tallyBallots,
  VoteError,
  type ElectorateSeat,
} from "@/lib/server/governance-votes";
import { SupaDecisionsClient } from "../decisions-supa";
import { InMemoryDecisionsClient } from "../decisions-client";
import { SupaMinutesStore, SupaCircularStore } from "../minutes-circular-supa";
import { SupaMotionStore, SupaBallotStore } from "../motions-supa";
import { InMemoryBallotStore } from "../ballots";
import { SupaFirestoreFacade } from "../supa-facade";

const T0 = new Date("2026-10-21T10:00:00Z");

function seats(n: number): ElectorateSeat[] {
  return Array.from({ length: n }, (_, i) => ({
    seatKey: `seat-${i + 1}`,
    roleKey: "governor",
    uid: `gov-${i + 1}`,
    vacant: false,
  }));
}

/** Reference implementations of the tx_motions_* contracts. */
function registerMotionsTxHandlers(adapter: FakeSupaAdapter): void {
  const idem = new Map<string, Record<string, unknown>>();

  adapter.txHandlers.set("tx_motions_open_vote", async (args) => {
    const key = args.p_idempotency_key as string | undefined;
    if (key && idem.has(key)) {
      return { ...idem.get(key), applied: false, duplicate: true };
    }
    const voteId = args.p_vote_id as string;
    if (await adapter.getDoc("governance_votes", voteId)) {
      return { applied: false, duplicate: true, outcome: "already_exists", vote_id: voteId, audit_log_id: null };
    }
    const auditId = args.p_audit_id as string;
    await adapter.setDoc("governance_votes", voteId, args.p_vote_data as never);
    await adapter.setDoc("audit_logs", auditId, args.p_audit_data as never);
    await adapter.updateDoc("governance_votes", voteId, { auditLogId: auditId });
    const result = { applied: true, duplicate: false, outcome: "created", vote_id: voteId, audit_log_id: auditId };
    if (key) idem.set(key, result);
    return result;
  });

  adapter.txHandlers.set("tx_motions_cast_vote", async (args) => {
    const key = args.p_idempotency_key as string | undefined;
    const choice = args.p_choice as string;
    const prior = key ? idem.get(key) : undefined;
    if (prior && prior.choice === choice) {
      return { ...prior, applied: false, duplicate: true };
    }
    const voteId = args.p_vote_id as string;
    const voterUid = args.p_voter_uid as string;
    const doc = await adapter.getDoc("governance_votes", voteId);
    if (!doc) return { applied: false, duplicate: false, outcome: "not_found" };
    const vote = doc as Record<string, any>;
    if (vote.mode !== "ballot" || vote.status !== "open") {
      return { applied: false, duplicate: false, outcome: "not_open" };
    }
    const seat = (vote.electorate as ElectorateSeat[]).find((s) => s.uid === voterUid && !s.vacant);
    if (!seat) return { applied: false, duplicate: false, outcome: "not_in_electorate" };
    const ballot = { choice, seatKey: seat.seatKey, castAt: new Date().toISOString() };
    await adapter.setDoc(`governance_votes/${voteId}/ballots`, voterUid, ballot);
    const result = {
      applied: true, duplicate: false, outcome: "cast", choice,
      seat_key: seat.seatKey, ballot_data: ballot,
    };
    if (key) idem.set(key, result as never);
    return result;
  });

  adapter.txHandlers.set("tx_motions_close_vote", async (args) => {
    const voteId = args.p_vote_id as string;
    const actorUid = args.p_actor_uid as string;
    const doc = await adapter.getDoc("governance_votes", voteId);
    if (!doc) return { applied: false, duplicate: false, outcome: "not_found" };
    const vote = doc as Record<string, any>;
    if (vote.status === "closed" && vote.result) {
      return { applied: false, duplicate: true, outcome: "already_closed", result: vote.result, audit_log_id: null };
    }
    if (vote.mode !== "ballot" || vote.status !== "open") {
      return { applied: false, duplicate: false, outcome: "not_open" };
    }
    const ballotDocs = await adapter.listDocs(`governance_votes/${voteId}/ballots`);
    const result = tallyBallots(
      ballotDocs.map((d) => ({ choice: (d as Record<string, any>).choice })),
      {
        threshold: vote.threshold,
        isStrictMajority: vote.isStrictMajority,
        denominatorBasis: vote.denominatorBasis,
        quorum: vote.quorum,
        kind: vote.thresholdKind,
        electorateSize: vote.electorateSize ?? (vote.electorate as unknown[]).length,
      },
    );
    const auditId = args.p_audit_id as string;
    const auditData = {
      action: "governance_vote_closed",
      actorUid,
      targetType: "governance_vote",
      targetId: voteId,
      details: { passed: result.passed, votesFor: result.votesFor, votesAgainst: result.votesAgainst },
      governance: true,
      createdAt: new Date().toISOString(),
    };
    const patch = { status: "closed", result, closedAt: new Date().toISOString(), closedByUid: actorUid };
    await adapter.setDoc("audit_logs", auditId, auditData);
    await adapter.updateDoc("governance_votes", voteId, patch);
    return {
      applied: true, duplicate: false, outcome: "closed", result,
      audit_log_id: auditId, audit_data: auditData, vote_patch: patch,
    };
  });
}

describe("governance votes write primacy (SUPA_PRIMARY=motions)", () => {
  const savedSurfaces = process.env.SUPA_SURFACES;
  const savedPrimary = process.env.SUPA_PRIMARY;
  let adapter: FakeSupaAdapter;
  let mirrorDb: FakeDb;

  beforeEach(() => {
    process.env.SUPA_SURFACES = "motions";
    process.env.SUPA_PRIMARY = "motions";
    adapter = createFakeSupaAdapter() as unknown as FakeSupaAdapter;
    registerMotionsTxHandlers(adapter);
    __setGovSupaAdapterForTests(adapter as never);
    mirrorDb = createFakeDb();
    mockMirrorDb = mirrorDb;
  });

  afterEach(() => {
    __setGovSupaAdapterForTests(undefined);
    mockMirrorDb = null;
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
    if (savedPrimary === undefined) delete process.env.SUPA_PRIMARY;
    else process.env.SUPA_PRIMARY = savedPrimary;
  });

  it("open -> cast -> close run ONE tx each; audit+mutation commit together in Supa (H-5) and mirror to Firestore", async () => {
    const db = mirrorDb as never;
    const voteId = await openVote(db, {
      subjectType: "board_generic",
      electorate: seats(3),
      createdByUid: "gov-1",
    });
    await castVote(db, voteId, "gov-1", "for");
    await castVote(db, voteId, "gov-2", "for");
    await castVote(db, voteId, "gov-3", "against");
    const result = await closeVote(db, voteId, "gov-1");
    expect(result).toMatchObject({ votesFor: 2, votesAgainst: 1, passed: true });

    // Exactly one tx call per critical section, in order.
    expect(adapter.txCalls.map((c) => c.fn)).toEqual([
      "tx_motions_open_vote",
      "tx_motions_cast_vote",
      "tx_motions_cast_vote",
      "tx_motions_cast_vote",
      "tx_motions_close_vote",
    ]);
    // Idempotency keys are the SQL contract's origin keys.
    expect(adapter.txCalls[0].options?.idempotencyKey).toBe(`open:${voteId}`);
    expect(adapter.txCalls[1].options?.idempotencyKey).toBe(`vote:${voteId}:gov-1`);
    // Lock-key derivation: every function receives the vote id as its
    // first argument; the SQL derives 'vote:' || p_vote_id from it.
    for (const call of adapter.txCalls) {
      expect((call.args as Record<string, unknown>).p_vote_id).toBe(voteId);
    }

    // Supa is the authority: vote closed, exactly one open-audit and
    // one close-audit row, three ballots.
    const supaVote = adapter.all("governance_votes").find((d) => d.id === voteId)!;
    expect(supaVote.data.status).toBe("closed");
    expect(supaVote.data.auditLogId).toBeTruthy();
    expect(adapter.all("audit_logs").map((d) => d.data.action).sort()).toEqual([
      "governance_vote_closed",
      "governance_vote_opened",
    ]);
    expect(adapter.all(`governance_votes/${voteId}/ballots`)).toHaveLength(3);

    // Firestore mirror converged under the same ids (vote, ballots,
    // both audit rows).
    const mirrored = mirrorDb.read("governance_votes", voteId)!;
    expect(mirrored.status).toBe("closed");
    expect(mirrored.auditLogId).toBe(supaVote.data.auditLogId);
    expect(mirrorDb.all(`governance_votes/${voteId}/ballots`)).toHaveLength(3);
    expect(mirrorDb.all("audit_logs")).toHaveLength(2);
  });

  it("H-09 SURVIVAL on the primary path: outsider opens over a self-supplied electorate, second outsider closes", async () => {
    const db = mirrorDb as never;
    const voteId = await openVote(db, {
      subjectType: "board_generic",
      electorate: seats(3),
      createdByUid: "random_member",
    });
    await castVote(db, voteId, "gov-1", "for");
    const result = await closeVote(db, voteId, "total_outsider");
    expect(result.passed).toBe(true);
    const supaVote = adapter.all("governance_votes").find((d) => d.id === voteId)!;
    expect(supaVote.data.closedByUid).toBe("total_outsider");
  });

  it("tx outcome mapping preserves the Firestore error vocabulary (404/409/403) and re-cast overwrites", async () => {
    const db = mirrorDb as never;
    await expect(castVote(db, "missing", "gov-1", "for")).rejects.toMatchObject({
      code: "VOTE_NOT_FOUND", status: 404,
    });
    const voteId = await openVote(db, {
      subjectType: "board_generic",
      electorate: seats(3),
      createdByUid: "gov-1",
    });
    await expect(castVote(db, voteId, "outsider", "for")).rejects.toMatchObject({
      code: "VOTER_NOT_IN_ELECTORATE", status: 403,
    });
    // Re-cast overwrites (one ballot per voter, structural).
    await castVote(db, voteId, "gov-1", "against");
    await castVote(db, voteId, "gov-1", "for");
    expect(adapter.all(`governance_votes/${voteId}/ballots`)).toHaveLength(1);
    const result = await closeVote(db, voteId, "gov-1");
    expect(result).toMatchObject({ votesFor: 1, votesAgainst: 0 });
    await expect(castVote(db, voteId, "gov-2", "for")).rejects.toMatchObject({
      code: "VOTE_NOT_OPEN", status: 409,
    });
    // Idempotent close: same certified result, no second close audit.
    const auditsBefore = adapter.all("audit_logs").length;
    const again = await closeVote(db, voteId, "someone_else");
    expect(again).toEqual(result);
    expect(adapter.all("audit_logs")).toHaveLength(auditsBefore);
  });

  it("a tx failure on close propagates, writes no audit row, leaves the vote open, and never falls back to Firestore (H-5)", async () => {
    const db = mirrorDb as never;
    const voteId = await openVote(db, {
      subjectType: "board_generic",
      electorate: seats(3),
      createdByUid: "gov-1",
    });
    await castVote(db, voteId, "gov-1", "for");
    // Simulate the Postgres function failing (in a real tx every
    // statement rolls back — the handler throws before any effect).
    adapter.txHandlers.set("tx_motions_close_vote", () => {
      throw new Error("fake supa: simulated tx rollback");
    });
    await expect(closeVote(db, voteId, "gov-1")).rejects.toThrow(/simulated tx rollback/);
    const supaVote = adapter.all("governance_votes").find((d) => d.id === voteId)!;
    expect(supaVote.data.status).toBe("open");
    expect(
      adapter.all("audit_logs").filter((d) => d.data.action === "governance_vote_closed"),
    ).toHaveLength(0);
    // No Firestore fallback close: the mirror copy is still open.
    expect(mirrorDb.read("governance_votes", voteId)?.status).toBe("open");
  });

  it("getVote on the primary path returns ISO-string timestamps (pinned delta) and ballotCount only", async () => {
    const db = mirrorDb as never;
    const voteId = await openVote(db, {
      subjectType: "board_generic",
      electorate: seats(3),
      createdByUid: "gov-1",
    });
    await castVote(db, voteId, "gov-1", "for");
    const vote = await getVote(db, voteId);
    expect(vote.ballotCount).toBe(1);
    expect(typeof vote.createdAt).toBe("string");
    expect(vote.createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(vote).not.toHaveProperty("ballots");
    await expect(getVote(db, "missing")).rejects.toBeInstanceOf(VoteError);
  });

  it("primacy on with a tx-less adapter is a loud error, not a Firestore fallback", async () => {
    const txLess = createFakeSupaAdapter() as unknown as FakeSupaAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (txLess as any).tx = undefined;
    __setGovSupaAdapterForTests(txLess as never);
    await expect(
      castVote(mirrorDb as never, "any", "gov-1", "for"),
    ).rejects.toThrow(/SUPA_PRIMARY=motions is on/);
    expect(mirrorDb.all("governance_votes")).toHaveLength(0);
  });
});

describe("store write primacy (decisions / minutes / motions seams)", () => {
  const savedSurfaces = process.env.SUPA_SURFACES;
  const savedPrimary = process.env.SUPA_PRIMARY;

  beforeEach(() => {
    process.env.SUPA_SURFACES = "decisions,minutes,motions";
    process.env.SUPA_PRIMARY = "decisions,minutes,motions";
  });
  afterEach(() => {
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
    if (savedPrimary === undefined) delete process.env.SUPA_PRIMARY;
    else process.env.SUPA_PRIMARY = savedPrimary;
  });

  const decisionInput = {
    bodyId: "board_body",
    decisionClassId: "class_ordinary",
    source: "meeting_motion" as const,
    sourceId: "motion_1",
    text: "Approve the budget",
    outcome: "passed" as const,
    votingSummary: {
      votesFor: 3, votesAgainst: 1, abstentions: 0, denominator: 5,
      thresholdApplied: {},
    },
    consentId: null,
    decidedAt: T0,
    effectiveAt: T0,
    status: "effective" as const,
    supersedesDecisionId: null,
    retentionUntil: T0,
  };

  it("decisions: writeDecision commits in Supa and mirrors under the SAME id; the fallback's own write never runs", async () => {
    const adapter = createFakeSupaAdapter();
    const fallback = new InMemoryDecisionsClient();
    const mirrored: string[] = [];
    const client = new SupaDecisionsClient(adapter as never, fallback as never, async (entry) => {
      mirrored.push(entry.id);
    });
    const entry = await client.writeDecision(decisionInput);
    expect(adapter.all("decisions")).toHaveLength(1);
    expect(adapter.all("decisions")[0].id).toBe(entry.id);
    expect(mirrored).toEqual([entry.id]);
    expect(fallback.all()).toHaveLength(0);
  });

  it("decisions: an adapter failure on the primary path propagates (no delegation, no mirror)", async () => {
    const adapter = createFakeSupaAdapter();
    adapter.failAll = true;
    const fallback = new InMemoryDecisionsClient();
    const mirrored: string[] = [];
    const client = new SupaDecisionsClient(adapter as never, fallback as never, async (entry) => {
      mirrored.push(entry.id);
    });
    await expect(client.writeDecision(decisionInput)).rejects.toThrow(/adapter unavailable/);
    expect(mirrored).toHaveLength(0);
    expect(fallback.all()).toHaveLength(0);
  });

  it("decisions: transition commits in Supa and mirrors through the fallback transition", async () => {
    const adapter = createFakeSupaAdapter();
    adapter.seed("decisions", "dec_1", {
      ...decisionInput,
      id: "dec_1",
      status: "pending_ratification",
      voidedAt: null, voidEffectiveFrom: null, ratifiedAt: null,
    });
    const fallback = new InMemoryDecisionsClient(() => "unused");
    await fallback.writeDecision({ ...decisionInput, status: "pending_ratification" });
    const transitions: Array<[string, string]> = [];
    const spyFallback = {
      ...fallback,
      writeDecision: fallback.writeDecision.bind(fallback),
      getDecision: fallback.getDecision.bind(fallback),
      isEffectiveDecision: async () => false,
      transitionDecisionStatus: async (id: string, to: never) => {
        transitions.push([id, to]);
        return fallback.transitionDecisionStatus("decision_1", to);
      },
    };
    const client = new SupaDecisionsClient(adapter as never, spyFallback as never);
    const updated = await client.transitionDecisionStatus("dec_1", "ratified", { ratifiedAt: T0 });
    expect(updated.status).toBe("ratified");
    expect(adapter.raw("decisions", "dec_1")?.status).toBe("ratified");
    expect(transitions).toEqual([["dec_1", "ratified"]]);
  });

  it("minutes + circulars: save/create commit in Supa and mirror to the Firestore store under the same id", async () => {
    const adapter = createFakeSupaAdapter();
    const fsMinutes: Array<Record<string, unknown>> = [];
    const minutesFallback = {
      getMinutes: async () => null,
      saveMinutes: async (rec: never) => { fsMinutes.push(rec); },
      listMinutes: async () => [],
      getByMeetingId: async () => null,
      nextId: () => "unused",
    };
    const minutes = new SupaMinutesStore(adapter as never, minutesFallback as never);
    const rec = {
      id: "min_1", meetingId: "mtg_1", bodyId: "board_body",
      circulationDueAt: T0, updatedAt: T0, circulatedAt: null,
      signedAt: null, retentionUntil: null,
    } as never;
    await minutes.saveMinutes(rec);
    expect(adapter.all("minutes")).toHaveLength(1);
    expect(fsMinutes).toHaveLength(1);
    expect((fsMinutes[0] as { id: string }).id).toBe("min_1");

    const fsCirculars: Array<Record<string, unknown>> = [];
    const circularFallback = {
      createResolution: async (r: never) => { fsCirculars.push(r); },
      getResolution: async () => null,
      saveResolution: async () => {},
      listOpenResolutions: async () => [],
      listResolutions: async () => [],
      nextId: () => "unused",
    };
    const circulars = new SupaCircularStore(adapter as never, circularFallback as never);
    await circulars.createResolution({ id: "circ_1", status: "circulating" } as never);
    expect(adapter.all("circular_resolutions")).toHaveLength(1);
    expect(fsCirculars).toHaveLength(1);
  });

  it("motions store: saveMotion/putBallot mirror under the same ids; secret choices stay whitelisted in Supa", async () => {
    const adapter = createFakeSupaAdapter();
    const fsMotions: string[] = [];
    const motionFallback = {
      getMotion: async () => null,
      saveMotion: async (m: { id: string }) => { fsMotions.push(m.id); },
      listMotionsByMeeting: async () => [],
      nextId: () => "unused",
    };
    const motions = new SupaMotionStore(adapter as never, motionFallback as never);
    await motions.saveMotion({ id: "motion_1", openedAt: T0, closedAt: null, disclosures: [] } as never);
    expect(adapter.all("motions")).toHaveLength(1);
    expect(fsMotions).toEqual(["motion_1"]);

    const fsBallots: string[] = [];
    const ballotFallback = new InMemoryBallotStore();
    const origPut = ballotFallback.putBallot.bind(ballotFallback);
    ballotFallback.putBallot = async (id: string, doc: never) => { fsBallots.push(id); return origPut(id, doc); };
    const ballots = new SupaBallotStore(adapter as never, motions as never, ballotFallback);
    await ballots.putBallot("ballot_1", { motionId: "motion_1", voterUid: "g1", choice: "for", castAt: T0 } as never);
    expect(adapter.all("ballots")).toHaveLength(1);
    expect(fsBallots).toEqual(["ballot_1"]);
    await ballots.putSecretChoice("choice_1", { motionId: "motion_1", choice: "for", castAt: T0 } as never);
    const storedChoice = adapter.all("secret_ballot_choices")[0];
    expect(Object.keys(storedChoice.data).sort()).toEqual(["castAt", "choice", "motionId"]);
  });

  it("SUPA_PRIMARY off: the mirror machinery never runs (Supa write only, fallback untouched on success)", async () => {
    delete process.env.SUPA_PRIMARY;
    const adapter = createFakeSupaAdapter();
    const fsMotions: string[] = [];
    const motionFallback = {
      getMotion: async () => null,
      saveMotion: async (m: { id: string }) => { fsMotions.push(m.id); },
      listMotionsByMeeting: async () => [],
      nextId: () => "unused",
    };
    const motions = new SupaMotionStore(adapter as never, motionFallback as never);
    await motions.saveMotion({ id: "motion_1", openedAt: T0, closedAt: null, disclosures: [] } as never);
    expect(adapter.all("motions")).toHaveLength(1);
    expect(fsMotions).toHaveLength(0);
  });
});

describe("meetings facade write primacy", () => {
  it("a facade doc write commits in Supa and mirrors to the real Firestore doc; a mirror failure is swallowed", async () => {
    const adapter = createFakeSupaAdapter();
    const mirrored = new Map<string, Record<string, unknown>>();
    const mirrorDb = {
      collection: (name: string) => ({
        doc: (id: string) => ({
          set: async (data: Record<string, unknown>) => { mirrored.set(`${name}/${id}`, data); },
          update: async (data: Record<string, unknown>) => { mirrored.set(`${name}/${id}`, data); },
          delete: async () => { mirrored.delete(`${name}/${id}`); },
        }),
      }),
    };
    const facade = new SupaFirestoreFacade(adapter as never, {
      allow: new Set(["meetings"]),
      primary: true,
      mirrorDb: mirrorDb as never,
    });
    const col = facade.collection("meetings") as { doc(id: string): { set(d: never): Promise<void> } };
    await col.doc("mtg_1").set({ status: "convened" } as never);
    expect(adapter.all("meetings")).toHaveLength(1);
    expect(mirrored.get("meetings/mtg_1")).toMatchObject({ status: "convened" });

    const failingFacade = new SupaFirestoreFacade(adapter as never, {
      allow: new Set(["meetings"]),
      primary: true,
      mirrorDb: {
        collection: () => { throw new Error("mirror down"); },
      } as never,
    });
    const col2 = failingFacade.collection("meetings") as typeof col;
    await expect(col2.doc("mtg_2").set({ status: "convened" } as never)).resolves.toBeUndefined();
    expect(adapter.all("meetings").some((d) => d.id === "mtg_2")).toBe(true);
  });
});
