/**
 * Firestore implementations of the governance stores (ws-a §3 schemas)
 * plus the production deps factory used by the governance API routes.
 *
 * Everything here runs on the Admin SDK (getDb()). Client SDK access to
 * these collections is denied by the rules candidates; the API routes
 * are the only write path.
 *
 * Date handling: the Admin SDK stores JS Dates as Timestamps; readers
 * convert Timestamp | Date | string | number back to Date (or epoch-ms
 * where the domain type uses ms). Domain objects never carry raw
 * Timestamps past this module.
 *
 * ADAPTER (decision classes): `FirestoreDecisionClassesReader` reads
 * the Phase 2 `decisionClasses` collection. Until that collection is
 * seeded, reads return null and motions/circulars 422 — the routes do
 * NOT silently fall back to the local matrix, because a silent fallback
 * would hide a missing substrate. Local development uses the in-memory
 * local-matrix reader explicitly (see decision-classes.ts).
 *
 * ADAPTER (attendance): present statuses are the Core §3.4 values in
 * PRESENT_STATUSES below; if Core's stored vocabulary differs, this one
 * constant is the alignment point.
 *
 * ADAPTER (Drive): the signed-minutes pipeline renders with
 * governance-pdf-export and uploads via uploadToVault. The governance
 * Drive folder id comes from GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID; when
 * unset, uploadToVault's vault-folder default applies (go-live wiring).
 *
 * ADAPTER (notifications): deps use the noop notifiers. The mailer
 * templates (ws-a §2.2: circular_circulated, circular_passed, ...) are
 * the production wiring step; services treat notification as a
 * fire-and-forget side effect that never blocks a decision write.
 */

import { getDb } from "@/lib/server/firebase-admin";
import { renderMinutesPdf } from "@/lib/governance-pdf-export";
import { uploadToVault } from "@/lib/drive/client";
import type { Motion } from "@/lib/governance/meetings/motions-types";
import type { MinutesRecord } from "@/lib/governance/minutes-lifecycle";
import type { CircularResolution } from "@/lib/governance/circular/types";
import type { UrgentDecisionRecord } from "@/lib/governance/urgent-decisions";
import type { BallotDoc, ProxyAuthorizationDoc, SecretBallotChoiceDoc, SecretBallotTokenDoc } from "@/lib/governance/meetings/ballots";
import {
  OWNED_DECISION_TRANSITIONS,
  type DecisionEntry,
  type DecisionEntryInput,
  type DecisionsClient,
} from "./decisions-client";
import {
  isDecidedConsentStatus,
  type ConsentView,
  type ConsentsClient,
} from "./consents-client";
import type { DecisionClassesReader, ServerDecisionClassView } from "./decision-classes";
import type { BallotStore } from "./ballots";
import { toMotionRef, type AttendanceReader, type MeetingReader, type MeetingView, type MotionStore } from "./motions";
import type { MinutesPdfPipeline, MinutesStore } from "./minutes";
import type { CircularStore } from "./circular";
import type { UrgentStore, BodyDirectory } from "./urgent";
import {
  GovernanceServiceError,
  type BodyReader,
  type BodyView,
  type FilingTaskCreator,
} from "./shared";
import { govSupaAdapterFor } from "./supa-shared";
import {
  SupaConsentsClient,
  SupaDecisionClassesReader,
  SupaDecisionsClient,
  SupaUrgentStore,
} from "./decisions-supa";
import {
  SupaAttendanceReader,
  SupaBodyReader,
  SupaMeetingReader,
} from "./meetings-supa";
import { SupaBallotStore, SupaMotionStore } from "./motions-supa";
import { SupaCircularStore, SupaMinutesStore } from "./minutes-circular-supa";

type Db = NonNullable<ReturnType<typeof getDb>>;

function db(): Db {
  const d = getDb();
  if (!d) throw new GovernanceServiceError("firestore_unavailable", 503, "Admin SDK is not configured");
  return d;
}

/** Convert any stored time value to a Date (null-safe). */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function reqDate(v: unknown, fallback: Date): Date {
  return toDate(v) ?? fallback;
}

// ---------------------------------------------------------------------------
// Motions + ballots
// ---------------------------------------------------------------------------

