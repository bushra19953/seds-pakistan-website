/**
 * G4 SEAM — decisions + urgent decisions + ratifications (Supabase).
 * Plan: cluster_meetings_PLAN.md §1-G4, §2-G4, §3, §8 (built FIRST:
 * the decisions client is consumed by the G2 close and G3 pass paths).
 *
 * Holds Supa implementations of:
 *   - FirestoreDecisionsClient      -> SupaDecisionsClient
 *   - FirestoreUrgentStore          -> SupaUrgentStore
 *   - FirestoreDecisionClassesReader-> SupaDecisionClassesReader
 *   - FirestoreConsentsClient       -> SupaConsentsClient (READ side
 *     only for this cluster; the consents cluster owns its writes)
 *   - the decisions route's direct Admin SDK reads
 *     (readDecisionsFromSupa, used by src/app/api/governance/
 *     decisions/route.ts behind the 'decisions' flag)
 *
 * Behaviour contract:
 * - Composition (getGovernanceRouteDeps) substitutes these classes
 *   ONLY when govSupaAdapterFor('decisions') returns an adapter;
 *   flag OFF / unconfigured = the Firestore classes, byte-identical.
 * - Every method delegates to the Firestore counterpart on adapter
 *   error (fallback), so a Supa failure degrades to today's path.
 * - APPEND-ONLY register, owned transitions only, with the Firestore
 *   impl's error codes preserved exactly (plan C-3: the transition is
 *   get -> validate -> update, NOT a transaction — replicated, not
 *   "fixed"; the interface layer's `decision_transition_not_owned`
 *   code lives in decisions-client.ts and is untouched).
 * - Ratifications ruling (plan C-1): there is NO `ratifications`
 *   collection in this cluster. Ratification writes the
 *   `urgent_decisions` record + the `decisions` register entry only.
 *   This seam creates no fs_ratifications mapping and does not touch
 *   lifecycle-ratification.ts.
 * - FirestoreFilingTaskCreator (writes `tasks`) STAYS on Firestore
 *   (tasks cluster owns it, plan §5); it is not re-implemented here.
 * - Urgent records carry epoch-ms NUMBER fields (*Ms) by design;
 *   they pass through untouched (plan §3 rule 1).
 * - CUTOVER (write primacy, isSupaPrimary('decisions')): writeDecision,
 *   transitionDecisionStatus, and the urgent store's create/save run
 *   Supa-primary — the Supa write commits (adapter failure
 *   propagates, never a silent Firestore-primary fallback) and the
 *   Firestore counterpart mirrors post-commit, best-effort, under the
 *   same id. SUPA_PRIMARY off = the behaviour above, byte-identical.
 */

import type { UrgentDecisionRecord } from "@/lib/governance/urgent-decisions";
import {
  OWNED_DECISION_TRANSITIONS,
  type DecisionEntry,
  type DecisionEntryInput,
  type DecisionsClient,
} from "./decisions-client";
import { isDecidedConsentStatus, type ConsentView, type ConsentsClient } from "./consents-client";
import type { DecisionClassesReader, ServerDecisionClassView } from "./decision-classes";
import type { UrgentStore } from "./urgent";
import { GovernanceServiceError } from "./shared";
import { toDate } from "./firestore-stores";
import {
  govSupaAdapterFor,
  govSupaPrimaryFor,
  mirrorToFirestore,
  newFirestoreId,
  reviveDatesDeep,
  stripDocId,
  type GovSupaAdapter,
} from "./supa-shared";

function reqDate(v: unknown, fallback: Date): Date {
  return toDate(v) ?? fallback;
}

