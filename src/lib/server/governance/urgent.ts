/**
 * Urgent decisions service (ws-a §3.13, §4.8, §6.5) — server only.
 *
 * All deadline math lives in the pure module
 * (src/lib/governance/urgent-decisions.ts); this service owns the gates,
 * persistence, the register entry (ONLY through decisions-client), and
 * notifications. Nothing is ever deleted: an unratified decision voids
 * RETROACTIVELY (the register entry voids effective from the original
 * createdAt) and the record stays.
 *
 * ADAPTER (role key): the National President gate compares the caller's
 * canonical role key against NATIONAL_PRESIDENT_ROLE_KEY. The route
 * resolves the key via resolveCanonicalRole (Phase 1 role store); if the
 * Phase 1 catalog names the office differently, only this constant
 * changes.
 *
 * ADAPTER (store): persistence goes through `UrgentStore`;
 * `InMemoryUrgentStore` implements it for local tests; the Firestore
 * implementation is in firestore-stores.ts (ms fields map to Firestore
 * Timestamps at that boundary).
 *
 * ADAPTER (notification): dispatch goes through `UrgentNotifier`; the
 * production implementation wraps the repo mailer (templates
 * urgent_decision_notice / urgent_decision_voided) + notificationService.
 */

import {
  URGENT_VOID_REASON_RATIFICATION_EXPIRED,
  checkRatifiable,
  isEscalationDue,
  isRatificationExpired,
  notificationDueAt,
  ratificationDueAt,
  statusAfterConfirmation,
  type UrgentDecisionRecord,
} from "@/lib/governance/urgent-decisions";
import type { DecisionsClient } from "./decisions-client";
import type { DecisionClassesReader } from "./decision-classes";
import { GovernanceServiceError, type BodyReader, type BodyView } from "./shared";

/** Phase 1 catalog key for the National President office (ADAPTER, see header). */
export const NATIONAL_PRESIDENT_ROLE_KEY = "president_national";

export interface UrgentStore {
  getDecision(id: string): Promise<UrgentDecisionRecord | null>;
  saveDecision(rec: UrgentDecisionRecord): Promise<void>;
  listDecisions(): Promise<UrgentDecisionRecord[]>;
}

export class InMemoryUrgentStore implements UrgentStore {
  private docs = new Map<string, UrgentDecisionRecord>();
  private seq = 0;

  nextId(): string {
    return `urgent_${++this.seq}`;
  }

  async getDecision(id: string): Promise<UrgentDecisionRecord | null> {
    return this.docs.get(id) ?? null;
  }

  async saveDecision(rec: UrgentDecisionRecord): Promise<void> {
    this.docs.set(rec.id, rec);
  }

  async listDecisions(): Promise<UrgentDecisionRecord[]> {
    return [...this.docs.values()];
  }
}

export interface UrgentNotifier {
  /** Board + Founder notification at submit (dispatch is synchronous). */
  submitted(rec: UrgentDecisionRecord, boardMemberUids: string[]): Promise<void>;
  /** T4 escalation to the Founder at 24h unconfirmed. */
  escalated(rec: UrgentDecisionRecord): Promise<void>;
  /** T5 void notification: President, Board, Founder, affected parties. */
  voided(rec: UrgentDecisionRecord, notifyUids: string[]): Promise<void>;
}

export const noopUrgentNotifier: UrgentNotifier = {
  async submitted() {},
  async escalated() {},
  async voided() {},
};

/** Body lookup by type: the ratifying body is the class's assigned body. */
export interface BodyDirectory {
  getBodyByType(bodyType: string): Promise<BodyView | null>;
}

export class InMemoryBodyDirectory implements BodyDirectory {
  constructor(private bodies: BodyView[] = []) {}

  async getBodyByType(bodyType: string): Promise<BodyView | null> {
    return this.bodies.find((b) => b.type === bodyType) ?? null;
  }
}

export interface UrgentDeps {
  store: UrgentStore;
  classes: DecisionClassesReader;
  decisions: DecisionsClient;
  bodies: BodyReader;
  bodyDirectory: BodyDirectory;
  notifier?: UrgentNotifier;
  newId?: () => string;
}

function err(code: string, status: number, message: string): GovernanceServiceError {
  return new GovernanceServiceError(code, status, message);
}

async function mustGet(deps: UrgentDeps, id: string): Promise<UrgentDecisionRecord> {
  const rec = await deps.store.getDecision(id);
  if (!rec) throw err("urgent_decision_not_found", 404, `No urgent decision with id ${id}`);
  return rec;
}

/**
 * Submit (ws-a §4.8). National President ONLY: a Founder submit is 403
 * president_only (the documents name the President only, so the record
 * stays honest), as is any other non-President actor. A Reserved Matter
 * class is a HARD block: 422 reserved_matter_blocked, no override
 * parameter exists, and nothing is created.
 */