function motionFromDoc(id: string, data: FirebaseFirestore.DocumentData): Motion {
  return {
    ...(data as Motion),
    id,
    openedAt: reqDate(data.openedAt, new Date(0)),
    closedAt: toDate(data.closedAt),
    disclosures: ((data.disclosures ?? []) as Motion["disclosures"]).map((d) => ({
      ...d,
      recordedAt: reqDate(d.recordedAt, new Date(0)),
    })),
  } as Motion;
}

export class FirestoreMotionStore implements MotionStore {
  async getMotion(id: string): Promise<Motion | null> {
    const snap = await db().collection("motions").doc(id).get();
    return snap.exists ? motionFromDoc(snap.id, snap.data()!) : null;
  }

  async saveMotion(motion: Motion): Promise<void> {
    await db().collection("motions").doc(motion.id).set({ ...motion }, { merge: true });
  }

  async listMotionsByMeeting(meetingId: string): Promise<Motion[]> {
    const q = await db().collection("motions").where("meetingId", "==", meetingId).get();
    return q.docs.map((d) => motionFromDoc(d.id, d.data()));
  }

  nextId(): string {
    return db().collection("motions").doc().id;
  }
}

export class FirestoreBallotStore implements BallotStore {
  constructor(private motions: MotionStore) {}

  async getMotion(motionId: string) {
    const m = await this.motions.getMotion(motionId);
    return m ? toMotionRef(m) : null;
  }

  async saveMotion(ref: { id: string; status: Motion["status"]; method: Motion["method"]; secretDemandedBy: string[] }) {
    const existing = await this.motions.getMotion(ref.id);
    if (!existing) throw new GovernanceServiceError("motion_not_found", 404, `No motion with id ${ref.id}`);
    await this.motions.saveMotion({
      ...existing,
      status: ref.status,
      method: ref.method,
      secretDemandedBy: [...ref.secretDemandedBy],
    });
  }

  async getBallot(ballotId: string): Promise<BallotDoc | null> {
    const snap = await db().collection("ballots").doc(ballotId).get();
    if (!snap.exists) return null;
    const data = snap.data()!;
    return { ...(data as BallotDoc), castAt: reqDate(data.castAt, new Date(0)) };
  }

  async putBallot(ballotId: string, doc: BallotDoc): Promise<void> {
    await db().collection("ballots").doc(ballotId).set({ ...doc });
  }

  async listBallots(motionId: string): Promise<BallotDoc[]> {
    const q = await db().collection("ballots").where("motionId", "==", motionId).get();
    return q.docs.map((d) => ({ ...(d.data() as BallotDoc), castAt: reqDate(d.data().castAt, new Date(0)) }));
  }

  async getSecretToken(tokenHash: string): Promise<SecretBallotTokenDoc | null> {
    const snap = await db().collection("secret_ballot_tokens").doc(tokenHash).get();
    if (!snap.exists) return null;
    const data = snap.data()!;
    return { motionId: data.motionId, used: Boolean(data.used), usedAt: toDate(data.usedAt) };
  }

  async putSecretToken(tokenHash: string, doc: SecretBallotTokenDoc): Promise<void> {
    await db().collection("secret_ballot_tokens").doc(tokenHash).set({ ...doc });
  }

  async putSecretChoice(choiceId: string, doc: SecretBallotChoiceDoc): Promise<void> {
    await db().collection("secret_ballot_choices").doc(choiceId).set({ ...doc });
  }

  async listSecretChoices(motionId: string): Promise<SecretBallotChoiceDoc[]> {
    const q = await db().collection("secret_ballot_choices").where("motionId", "==", motionId).get();
    return q.docs.map((d) => {
      const data = d.data();
      return { motionId: data.motionId, choice: data.choice, castAt: reqDate(data.castAt, new Date(0)) } as SecretBallotChoiceDoc;
    });
  }

  // Double-issue prevention log: motions/{id}/tokenIssueLog/{uid} — the
  // ONLY place a uid appears near a secret ballot; deleted at close.
  async getTokenIssue(motionId: string, uid: string): Promise<{ issuedAt: Date } | null> {
    const snap = await db().collection("motions").doc(motionId).collection("tokenIssueLog").doc(uid).get();
    if (!snap.exists) return null;
    return { issuedAt: toDate(snap.data()?.issuedAt) ?? new Date(0) };
  }

  async putTokenIssue(motionId: string, uid: string, issuedAt: Date): Promise<void> {
    await db().collection("motions").doc(motionId).collection("tokenIssueLog").doc(uid).set({ issuedAt });
  }