/** Mirror of firestore-stores' entryFromDoc over an adapter doc body. */
function entryFromData(id: string, raw: Record<string, unknown>): DecisionEntry {
  const data = reviveDatesDeep(raw) as Record<string, unknown>;
  return {
    ...(data as unknown as DecisionEntry),
    id,
    decidedAt: reqDate(data.decidedAt, new Date(0)),
    effectiveAt: reqDate(data.effectiveAt, new Date(0)),
    ratifiedAt: toDate(data.ratifiedAt),
    voidedAt: toDate(data.voidedAt),
    voidEffectiveFrom: toDate(data.voidEffectiveFrom),
    retentionUntil: reqDate(data.retentionUntil, new Date(0)),
  } as DecisionEntry;
}

export class SupaDecisionsClient implements DecisionsClient {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: DecisionsClient & { isEffectiveDecision(id: string): Promise<boolean> },
    /**
     * Cutover write primacy: the Firestore mirror writer for a
     * committed register entry, injected by the composition
     * (firestore-stores.ts) because the DecisionsClient interface
     * itself cannot write by id (its writeDecision generates the id).
     * Only used when isSupaPrimary('decisions') is on.
     */
    private mirrorWriteDecision?: (entry: DecisionEntry) => Promise<void>,
  ) {}

  async writeDecision(input: DecisionEntryInput): Promise<DecisionEntry> {
    if (govSupaPrimaryFor("decisions")) {
      // Primary path: the Supa write is the commit (an adapter
      // failure propagates — no silent Firestore-primary fallback);
      // Firestore is mirrored post-commit, best-effort, under the
      // SAME register id.
      const id = newFirestoreId();
      const entry: DecisionEntry = { ...input, id };
      await this.adapter.setDoc("decisions", id, { ...entry });
      if (this.mirrorWriteDecision) {
        await mirrorToFirestore(`decisions/${id}`, () => this.mirrorWriteDecision!(entry));
      } else {
        console.error(
          `[supa-governance] no Firestore mirror writer injected for decisions/${id} (committed in Supabase only)`,
        );
      }
      return entry;
    }
    try {
      const id = newFirestoreId();
      const entry: DecisionEntry = { ...input, id };
      await this.adapter.setDoc("decisions", id, { ...entry });
      return entry;
    } catch {
      return this.fallback.writeDecision(input);
    }
  }

  async getDecision(id: string): Promise<DecisionEntry | null> {
    try {
      const doc = await this.adapter.getDoc("decisions", id);
      return doc ? entryFromData(id, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getDecision(id);
    }
  }

  async transitionDecisionStatus(
    id: string,
    to: "ratified" | "void",
    meta: { ratifiedAt?: Date; voidedAt?: Date; voidEffectiveFrom?: Date },
  ): Promise<DecisionEntry> {
    // C-3 faithful replication: plain get -> validate -> updateDoc,
    // NOT a transaction; the check-then-write race profile is today's.
    let current: DecisionEntry | null;
    try {
      const doc = await this.adapter.getDoc("decisions", id);
      current = doc ? entryFromData(id, stripDocId(doc)) : null;
    } catch {
      return this.fallback.transitionDecisionStatus(id, to, meta);
    }
    if (!current) {
      throw new GovernanceServiceError("decision_not_found", 404, `No decision with id ${id}`);
    }
    const allowed = OWNED_DECISION_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(to)) {
      throw new GovernanceServiceError(
        "invalid_decision_transition",
        422,
        `Decision in status ${current.status} cannot transition to ${to} through this API`,
      );
    }
    const patch: Record<string, unknown> = { status: to };
    if (to === "ratified") patch.ratifiedAt = meta.ratifiedAt ?? new Date();
    if (to === "void") {
      patch.voidedAt = meta.voidedAt ?? new Date();
      patch.voidEffectiveFrom = meta.voidEffectiveFrom ?? meta.voidedAt ?? new Date();
    }
    if (govSupaPrimaryFor("decisions")) {
      // Primary path: Supa update is the commit (failure propagates);
      // the Firestore transition runs as the post-commit mirror,
      // best-effort (it re-validates against the mirrored entry).
      await this.adapter.updateDoc("decisions", id, patch);
      await mirrorToFirestore(`decisions/${id} transition`, () =>
        this.fallback.transitionDecisionStatus(id, to, meta),
      );
      return { ...current, ...patch } as DecisionEntry;
    }
    try {
      await this.adapter.updateDoc("decisions", id, patch);
    } catch {
      return this.fallback.transitionDecisionStatus(id, to, meta);
    }
    return { ...current, ...patch } as DecisionEntry;
  }

  async isEffectiveDecision(decisionId: string): Promise<boolean> {
    const e = await this.getDecision(decisionId);
    return e !== null && e.status === "effective";
  }
}