export async function submitUrgentDecision(
  deps: UrgentDeps,
  input: {
    actorUid: string;
    actorRoleKey: string | null;
    isFounderActor: boolean;
    title: string;
    description: string;
    decisionClassId: string;
    harmStatement: string;
    affectedPartyUids: string[];
    at: Date;
  },
): Promise<{ record: UrgentDecisionRecord; registerDecisionId: string }> {
  if (input.isFounderActor || input.actorRoleKey !== NATIONAL_PRESIDENT_ROLE_KEY) {
    throw err(
      "president_only",
      403,
      "Urgent decisions may only be submitted by the National President; the Founder may not submit acting as President",
    );
  }
  if (!input.harmStatement || input.harmStatement.trim().length === 0) {
    throw err("harm_statement_required", 422, "A harm statement (why delay would harm SEDS Pakistan) is required");
  }
  const cls = await deps.classes.getClass(input.decisionClassId);
  if (!cls) throw err("decision_class_not_found", 422, `No decision class with id ${input.decisionClassId}`);
  if (cls.isReservedMatter) {
    throw err(
      "reserved_matter_blocked",
      422,
      "Urgent decisions cannot decide a Reserved Matter (Doc 04 sec 4.10); no override exists",
    );
  }
  const ratifyingBody = await deps.bodyDirectory.getBodyByType(cls.assignedBodyType);
  if (!ratifyingBody) {
    throw err("ratifying_body_not_found", 422, `No body of type ${cls.assignedBodyType} exists to ratify this class`);
  }

  const atMs = input.at.getTime();
  const id = deps.newId ? deps.newId() : `urgent_${atMs}`;
  const entry = await deps.decisions.writeDecision({
    bodyId: ratifyingBody.id,
    decisionClassId: cls.id,
    source: "urgent",
    sourceId: id,
    text: input.title,
    outcome: "effective",
    votingSummary: {
      votesFor: 0,
      votesAgainst: 0,
      abstentions: 0,
      denominator: ratifyingBody.memberUids.length,
      thresholdApplied: { majorityType: cls.majorityType, numerator: cls.numerator },
    },
    consentId: null,
    decidedAt: input.at,
    effectiveAt: input.at,
    status: "pending_ratification",
    supersedesDecisionId: null,
    retentionUntil: ratificationDueAt(input.at),
  });

  const record: UrgentDecisionRecord = {
    id,
    presidentUid: input.actorUid,
    title: input.title,
    description: input.description,
    decisionClassId: cls.id,
    harmStatement: input.harmStatement,
    status: "notified_pending_confirmation",
    createdAtMs: atMs,
    notificationDueAtMs: notificationDueAt(input.at).getTime(),
    notifiedAtMs: atMs,
    notificationConfirmedAtMs: null,
    notificationConfirmedBy: null,
    escalatedToFounderAtMs: null,
    ratifyingBodyId: ratifyingBody.id,
    ratificationDueAtMs: ratificationDueAt(input.at).getTime(),
    ratificationDecisionId: null,
    ratificationMotionId: null,
    voidedAtMs: null,
    voidReason: null,
    affectedPartyUids: [...input.affectedPartyUids],
    decisionId: entry.id,
  };
  await deps.store.saveDecision(record);
  if (deps.notifier) await deps.notifier.submitted(record, ratifyingBody.memberUids);
  return { record, registerDecisionId: entry.id };
}

/**
 * Confirm notification (ws-a §4.8): any Board member or the Founder.
 * Idempotent: confirming an already-confirmed decision changes nothing.
 */
export async function confirmUrgentNotification(
  deps: UrgentDeps,
  input: { decisionId: string; actorUid: string; at: Date },
): Promise<UrgentDecisionRecord> {
  const rec = await mustGet(deps, input.decisionId);
  if (rec.notificationConfirmedAtMs !== null) return rec;
  const next: UrgentDecisionRecord = {
    ...rec,
    status: statusAfterConfirmation(rec.status),
    notificationConfirmedAtMs: input.at.getTime(),
    notificationConfirmedBy: input.actorUid,
  };
  await deps.store.saveDecision(next);
  return next;
}

/**
 * Ratify (ws-a §4.8, §6.5): the ratification must be a real decisions
 * entry produced by a passed motion or circular in the ratifying body.
 * The entry must exist, its class must match this decision's class, and
 * its outcome must be passed or effective — otherwise 422
 * ratification_decision_invalid. On success BOTH docs flip: the urgent
 * record to ratified and the register entry through the owned transition.
 */