  async deleteTokenIssueLog(motionId: string): Promise<void> {
    const col = db().collection("motions").doc(motionId).collection("tokenIssueLog");
    const q = await col.get();
    const batch = db().batch();
    q.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  async getProxyAuthorization(authId: string): Promise<ProxyAuthorizationDoc | null> {
    const snap = await db().collection("proxyAuthorizations").doc(authId).get();
    if (!snap.exists) return null;
    const data = snap.data()!;
    return { ...(data as ProxyAuthorizationDoc), revokedAt: toDate(data.revokedAt) };
  }
}

// ---------------------------------------------------------------------------
// Minutes
// ---------------------------------------------------------------------------

function minutesFromDoc(id: string, data: FirebaseFirestore.DocumentData): MinutesRecord {
  return {
    ...(data as unknown as MinutesRecord),
    id,
    circulationDueAt: reqDate(data.circulationDueAt, new Date(0)),
    updatedAt: reqDate(data.updatedAt, new Date(0)),
    circulatedAt: toDate(data.circulatedAt),
    signedAt: toDate(data.signedAt),
    retentionUntil: toDate(data.retentionUntil),
  } as MinutesRecord;
}

export class FirestoreMinutesStore implements MinutesStore {
  async getMinutes(id: string): Promise<MinutesRecord | null> {
    const snap = await db().collection("minutes").doc(id).get();
    return snap.exists ? minutesFromDoc(snap.id, snap.data()!) : null;
  }

  async saveMinutes(rec: MinutesRecord): Promise<void> {
    await db().collection("minutes").doc(rec.id).set({ ...rec }, { merge: true });
  }

  async listMinutes(): Promise<MinutesRecord[]> {
    const q = await db().collection("minutes").get();
    return q.docs.map((d) => minutesFromDoc(d.id, d.data()));
  }

  async getByMeetingId(meetingId: string): Promise<MinutesRecord | null> {
    const q = await db().collection("minutes").where("meetingId", "==", meetingId).limit(1).get();
    return q.empty ? null : minutesFromDoc(q.docs[0].id, q.docs[0].data());
  }

  nextId(): string {
    return db().collection("minutes").doc().id;
  }
}

/** Production minutes pipeline: render the locked PDF, upload to Drive. */
export class DriveMinutesPdfPipeline implements MinutesPdfPipeline {
  constructor(private bodies: BodyReader) {}

