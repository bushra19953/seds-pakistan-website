/**
 * Ballot service (ws-a §3.6, §4.5, §6.2) — server only.
 *
 * ADAPTER (store): persistence goes through `BallotStore`. The Firestore
 * implementation belongs with the motions service (sibling slice owning
 * src/lib/server/governance/motions.ts); it was not present when this slice
 * was built. `InMemoryBallotStore` implements the exact same interface for
 * local tests. A Firestore adapter must map each method 1:1 to the
 * collections in ws-a §3.6, including the rules-denied private token-issue
 * log (motions/{id} private subdoc tokenIssueLog/{uid}, deleted at close).
 *
 * ADAPTER (motion): motions are read/mutated through the store using the
 * minimal `MotionRef` shape from src/lib/governance/meetings/ballots.ts.
 *
 * ADAPTER (proxy advance resolution): a proxy vote is valid only when its
 * proxyAuthorizations doc's advanceResolutionDecisionId resolves to an
 * EFFECTIVE decisions entry (ws-a §3.6). The decisions register is a Phase 2
 * substrate consumed via decisions-client (sibling); until it lands, callers
 * inject `isEffectiveDecision`. The default denies — fail closed.
 *
 * ANONYMITY INVARIANT: the secret path never writes a voter identifier with
 * a choice. Eligibility lives in secret_ballot_tokens (hash-keyed, no uid)
 * plus the separate private tokenIssueLog (uid-keyed, NO choice, deleted at
 * close). Choices live only in secret_ballot_choices (no uid, no token).
 * The cast function takes no voter uid parameter at all — the route
 * authenticates the session, then discards the uid before calling it.
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import {
  applySecretDemand,
  assertSecretChoiceDocShape,
  assertSecretTokenDocShape,
  buildSecretBallotChoiceDoc,
  buildSecretBallotTokenDoc,
  castingBallotId,
  evaluateBallotOutcome,
  findCastingBallot,
  isEligiblePresent,
  tallyBallots,
  tallyChoices,
  traceableBallotId,
  SECRET_TOKEN_BYTES,
  type BallotChoice,
  type BallotDoc,
  type InterestDisclosure,
  type MotionRef,
  type MotionResult,
  type ProxyAuthorizationDoc,
  type SecretBallotChoiceDoc,
  type SecretBallotTokenDoc,
} from "@/lib/governance/meetings/ballots";

export class BallotError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "BallotError";
  }
}

export interface BallotStore {
  getMotion(motionId: string): Promise<MotionRef | null>;
  saveMotion(motion: MotionRef): Promise<void>;
  getBallot(ballotId: string): Promise<BallotDoc | null>;
  putBallot(ballotId: string, doc: BallotDoc): Promise<void>;
  listBallots(motionId: string): Promise<BallotDoc[]>;
  // Secret store — token docs keyed by token hash, choice docs by random id.
  getSecretToken(tokenHash: string): Promise<SecretBallotTokenDoc | null>;
  putSecretToken(tokenHash: string, doc: SecretBallotTokenDoc): Promise<void>;
  putSecretChoice(choiceId: string, doc: SecretBallotChoiceDoc): Promise<void>;
  listSecretChoices(motionId: string): Promise<SecretBallotChoiceDoc[]>;
  // Private issue log: eligibility/participation only, stores NO choice.
  getTokenIssue(motionId: string, uid: string): Promise<{ issuedAt: Date } | null>;
  putTokenIssue(motionId: string, uid: string, issuedAt: Date): Promise<void>;
  deleteTokenIssueLog(motionId: string): Promise<void>;
  getProxyAuthorization(authId: string): Promise<ProxyAuthorizationDoc | null>;
}

/** In-memory BallotStore for local tests (ADAPTER — see header). */
export class InMemoryBallotStore implements BallotStore {
  motions = new Map<string, MotionRef>();
  ballots = new Map<string, BallotDoc>();
  secretTokens = new Map<string, SecretBallotTokenDoc>();
  secretChoices = new Map<string, SecretBallotChoiceDoc>();
  tokenIssues = new Map<string, { issuedAt: Date }>(); // key `${motionId}/${uid}`
  proxies = new Map<string, ProxyAuthorizationDoc>();

