/**
 * Circular resolutions service (ws-a §3.12, §4.7, §6.6 T3) — server only.
 *
 * All outcome arithmetic lives in the pure engine
 * (src/lib/governance/circular/engine.ts); this service owns persistence,
 * the consent gate, the decisions-register write (ONLY through
 * decisions-client), and the filing task on a flagged pass.
 *
 * ADAPTER (store): persistence goes through `CircularStore`.
 * `InMemoryCircularStore` implements it for local tests; the Firestore
 * implementation is in firestore-stores.ts and maps each method 1:1 to
 * the `circular_resolutions` collection.
 *
 * ADAPTER (notification): circulation and pass notifications (email +
 * in-app, ws-a §4.7/§5) go through `CircularNotifier`; the production
 * implementation wraps the repo mailer + notificationService. The default
 * is a no-op recorder so the service stays testable offline.
 */

import {
  CircularEngineError,
  castVote,
  closesAtFor,
  effectiveRequiredCount,
  evaluateAutoClose,
  evaluateOutcome,
  tallyVotes,
} from "@/lib/governance/circular/engine";
import {
  majorityNeeded,
  snapshotThreshold,
} from "@/lib/governance/circular/threshold";
import type { CircularResolution } from "@/lib/governance/circular/types";
import type { ConsentsClient } from "./consents-client";
import type { DecisionClassesReader } from "./decision-classes";
import type { DecisionsClient } from "./decisions-client";
import {
  GovernanceServiceError,
  filingDeadlineFor,
  type BodyReader,
  type FilingTaskCreator,
} from "./shared";

export interface CircularStore {
  getResolution(id: string): Promise<CircularResolution | null>;
  saveResolution(res: CircularResolution): Promise<void>;
  listResolutions(): Promise<CircularResolution[]>;
}

export class InMemoryCircularStore implements CircularStore {
  private docs = new Map<string, CircularResolution>();
  private seq = 0;

  nextId(): string {
    return `circ_${++this.seq}`;
  }

  async getResolution(id: string): Promise<CircularResolution | null> {
    return this.docs.get(id) ?? null;
  }

  async saveResolution(res: CircularResolution): Promise<void> {
    this.docs.set(res.id, res);
  }

  async listResolutions(): Promise<CircularResolution[]> {
    return [...this.docs.values()];
  }
}

export interface CircularNotifier {
  circulated(res: CircularResolution, governorUids: string[]): Promise<void>;
  passed(res: CircularResolution): Promise<void>;
}

export const noopCircularNotifier: CircularNotifier = {
  async circulated() {},
  async passed() {},
};

export interface CircularDeps {
  store: CircularStore;
  consents: ConsentsClient;
  classes: DecisionClassesReader;
  decisions: DecisionsClient;
  filingTasks: FilingTaskCreator;
  bodies: BodyReader;
  notifier?: CircularNotifier;
  /** Id source for new drafts; defaults to a timestamp-based id. */
  newId?: () => string;
}

function err(code: string, status: number, message: string): GovernanceServiceError {
  return new GovernanceServiceError(code, status, message);
}

async function mustGet(deps: CircularDeps, id: string): Promise<CircularResolution> {
  const res = await deps.store.getResolution(id);
  if (!res) throw err("circular_not_found", 404, `No circular resolution with id ${id}`);
  return res;
}

/**
 * Create a draft (ws-a §4.7). The threshold is copied IMMUTABLY from the
 * class at creation. Board only in v1. A draft without a consent is
 * allowed but warned: circulation will refuse until a decided Consent is
 * attached.
 */
export async function createCircularDraft(
  deps: CircularDeps,
  input: { bodyId: string; title: string; text: string; decisionClassId: string; consentId?: string | null; createdBy: string; at: Date },
): Promise<{ resolution: CircularResolution; warnings: string[] }> {
  const body = await deps.bodies.getBody(input.bodyId);
  if (!body) throw err("body_not_found", 404, `No body with id ${input.bodyId}`);
  if (body.type !== "board") {
    throw err("circular_board_only", 422, "Circular resolutions are Board-only in v1 (ws-a §3.12)");
  }
  const cls = await deps.classes.getClass(input.decisionClassId);
  if (!cls) throw err("decision_class_not_found", 422, `No decision class with id ${input.decisionClassId}`);

  const warnings: string[] = [];
  if (!input.consentId) {
    warnings.push("No Consent attached: circulation will be refused until a decided Consent is attached (ws-a §4.7).");
  }
  const resolution: CircularResolution = {
    id: deps.newId ? deps.newId() : `circ_${input.at.getTime()}`,
    bodyId: body.id,
    bodyType: body.type,
    title: input.title,
    text: input.text,
    decisionClassId: cls.id,
    consentId: input.consentId ?? null,
    status: "draft",
    threshold: snapshotThreshold(cls, 0) as CircularResolution["threshold"],
    circulatedAt: null,
    closesAt: null,
    createdBy: input.createdBy,
    createdAt: input.at,
    updatedAt: input.at,
    governorUidsSnapshot: [],
    signatures: [],
    votes: [],
    signedCount: 0,
    decisionId: null,
    filingTaskId: null,
  };
  await deps.store.saveResolution(resolution);
  return { resolution, warnings };
}

/**
 * Circulate (ws-a §4.7): requires an attached DECIDED Consent (absent,
 * pending, and refused all refuse with 422 consent_not_decided).
 * Snapshots ALL Governors from the body doc; the window is 7 days.
 */