  async renderAndUpload(rec: MinutesRecord, signedBy: string, signedAt: Date) {
    const body = await this.bodies.getBody(rec.bodyId);
    const rendered = renderMinutesPdf(rec, {
      bodyType: body?.type ?? "meeting",
      signedBy,
      signedAt,
    });
    const folderId = process.env.GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID || undefined;
    const result = await uploadToVault(rendered.fileName, "application/pdf", Buffer.from(rendered.bytes), folderId);
    return {
      driveFileId: result.fileId,
      driveLink: result.webViewLink,
      fileName: rendered.fileName,
      sha256: rendered.sha256,
      uploadedAt: signedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Circulars + urgent
// ---------------------------------------------------------------------------

export class FirestoreCircularStore implements CircularStore {
  async createResolution(rec: CircularResolution): Promise<void> {
    await db().collection("circular_resolutions").doc(rec.id).set({ ...rec });
  }

  async getResolution(id: string): Promise<CircularResolution | null> {
    const snap = await db().collection("circular_resolutions").doc(id).get();
    return snap.exists ? ({ ...(snap.data() as CircularResolution), id: snap.id } as CircularResolution) : null;
  }

  async saveResolution(rec: CircularResolution): Promise<void> {
    await db().collection("circular_resolutions").doc(rec.id).set({ ...rec }, { merge: true });
  }

  async listOpenResolutions(): Promise<CircularResolution[]> {
    const q = await db().collection("circular_resolutions").where("status", "==", "open").get();
    return q.docs.map((d) => ({ ...(d.data() as CircularResolution), id: d.id }) as CircularResolution);
  }

  async listResolutions(): Promise<CircularResolution[]> {
    const q = await db().collection("circular_resolutions").get();
    return q.docs.map((d) => ({ ...(d.data() as CircularResolution), id: d.id }) as CircularResolution);
  }

  nextId(): string {
    return db().collection("circular_resolutions").doc().id;
  }
}

export class FirestoreUrgentStore implements UrgentStore {
  async createDecision(rec: UrgentDecisionRecord): Promise<void> {
    await db().collection("urgent_decisions").doc(rec.id).set({ ...rec });
  }

  async getDecision(id: string): Promise<UrgentDecisionRecord | null> {
    const snap = await db().collection("urgent_decisions").doc(id).get();
    return snap.exists ? ({ ...(snap.data() as UrgentDecisionRecord), id: snap.id } as UrgentDecisionRecord) : null;
  }

  async saveDecision(rec: UrgentDecisionRecord): Promise<void> {
    await db().collection("urgent_decisions").doc(rec.id).set({ ...rec }, { merge: true });
  }

  async listDecisions(): Promise<UrgentDecisionRecord[]> {
    const q = await db().collection("urgent_decisions").get();
    return q.docs.map((d) => ({ ...(d.data() as UrgentDecisionRecord), id: d.id }) as UrgentDecisionRecord);
  }

  nextId(): string {
    return db().collection("urgent_decisions").doc().id;
  }
}

// ---------------------------------------------------------------------------
// Decision register + consents + classes (Phase 2 substrate reads/writes)
// ---------------------------------------------------------------------------

function entryFromDoc(id: string, data: FirebaseFirestore.DocumentData): DecisionEntry {
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

export class FirestoreDecisionsClient implements DecisionsClient {
  async writeDecision(input: DecisionEntryInput): Promise<DecisionEntry> {
    const ref = db().collection("decisions").doc();
    const entry: DecisionEntry = { ...input, id: ref.id };
    await ref.set({ ...entry });
    return entry;
  }

  async getDecision(id: string): Promise<DecisionEntry | null> {
    const snap = await db().collection("decisions").doc(id).get();
    return snap.exists ? entryFromDoc(snap.id, snap.data()!) : null;
  }

  async transitionDecisionStatus(
    id: string,
    to: "ratified" | "void",
    meta: { ratifiedAt?: Date; voidedAt?: Date; voidEffectiveFrom?: Date },
  ): Promise<DecisionEntry> {
    const ref = db().collection("decisions").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new GovernanceServiceError("decision_not_found", 404, `No decision with id ${id}`);
    const current = entryFromDoc(snap.id, snap.data()!);
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
    await ref.update(patch);
    return { ...current, ...patch } as DecisionEntry;
  }

  isEffectiveDecision(decisionId: string): Promise<boolean> {
    return this.getDecision(decisionId).then((e) => e !== null && e.status === "effective");
  }
}

function consentFromDoc(id: string, data: FirebaseFirestore.DocumentData): ConsentView {
  return {
    id,
    matter: String(data.matter ?? ""),
    proposedAct: String(data.proposedAct ?? data.matter ?? ""),
    status: data.status as ConsentView["status"],
    decidedAt: toDate(data.decidedAt),
    decidedBy: String(data.decidedBy ?? ""),
    meetingId: (data.meetingId as string | null) ?? null,
  };
}

export class FirestoreConsentsClient implements ConsentsClient {
  async getConsent(consentId: string): Promise<ConsentView | null> {
    const snap = await db().collection("consent_requests").doc(consentId).get();
    return snap.exists ? consentFromDoc(snap.id, snap.data()!) : null;
  }

  async isDecidedConsent(consentId: string): Promise<boolean> {
    const consent = await this.getConsent(consentId);
    return consent !== null && isDecidedConsentStatus(consent.status);
  }

  async listConsentsForMeeting(meetingId: string): Promise<ConsentView[]> {
    const q = await db().collection("consent_requests").where("meetingId", "==", meetingId).get();
    return q.docs.map((d) => consentFromDoc(d.id, d.data()));
  }

  async listDecidedConsents(): Promise<ConsentView[]> {
    const q = await db().collection("consent_requests").where("status", "in", ["granted", "conditional"]).get();
    return q.docs.map((d) => consentFromDoc(d.id, d.data()));
  }
}

function classFromDoc(id: string, data: FirebaseFirestore.DocumentData): ServerDecisionClassView {
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

export class FirestoreDecisionClassesReader implements DecisionClassesReader {
  async getClass(classId: string): Promise<ServerDecisionClassView | null> {
    const snap = await db().collection("decisionClasses").doc(classId).get();
    return snap.exists ? classFromDoc(snap.id, snap.data()!) : null;
  }

  async listClasses(): Promise<ServerDecisionClassView[]> {
    const q = await db().collection("decisionClasses").get();
    return q.docs.map((d) => classFromDoc(d.id, d.data()));
  }
}

// ---------------------------------------------------------------------------
// Bodies / meetings / attendance readers
// ---------------------------------------------------------------------------

function bodyFromDoc(id: string, data: FirebaseFirestore.DocumentData): BodyView {
  return {
    id,
    name: String(data.name ?? id),
    type: String(data.type ?? ""),
    chairUid: String(data.chairUid ?? ""),
    secretaryUid: String(data.secretaryUid ?? ""),
    memberUids: Array.isArray(data.memberUids) ? (data.memberUids as string[]) : [],
    quorumOverride: (data.quorumOverride as number | null) ?? null,
    chapterId: (data.chapterId as string | null) ?? null,
  };
}

export class FirestoreBodyReader implements BodyReader, BodyDirectory {
  async getBody(bodyId: string): Promise<BodyView | null> {
    const snap = await db().collection("bodies").doc(bodyId).get();
    return snap.exists ? bodyFromDoc(snap.id, snap.data()!) : null;
  }

  async getBodyByType(bodyType: string): Promise<BodyView | null> {
    const q = await db().collection("bodies").where("type", "==", bodyType).limit(1).get();
    return q.empty ? null : bodyFromDoc(q.docs[0].id, q.docs[0].data());
  }

  /** Bodies whose memberUids contain uid (ratify-route membership read). */
  async listBodiesForMember(uid: string): Promise<BodyView[]> {
    const q = await db().collection("bodies").where("memberUids", "array-contains", uid).get();
    return q.docs.map((d) => bodyFromDoc(d.id, d.data()));
  }
}

export class FirestoreMeetingReader implements MeetingReader {
  async getMeeting(meetingId: string): Promise<MeetingView | null> {
    const snap = await db().collection("meetings").doc(meetingId).get();
    if (!snap.exists) return null;
    const data = snap.data()!;
    return {
      id: snap.id,
      bodyId: String(data.bodyId ?? ""),
      bodyType: String(data.bodyType ?? ""),
      chairUid: String(data.chairUid ?? ""),
      secretaryUid: String(data.secretaryUid ?? ""),
      status: String(data.status ?? "draft"),
      quorumRequired: Number(data.quorumRequired ?? 0),
      quorumVerifiedAt: toDate(data.quorumVerifiedAt),
    };
  }
}

/** Core §3.4 attendance statuses that count as present (ADAPTER, see header). */
export const PRESENT_STATUSES: ReadonlySet<string> = new Set([
  "present",
  "present_electronic",
  "late",
]);

export class FirestoreAttendanceReader implements AttendanceReader {
  async listPresentUids(meetingId: string): Promise<string[]> {
    const q = await db().collection("meeting_attendance").where("meetingId", "==", meetingId).get();
    return q.docs
      .filter((d) => PRESENT_STATUSES.has(String(d.data().status ?? "")))
      .map((d) => String(d.data().uid ?? ""))
      .filter(Boolean);
  }
}

/** Filing/ratification tasks written into the existing tasks collection. */
export class FirestoreFilingTaskCreator implements FilingTaskCreator {
  async createFilingTask(input: {
    title: string;
    description: string;
    assigneeUid: string;
    deadline: Date;
    sourceKind: string;
    sourceId: string;
  }): Promise<string> {
    const now = new Date();
    const ref = await db().collection("tasks").add({
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeUid,
      assigneeIds: [input.assigneeUid],
      createdBy: "governance-system",
      status: "pending",
      priority: "medium",
      points: 0,
      deadline: input.deadline,
      attachments: [],
      deliverableFiles: [],
      governanceSource: { kind: input.sourceKind, id: input.sourceId },
      createdAt: now,
      updatedAt: now,
    });
    return ref.id;
  }
}

// ---------------------------------------------------------------------------
// Deps factories (used by the API routes)
// ---------------------------------------------------------------------------

export interface GovernanceRouteDeps {
  motions: FirestoreMotionStore;
  ballots: FirestoreBallotStore;
  meetings: FirestoreMeetingReader;
  attendance: FirestoreAttendanceReader;
  bodies: FirestoreBodyReader;
  classes: FirestoreDecisionClassesReader;
  decisions: FirestoreDecisionsClient;
  consents: FirestoreConsentsClient;
  filingTasks: FirestoreFilingTaskCreator;
  circularStore: FirestoreCircularStore;
  urgentStore: FirestoreUrgentStore;
  minutesStore: FirestoreMinutesStore;
  minutesPdfPipeline: DriveMinutesPdfPipeline;
}

export function getGovernanceRouteDeps(): GovernanceRouteDeps {
  const motions = new FirestoreMotionStore();
  const bodies = new FirestoreBodyReader();
  // Supabase composition (meetings cluster migration): per-group
  // surfaces substitute the Supa seam classes ONLY when that group's
  // flag is on AND an adapter resolves; otherwise the Firestore
  // classes below serve byte-identically. Mixed Firestore/Supa deps
  // objects are EXPECTED during rollout (plan §8.3). Seam classes
  // delegate to their Firestore counterpart on adapter error.
  // Filing tasks always stay on Firestore (tasks cluster owns
  // `tasks`, plan §5); the minutes PDF pipeline keeps the Firestore
  // body reader it was constructed with.
  const decisionsAdapter = govSupaAdapterFor("decisions");
  const meetingsAdapter = govSupaAdapterFor("meetings");
  const motionsAdapter = govSupaAdapterFor("motions");
  const minutesAdapter = govSupaAdapterFor("minutes");
  const supaBodies = meetingsAdapter
    ? new SupaBodyReader(meetingsAdapter, bodies)
    : null;
  const supaMotions = motionsAdapter
    ? new SupaMotionStore(motionsAdapter, motions)
    : null;
  return {
    motions: (supaMotions as unknown as FirestoreMotionStore | null) ?? motions,
    ballots: supaMotions
      ? (new SupaBallotStore(
          motionsAdapter!,
          supaMotions,
          new FirestoreBallotStore(motions),
        ) as unknown as FirestoreBallotStore)
      : new FirestoreBallotStore(motions),
    meetings: meetingsAdapter
      ? (new SupaMeetingReader(
          meetingsAdapter,
          new FirestoreMeetingReader(),
        ) as unknown as FirestoreMeetingReader)
      : new FirestoreMeetingReader(),
    attendance: meetingsAdapter
      ? (new SupaAttendanceReader(
          meetingsAdapter,
          new FirestoreAttendanceReader(),
        ) as unknown as FirestoreAttendanceReader)
      : new FirestoreAttendanceReader(),
    // The Drive minutes pipeline below keeps the Firestore `bodies`
    // instance; only the deps field swaps (G1 owns this reader).
    bodies: (supaBodies as unknown as FirestoreBodyReader | null) ?? bodies,
    classes: decisionsAdapter
      ? (new SupaDecisionClassesReader(
          decisionsAdapter,
          new FirestoreDecisionClassesReader(),
        ) as unknown as FirestoreDecisionClassesReader)
      : new FirestoreDecisionClassesReader(),
    decisions: decisionsAdapter
      ? (new SupaDecisionsClient(
          decisionsAdapter,
          new FirestoreDecisionsClient(),
          // Cutover mirror writer (write primacy only): writes the
          // committed register entry to Firestore under its Supa id.
          async (entry) => {
            await db().collection("decisions").doc(entry.id).set({ ...entry });
          },
        ) as unknown as FirestoreDecisionsClient)
      : new FirestoreDecisionsClient(),
    consents: decisionsAdapter
      ? (new SupaConsentsClient(
          decisionsAdapter,
          new FirestoreConsentsClient(),
        ) as unknown as FirestoreConsentsClient)
      : new FirestoreConsentsClient(),
    filingTasks: new FirestoreFilingTaskCreator(),
    circularStore: minutesAdapter
      ? (new SupaCircularStore(
          minutesAdapter,
          new FirestoreCircularStore(),
        ) as unknown as FirestoreCircularStore)
      : new FirestoreCircularStore(),
    urgentStore: decisionsAdapter
      ? (new SupaUrgentStore(
          decisionsAdapter,
          new FirestoreUrgentStore(),
        ) as unknown as FirestoreUrgentStore)
      : new FirestoreUrgentStore(),
    minutesStore: minutesAdapter
      ? (new SupaMinutesStore(
          minutesAdapter,
          new FirestoreMinutesStore(),
        ) as unknown as FirestoreMinutesStore)
      : new FirestoreMinutesStore(),
    minutesPdfPipeline: new DriveMinutesPdfPipeline(bodies),
  };
}