  async getMotion(id: string) { return this.motions.get(id) ?? null; }
  async saveMotion(m: MotionRef) { this.motions.set(m.id, { ...m }); }
  async getBallot(id: string) { return this.ballots.get(id) ?? null; }
  async putBallot(id: string, doc: BallotDoc) { this.ballots.set(id, doc); }
  async listBallots(motionId: string) { return [...this.ballots.values()].filter((b) => b.motionId === motionId); }
  async getSecretToken(h: string) { return this.secretTokens.get(h) ?? null; }
  async putSecretToken(h: string, doc: SecretBallotTokenDoc) { this.secretTokens.set(h, doc); }
  async putSecretChoice(id: string, doc: SecretBallotChoiceDoc) { this.secretChoices.set(id, doc); }
  async listSecretChoices(motionId: string) { return [...this.secretChoices.values()].filter((c) => c.motionId === motionId); }
  async getTokenIssue(motionId: string, uid: string) { return this.tokenIssues.get(`${motionId}/${uid}`) ?? null; }
  async putTokenIssue(motionId: string, uid: string, issuedAt: Date) { this.tokenIssues.set(`${motionId}/${uid}`, { issuedAt }); }
  async deleteTokenIssueLog(motionId: string) {
    for (const k of [...this.tokenIssues.keys()]) if (k.startsWith(`${motionId}/`)) this.tokenIssues.delete(k);
  }
  async getProxyAuthorization(id: string) { return this.proxies.get(id) ?? null; }
}

export function hashSecretToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireMotion(store: BallotStore, motionId: string): Promise<MotionRef> {
  const m = await store.getMotion(motionId);
  if (!m) throw new BallotError("motion_not_found", 404, "Motion not found");
  return m;
}

function requireOpen(motion: MotionRef): void {
  if (motion.status === "paused_quorum_lost") throw new BallotError("quorum_lost", 409, "Motion paused: quorum lost");
  if (motion.status !== "open") throw new BallotError("motion_not_open", 409, `Motion is ${motion.status}`);
}

// --- Secret-ballot demand (ws-a §4.5 demand-secret) -------------------------

export async function demandSecretBallot(
  store: BallotStore,
  input: { motionId: string; uid: string },
): Promise<{ demands: number; method: MotionRef["method"]; locked: boolean }> {
  const motion = await requireMotion(store, input.motionId);
  requireOpen(motion);
  if (!isEligiblePresent(motion, input.uid)) {
    throw new BallotError("not_eligible", 403, "Only eligible present members may demand a secret ballot");
  }
  const r = applySecretDemand(motion, input.uid);
  if (r.added || r.method !== motion.method) {
    await store.saveMotion({ ...motion, secretDemandedBy: r.secretDemandedBy, method: r.method });
  }
  return { demands: r.demands, method: r.method, locked: r.locked };
}

// --- Traceable ballots: show of hands / electronic poll (ws-a §4.5) --------

export interface CastTraceableInput {
  motionId: string;
  voterUid: string;
  choice: BallotChoice;
  interestDisclosure?: InterestDisclosure | null;
  proxyForUid?: string | null;
  proxyAuthorizationId?: string | null;
  now?: Date;
  /** ADAPTER: decisions-register check for the proxy advance resolution. */
  isEffectiveDecision?: (decisionId: string) => Promise<boolean>;
}