export class SupaUrgentStore implements UrgentStore {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: {
      createDecision(rec: UrgentDecisionRecord): Promise<void>;
      getDecision(id: string): Promise<UrgentDecisionRecord | null>;
      saveDecision(rec: UrgentDecisionRecord): Promise<void>;
      listDecisions(): Promise<UrgentDecisionRecord[]>;
      nextId(): string;
    },
  ) {}

  async createDecision(rec: UrgentDecisionRecord): Promise<void> {
    if (govSupaPrimaryFor("decisions")) {
      await this.adapter.setDoc("urgent_decisions", rec.id, { ...rec });
      await mirrorToFirestore(`urgent_decisions/${rec.id}`, () => this.fallback.createDecision(rec));
      return;
    }
    try {
      await this.adapter.setDoc("urgent_decisions", rec.id, { ...rec });
    } catch {
      return this.fallback.createDecision(rec);
    }
  }

  async getDecision(id: string): Promise<UrgentDecisionRecord | null> {
    try {
      const doc = await this.adapter.getDoc("urgent_decisions", id);
      return doc ? ({ ...reviveDatesDeep(stripDocId(doc)), id } as UrgentDecisionRecord) : null;
    } catch {
      return this.fallback.getDecision(id);
    }
  }

  async saveDecision(rec: UrgentDecisionRecord): Promise<void> {
    if (govSupaPrimaryFor("decisions")) {
      await this.adapter.setDoc("urgent_decisions", rec.id, { ...rec }, { merge: true });
      await mirrorToFirestore(`urgent_decisions/${rec.id}`, () => this.fallback.saveDecision(rec));
      return;
    }
    try {
      await this.adapter.setDoc("urgent_decisions", rec.id, { ...rec }, { merge: true });
    } catch {
      return this.fallback.saveDecision(rec);
    }
  }

  /** FULL-COLLECTION read, verbatim (census C16 — no filter added). */
  async listDecisions(): Promise<UrgentDecisionRecord[]> {
    try {
      const docs = await this.adapter.listDocs("urgent_decisions");
      return docs.map(
        (d) => ({ ...reviveDatesDeep(stripDocId(d)), id: d.id }) as UrgentDecisionRecord,
      );
    } catch {
      return this.fallback.listDecisions();
    }
  }

  nextId(): string {
    return newFirestoreId();
  }
}

function classFromData(id: string, data: Record<string, unknown>): ServerDecisionClassView {
  return {
    id,
    label: String(data.label ?? id),
    assignedBodyType: String(data.assignedBodyType ?? ""),
    majorityType: data.majorityType as ServerDecisionClassView["majorityType"],
    numerator: (data.numerator as number | null) ?? null,
    denominatorKind: data.denominatorKind as ServerDecisionClassView["denominatorKind"],
    consentRequired: Boolean(data.consentRequired),
    isReservedMatter: Boolean(data.isReservedMatter),
    filingFlag: Boolean(data.filingFlag),
    sourceRow: String(data.sourceRow ?? ""),
    enforcementMode: data.enforcementMode === "enforce" ? "enforce" : "warn-only",
  };
}