export async function circulateCircular(
  deps: CircularDeps,
  input: { resolutionId: string; actorUid: string; isFounder: boolean; at: Date },
): Promise<{ resolution: CircularResolution; governorCount: number; majorityNeeded: number; closesAt: Date }> {
  const res = await mustGet(deps, input.resolutionId);
  if (res.status !== "draft") {
    throw err("circular_not_draft", 409, `Resolution is ${res.status}, not draft`);
  }
  const body = await deps.bodies.getBody(res.bodyId);
  if (!body) throw err("body_not_found", 404, `No body with id ${res.bodyId}`);
  if (input.actorUid !== res.createdBy && input.actorUid !== body.chairUid && !input.isFounder) {
    throw err("forbidden", 403, "Only the creator, the chair, or the Founder may circulate a resolution");
  }
  if (!res.consentId || !(await deps.consents.isDecidedConsent(res.consentId))) {
    throw err(
      "consent_not_decided",
      422,
      "A circular resolution may only circulate with a decided Consent attached (granted or conditional)",
    );
  }
  const governorUidsSnapshot = [...body.memberUids];
  const circulated: CircularResolution = {
    ...res,
    status: "circulating",
    governorUidsSnapshot,
    circulatedAt: input.at,
    closesAt: closesAtFor(input.at),
    updatedAt: input.at,
  };
  await deps.store.saveResolution(circulated);
  if (deps.notifier) await deps.notifier.circulated(circulated, governorUidsSnapshot);
  return {
    resolution: circulated,
    governorCount: governorUidsSnapshot.length,
    majorityNeeded: effectiveRequiredCount(circulated) ?? majorityNeeded(governorUidsSnapshot.length),
    closesAt: circulated.closesAt!,
  };
}

/**
 * The register + filing side effects of a pass. Guarded on decisionId so
 * a resolution can never write two register entries (ws-a test case 16).
 */
async function recordPassSideEffects(
  deps: CircularDeps,
  res: CircularResolution,
  decidedAt: Date,
): Promise<CircularResolution> {
  if (res.status !== "passed" || res.decisionId !== null) return res;
  const tallies = tallyVotes(res);
  const evaluation = evaluateOutcome(res, { windowEnded: true });
  const entry = await deps.decisions.writeDecision({
    bodyId: res.bodyId,
    decisionClassId: res.decisionClassId,
    source: "circular",
    sourceId: res.id,
    text: res.text,
    outcome: "passed",
    votingSummary: {
      votesFor: tallies.votesFor,
      votesAgainst: tallies.votesAgainst,
      abstentions: tallies.abstentions,
      denominator: evaluation.denominatorUsed,
      thresholdApplied: { ...res.threshold },
    },
    consentId: res.consentId,
    decidedAt,
    effectiveAt: decidedAt,
    status: "effective",
    supersedesDecisionId: null,
    retentionUntil: filingDeadlineFor(decidedAt),
  });
  let filingTaskId = res.filingTaskId;
  if (res.threshold.filingFlag && filingTaskId === null) {
    const body = await deps.bodies.getBody(res.bodyId);
    filingTaskId = await deps.filingTasks.createFilingTask({
      title: `File circular resolution: ${res.title}`,
      description: `File the passed circular resolution "${res.title}" (${res.id}) with the register.`,
      assigneeUid: body?.secretaryUid ?? res.createdBy,
      deadline: filingDeadlineFor(decidedAt),
      sourceKind: "circular",
      sourceId: res.id,
    });
  }
  const recorded: CircularResolution = { ...res, decisionId: entry.id, filingTaskId };
  await deps.store.saveResolution(recorded);
  if (deps.notifier) await deps.notifier.passed(recorded);
  return recorded;
}

/**
 * Sign (ws-a §4.7): one Governor approval signature. The signer must be in
 * the circulation snapshot (403 otherwise); a repeat signature is 409
 * already_signed with NO state change. When the signature reaches the
 * required count the resolution closes as passed immediately and the
 * register entry (plus filing task when flagged) is written exactly once.
 */
export async function signCircular(
  deps: CircularDeps,
  input: { resolutionId: string; uid: string; displayName: string; at: Date },
): Promise<{ signedCount: number; majorityNeeded: number; status: CircularResolution["status"] }> {
  const res = await mustGet(deps, input.resolutionId);
  let next: CircularResolution;
  try {
    next = castVote(res, { uid: input.uid, displayName: input.displayName, choice: "for", at: input.at });
  } catch (e) {
    if (e instanceof CircularEngineError) {
      if (e.code === "already_voted") throw err("already_signed", 409, "This Governor has already signed");
      if (e.code === "not_eligible") throw err("not_a_governor", 403, "Only a Governor in the circulation snapshot may sign");
      if (e.code === "window_closed") throw err("window_closed", 422, e.message);
      if (e.code === "window_not_open") throw err("window_not_open", 422, e.message);
      throw err("not_circulating", 409, e.message);
    }
    throw e;
  }
  await deps.store.saveResolution(next);
  if (next.status === "passed") {
    next = await recordPassSideEffects(deps, next, input.at);
  }
  return {
    signedCount: next.signedCount,
    majorityNeeded: effectiveRequiredCount(next) ?? majorityNeeded(next.governorUidsSnapshot.length),
    status: next.status,
  };
}

/**
 * T3 backstop at service level (ws-a §6.6): close a circulating resolution
 * whose window has passed — passed (with side effects, guarded on
 * decisionId null) or lapsed (never a register entry). The governance
 * timers service (Meetings Core) scans and calls this per resolution.
 */
export async function autoCloseCircular(
  deps: CircularDeps,
  input: { resolutionId: string; now: Date },
): Promise<{ transition: "passed" | "lapsed" | null }> {
  const res = await mustGet(deps, input.resolutionId);
  const { resolution, transition } = evaluateAutoClose(res, input.now);
  if (transition === null) return { transition: null };
  await deps.store.saveResolution(resolution);
  if (transition === "passed") {
    await recordPassSideEffects(deps, resolution, input.now);
  }
  return { transition };
}