export async function castTraceableBallot(store: BallotStore, input: CastTraceableInput): Promise<{ ballotId: string }> {
  const motion = await requireMotion(store, input.motionId);
  requireOpen(motion);
  if (motion.method === "secret_ballot") {
    throw new BallotError("method_is_secret", 422, "Motion is a secret ballot; use the token flow");
  }
  const effectiveVoter = input.proxyForUid ?? input.voterUid;
  // Presence/eligibility is checked for the person whose vote this is; for a
  // proxy, the holder must also be eligible and present.
  if (!isEligiblePresent(motion, effectiveVoter)) {
    throw new BallotError("not_eligible", 403, "Voter is not an eligible present member");
  }
  if (input.proxyForUid) {
    if (!isEligiblePresent(motion, input.voterUid)) {
      throw new BallotError("not_eligible", 403, "Proxy holder is not an eligible present member");
    }
    await validateProxy(store, motion, input);
  }
  const ballotId = traceableBallotId(input.motionId, effectiveVoter);
  if (await store.getBallot(ballotId)) {
    throw new BallotError("already_voted", 409, "A ballot has already been cast for this member on this motion");
  }
  const doc: BallotDoc = {
    motionId: input.motionId,
    meetingId: motion.meetingId ?? "",
    voterUid: input.voterUid,
    choice: input.choice,
    isProxy: Boolean(input.proxyForUid),
    proxyForUid: input.proxyForUid ?? null,
    proxyAuthorizationId: input.proxyAuthorizationId ?? null,
    isCastingVote: false,
    // Disclosure is recorded, never blocks the ballot (ws-a non-goal N1).
    interestDisclosure: input.interestDisclosure ?? null,
    castAt: input.now ?? new Date(),
  };
  await store.putBallot(ballotId, doc);
  return { ballotId };
}

async function validateProxy(store: BallotStore, motion: MotionRef, input: CastTraceableInput): Promise<void> {
  const fail = () => new BallotError("proxy_not_authorized", 422, "No valid proxy authorization for this vote");
  if (!input.proxyAuthorizationId) throw fail();
  const auth = await store.getProxyAuthorization(input.proxyAuthorizationId);
  if (!auth) throw fail();
  if (auth.meetingId !== motion.meetingId) throw fail();
  if (auth.grantorUid !== input.proxyForUid) throw fail();
  if (auth.proxyUid !== input.voterUid) throw fail();
  if (auth.revokedAt !== null) throw fail();
  if (auth.scopeMotionIds !== null && !auth.scopeMotionIds.includes(input.motionId)) throw fail();
  const isEffective = input.isEffectiveDecision ?? (async () => false);
  if (!(await isEffective(auth.advanceResolutionDecisionId))) throw fail();
}

// --- Secret ballot: token issue + untraceable cast (ws-a §4.5) -------------

export async function issueSecretToken(
  store: BallotStore,
  input: { motionId: string; uid: string; now?: Date; random?: (n: number) => Buffer },
): Promise<{ token: string }> {
  const motion = await requireMotion(store, input.motionId);
  requireOpen(motion);
  if (motion.method !== "secret_ballot") {
    throw new BallotError("not_secret_ballot", 422, "Motion method is not secret_ballot");
  }
  if (!isEligiblePresent(motion, input.uid)) {
    throw new BallotError("not_eligible", 403, "Only eligible present members may be issued a secret-ballot token");
  }
  // Double-issue prevention lives HERE (issue log: uid, no choice) — never
  // on the token or choice docs.
  if (await store.getTokenIssue(input.motionId, input.uid)) {
    throw new BallotError("token_already_issued", 409, "A token has already been issued to this voter for this motion");
  }
  const token = (input.random ?? randomBytes)(SECRET_TOKEN_BYTES).toString("base64url");
  const doc = buildSecretBallotTokenDoc({ motionId: input.motionId });
  assertSecretTokenDocShape(doc as unknown as Record<string, unknown>);
  await store.putSecretToken(hashSecretToken(token), doc);
  await store.putTokenIssue(input.motionId, input.uid, input.now ?? new Date());
  return { token }; // raw token returned once, never stored
}

/**
 * Cast a secret ballot. Deliberately takes NO voter uid: authentication
 * happens in the route, the uid is discarded, and only the token speaks.
 */