export class SupaDecisionClassesReader implements DecisionClassesReader {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: DecisionClassesReader & {
      getClass(id: string): Promise<ServerDecisionClassView | null>;
      listClasses(): Promise<ServerDecisionClassView[]>;
    },
  ) {}

  async getClass(classId: string): Promise<ServerDecisionClassView | null> {
    try {
      const doc = await this.adapter.getDoc("decisionClasses", classId);
      return doc ? classFromData(classId, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getClass(classId);
    }
  }

  /** FULL-COLLECTION read, verbatim (census C16 — no filter added). */
  async listClasses(): Promise<ServerDecisionClassView[]> {
    try {
      const docs = await this.adapter.listDocs("decisionClasses");
      return docs.map((d) => classFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listClasses();
    }
  }
}

function consentFromData(id: string, data: Record<string, unknown>): ConsentView {
  return {
    id,
    matter: String(data.matter ?? ""),
    proposedAct: String(data.proposedAct ?? data.matter ?? ""),
    status: data.status as ConsentView["status"],
    decidedAt: toDate(reviveDatesDeep(data.decidedAt)),
    decidedBy: String(data.decidedBy ?? ""),
    meetingId: (data.meetingId as string | null) ?? null,
  };
}

/** READ side only (consents cluster owns consent writes — plan §1-G4). */
export class SupaConsentsClient implements ConsentsClient {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: ConsentsClient & {
      listConsentsForMeeting(meetingId: string): Promise<ConsentView[]>;
      listDecidedConsents(): Promise<ConsentView[]>;
    },
  ) {}

  async getConsent(consentId: string): Promise<ConsentView | null> {
    try {
      const doc = await this.adapter.getDoc("consent_requests", consentId);
      return doc ? consentFromData(consentId, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getConsent(consentId);
    }
  }

  async isDecidedConsent(consentId: string): Promise<boolean> {
    const consent = await this.getConsent(consentId);
    return consent !== null && isDecidedConsentStatus(consent.status);
  }

  async listConsentsForMeeting(meetingId: string): Promise<ConsentView[]> {
    try {
      const docs = await this.adapter.listDocs("consent_requests", {
        where: [["meetingId", "==", meetingId]],
      });
      return docs.map((d) => consentFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listConsentsForMeeting(meetingId);
    }
  }

  async listDecidedConsents(): Promise<ConsentView[]> {
    try {
      const docs = await this.adapter.listDocs("consent_requests", {
        where: [["status", "in", ["granted", "conditional"]]],
      });
      return docs.map((d) => consentFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listDecidedConsents();
    }
  }
}

/* ------------------------------------------------ decisions route reads */

/**
 * The decisions route's direct reads (plan §1-G4): single read by id,
 * or the list read with optional bodyId filter, `decidedAt` DESC,
 * limit 200 — reproduced exactly. Returns RAW doc bodies (the route's
 * own serializeDecision converts the six DATE_FIELDS); a top-level
 * stored `id` field, if any, is overridden by the doc id, exactly as
 * the Firestore path's `{ id: snap.id, ... }` serialisation does.
 * Returns null when the 'decisions' surface is off/unconfigured, so
 * the route runs its Firestore path byte-identically.
 */
export async function readDecisionsFromSupa(input: {
  id?: string | null;
  bodyId?: string | null;
}): Promise<{ found: boolean; doc?: Record<string, unknown>; docs?: Array<Record<string, unknown>> } | null> {
  const adapter = govSupaAdapterFor("decisions");
  if (!adapter) return null;
  try {
    if (input.id) {
      const doc = await adapter.getDoc("decisions", input.id);
      if (!doc) return { found: false };
      return { found: true, doc: { ...stripDocId(doc), id: input.id } };
    }
    const docs = await adapter.listDocs("decisions", {
      ...(input.bodyId
        ? { where: [["bodyId", "==", input.bodyId] as [string, "==", unknown]] }
        : {}),
      orderBy: { field: "decidedAt", direction: "desc" },
      limit: 200,
    });
    return {
      found: true,
      docs: docs.map((d) => ({ ...stripDocId(d), id: d.id })),
    };
  } catch {
    return null; // adapter error -> Firestore fallback at the route
  }
}