export async function ratifyUrgentDecision(
  deps: UrgentDeps,
  input: {
    decisionId: string;
    ratificationDecisionId: string;
    ratificationMotionId: string | null;
    actorUid: string;
    actorBodyIds: string[];
    at: Date;
  },
): Promise<UrgentDecisionRecord> {
  const rec = await mustGet(deps, input.decisionId);
  if (!input.actorBodyIds.includes(rec.ratifyingBodyId)) {
    throw err("forbidden", 403, "Only a member of the ratifying body may record its ratification");
  }
  const check = checkRatifiable(rec, input.at.getTime());
  if (!check.ok) {
    const status = check.error_code === "ratification_deadline_expired" ? 422 : 409;
    throw err(check.error_code, status, `This urgent decision cannot be ratified: ${check.error_code}`);
  }
  const ratification = await deps.decisions.getDecision(input.ratificationDecisionId);
  if (
    !ratification ||
    ratification.decisionClassId !== rec.decisionClassId ||
    (ratification.outcome !== "passed" && ratification.outcome !== "effective") ||
    ratification.bodyId !== rec.ratifyingBodyId
  ) {
    throw err(
      "ratification_decision_invalid",
      422,
      "The ratification must be an existing decisions entry of the same class, from the ratifying body, with outcome passed or effective",
    );
  }
  const next: UrgentDecisionRecord = {
    ...rec,
    status: "ratified",
    ratificationDecisionId: input.ratificationDecisionId,
    ratificationMotionId: input.ratificationMotionId,
  };
  await deps.store.saveDecision(next);
  await deps.decisions.transitionDecisionStatus(rec.decisionId, "ratified", { ratifiedAt: input.at });
  return next;
}

export interface UrgentTimerSummary {
  urgentEscalated: number;
  urgentVoided: number;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Urgent-decision timers (ws-a §6.6 T4 + T5), as a Decisions-owned
 * processor. The governance-timers cron route itself is owned by the
 * Meetings Core crew (their contract §5b); this processor is the urgent
 * half of its work list and is written to be called from that route (or
 * any scheduler) with the same summary field names. Every item is
 * idempotent and failure-isolated: one bad record never aborts the run.
 *
 * T4: notification unconfirmed at 24h -> escalate to the Founder, ONCE
 * (the escalatedToFounderAtMs stamp is the guard).
 * T5: unratified at 30 days -> void_retroactive; the register entry voids
 * effective FROM the original createdAt; nobody is notified silently —
 * President, Board, Founder, and affected parties are all notified;
 * nothing is deleted.
 */
export async function processUrgentTimers(
  deps: UrgentDeps,
  opts: { now: Date; pageSize?: number },
): Promise<UrgentTimerSummary> {
  const summary: UrgentTimerSummary = { urgentEscalated: 0, urgentVoided: 0, errors: [] };
  const pageSize = opts.pageSize ?? 50;
  const nowMs = opts.now.getTime();
  const all = await deps.store.listDecisions();
  const pending = all.filter((r) => r.status === "notified_pending_confirmation" || r.status === "active_pending_ratification");

  // T5 first: a decision past BOTH deadlines voids; it must not also escalate.
  for (const rec of pending.slice(0, pageSize)) {
    try {
      if (isRatificationExpired(rec, nowMs)) {
        const voided: UrgentDecisionRecord = {
          ...rec,
          status: "void_retroactive",
          voidedAtMs: nowMs,
          voidReason: URGENT_VOID_REASON_RATIFICATION_EXPIRED,
        };
        await deps.store.saveDecision(voided);
        await deps.decisions.transitionDecisionStatus(rec.decisionId, "void", {
          voidedAt: opts.now,
          voidEffectiveFrom: new Date(rec.createdAtMs),
        });
        if (deps.notifier) {
          const body = await deps.bodies.getBody(rec.ratifyingBodyId);
          const notifyUids = [
            rec.presidentUid,
            ...(body?.memberUids ?? []),
            ...rec.affectedPartyUids,
          ];
          await deps.notifier.voided(voided, [...new Set(notifyUids)]);
        }
        summary.urgentVoided += 1;
      }
    } catch (e) {
      summary.errors.push({ id: rec.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const rec of pending.slice(0, pageSize)) {
    try {
      if (rec.status === "void_retroactive") continue;
      const current = (await deps.store.getDecision(rec.id)) ?? rec;
      if (current.status === "void_retroactive") continue;
      if (isEscalationDue(current, nowMs)) {
        const escalated: UrgentDecisionRecord = { ...current, escalatedToFounderAtMs: nowMs };
        await deps.store.saveDecision(escalated);
        if (deps.notifier) await deps.notifier.escalated(escalated);
        summary.urgentEscalated += 1;
      }
    } catch (e) {
      summary.errors.push({ id: rec.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return summary;
}