export async function castSecretBallot(
  store: BallotStore,
  input: { token: string; choice: BallotChoice; now?: Date; newChoiceId?: () => string },
): Promise<{ accepted: true }> {
  const tokenHash = hashSecretToken(input.token);
  const tokenDoc = await store.getSecretToken(tokenHash);
  if (!tokenDoc) throw new BallotError("invalid_token", 422, "Unknown secret-ballot token");
  if (tokenDoc.used) throw new BallotError("token_reused", 409, "This secret-ballot token has already been used");
  const motion = await requireMotion(store, tokenDoc.motionId);
  requireOpen(motion);
  await store.putSecretToken(tokenHash, { ...tokenDoc, used: true, usedAt: input.now ?? new Date() });
  const doc = buildSecretBallotChoiceDoc({
    motionId: tokenDoc.motionId,
    choice: input.choice,
    castAt: input.now ?? new Date(),
  });
  assertSecretChoiceDocShape(doc as unknown as Record<string, unknown>);
  await store.putSecretChoice((input.newChoiceId ?? randomUUID)(), doc);
  return { accepted: true };
}

// --- Founder casting ballot (ws-a §4.5 casting variant) --------------------

export async function castCastingBallot(
  store: BallotStore,
  input: { motionId: string; founderUid: string; isFounder: boolean; choice: BallotChoice; now?: Date },
): Promise<{ ballotId: string }> {
  const motion = await requireMotion(store, input.motionId);
  if (motion.status !== "closed_tied_pending_casting") {
    throw new BallotError("not_tied", 409, "Casting ballot is only accepted while a tie is pending casting");
  }
  if (!input.isFounder) throw new BallotError("founder_only", 403, "Only the Founder may cast the casting ballot");
  const ballotId = castingBallotId(input.motionId);
  if (await store.getBallot(ballotId)) {
    throw new BallotError("already_voted", 409, "The casting ballot has already been cast");
  }
  await store.putBallot(ballotId, {
    motionId: input.motionId,
    meetingId: motion.meetingId ?? "",
    voterUid: input.founderUid,
    choice: input.choice,
    isProxy: false,
    proxyForUid: null,
    proxyAuthorizationId: null,
    isCastingVote: true,
    interestDisclosure: null,
    castAt: input.now ?? new Date(),
  });
  return { ballotId };
}

// --- Close + counting (ws-a §4.5 close) -------------------------------------

export interface CloseOutcome {
  status: MotionRef["status"];
  tied: boolean;
  /** Totals only — aggregates, never per-voter choices. Null while tied. */
  result: MotionResult | null;
  tallies: { votesFor: number; votesAgainst: number; abstentions: number };
}

/**
 * ADAPTER (decisions register): on final close the motions service writes
 * the decisions entry via decisions-client and any filing task (ws-a §4.5).
 * That write is the caller's step, driven by the returned CloseOutcome, so
 * this slice never writes the decisions collection directly.
 */
export async function closeMotionBallots(store: BallotStore, input: { motionId: string }): Promise<CloseOutcome> {
  const motion = await requireMotion(store, input.motionId);
  if (motion.status !== "open" && motion.status !== "closed_tied_pending_casting") {
    throw new BallotError("motion_not_open", 409, `Motion is ${motion.status}`);
  }
  const ballots = await store.listBallots(input.motionId);
  const casting = findCastingBallot(ballots);
  const tallies =
    motion.method === "secret_ballot"
      ? tallyChoices((await store.listSecretChoices(input.motionId)).map((c) => c.choice))
      : tallyBallots(ballots);

  const evaluation = evaluateBallotOutcome({
    bodyType: motion.bodyType,
    threshold: motion.threshold,
    denominatorSnapshot: motion.denominatorSnapshot,
    tallies,
    castingChoice: casting?.choice ?? null,
  });

  if (evaluation.outcome === "tie_pending_casting") {
    await store.saveMotion({ ...motion, status: "closed_tied_pending_casting" });
    return { status: "closed_tied_pending_casting", tied: true, result: null, tallies };
  }
  const status = evaluation.outcome === "passed" ? "closed_passed" : "closed_failed";
  await store.saveMotion({ ...motion, status });
  if (motion.method === "secret_ballot") {
    // Issue log has served its purpose (double-issue prevention); totals are
    // taken, so delete it at close per ws-a §4.5 — nothing linkable remains.
    await store.deleteTokenIssueLog(input.motionId);
  }
  return { status, tied: false, result: evaluation.result, tallies };
}
