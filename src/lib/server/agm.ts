/**
 * AGM: record, agenda gate, notice dispatch with delivery proof,
 * member-gated documents, auditor appointment (spec Sections 3.6, 4
 * routes 18-21, 6.6).
 *
 * Fallback shape: Workstream A's meeting engine is not on this branch,
 * so the AGM lives in agm_events/{agmId} with meetingId mapped onto it
 * when A lands (spec 11.3 fallback). The election itself has no
 * dependency on A.
 *
 * Notice rule: the notice must issue at least 21 days before the AGM
 * (Constitution 11.7; Procedure Manual Sec 3.1). 20 days returns 422;
 * there is no override in v1.
 *
 * Agenda gate: while Member Governor seats are due, agenda
 * finalisation is BLOCKED without a governor_election item (422
 * election_item_required).
 *
 * Supabase migration (elections G3): every Firestore touch in this
 * module goes through the data-access helpers below, which route to
 * agm-domain-supa.ts when the 'elections' surface is ON
 * (agm_events / agm_documents / auditor_appointments top-level,
 * notices + recipients as subcollection paths). Flag OFF,
 * unconfigured, or any Supabase error -> the exact Firestore code
 * path, byte-identical shapes. ElectionPorts dependencies are NOT
 * migrated: ports keep receiving the Firestore `db` handle.
 */

import type {
  AgmAgendaItem,
  AgmDocument,
  AgmRecord,
  AuditorAppointment,
} from "@/types/elections";
import { ElectionError, sha256Hex, type ElectionPorts } from "./election-ports";
import {
  type Db,
  tsFromMillis,
  serverTimestamp,
  millisOf,
} from "./election-db";
import { writeElectionAudit } from "./election-audit";
import { getElectionOrThrow } from "./election-db";
import { listRollEntries } from "./election-roll";
import {
  agmSupaEnabled,
  supaGetDoc as seamGetDoc,
  supaListDocs as seamListDocs,
  supaSetDoc as seamSetDoc,
  supaUpdateDoc as seamUpdateDoc,
} from "./agm-domain-supa";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const AGM_NOTICE_DAYS = 21;

function agmRef(db: Db, agmId: string) {
  return db.collection("agm_events").doc(agmId);
}

function noticesPath(agmId: string): string {
  return `agm_events/${agmId}/notices`;
}

function recipientsPath(agmId: string, noticeId: string): string {
  return `agm_events/${agmId}/notices/${noticeId}/recipients`;
}

// ---------------------------------------------------------------------------
// Data-access helpers: the ONLY branch point between Firestore and
// Supabase for this module's collections (agm_events, its notices and
// recipients subcollections, agm_documents, auditor_appointments).
// Each helper tries the seam when the surface is ON and falls through
// to the Firestore operation on ANY seam error (fallback contract).
// ---------------------------------------------------------------------------

interface DocData {
  id: string;
  data: Record<string, unknown>;
}

async function setTopDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: any,
  collection: string,
  docId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (agmSupaEnabled()) {
    try {
      await seamSetDoc(collection, docId, data);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await ref.set(data);
}

async function setPathDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: any,
  collectionPath: string,
  docId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (agmSupaEnabled()) {
    try {
      await seamSetDoc(collectionPath, docId, data);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await ref.set(data);
}

async function updateAgmDoc(
  db: Db,
  agmId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (agmSupaEnabled()) {
    try {
      await seamUpdateDoc("agm_events", agmId, updates);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await agmRef(db, agmId).update(updates);
}

async function updateNoticeDoc(
  db: Db,
  agmId: string,
  noticeId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (agmSupaEnabled()) {
    try {
      await seamUpdateDoc(noticesPath(agmId), noticeId, updates);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await agmRef(db, agmId).collection("notices").doc(noticeId).update(updates);
}

async function getTopDoc(
  db: Db,
  collection: string,
  docId: string,
): Promise<DocData | null> {
  if (agmSupaEnabled()) {
    try {
      return await seamGetDoc(collection, docId);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await db.collection(collection).doc(docId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() as Record<string, unknown> };
}

/**
 * List docs at a collection path (top-level or subcollection)
 * through the seam. The Firestore fallback runs the exact query /
 * collection the caller supplies (its .get()), so ordering the
 * caller baked into that query is preserved on the Firestore path.
 */
async function listCollectionPathDocs(
  collectionPath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  firestoreQuery: any,
): Promise<DocData[]> {
  if (agmSupaEnabled()) {
    try {
      return await seamListDocs(collectionPath);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await firestoreQuery.get();
  return snap.docs.map(
    (d: { id: string; data: () => Record<string, unknown> }) => ({
      id: d.id,
      data: d.data(),
    }),
  ) as DocData[];
}

export async function getAgmOrThrow(db: Db, agmId: string): Promise<AgmRecord> {
  const doc = await getTopDoc(db, "agm_events", agmId);
  if (!doc) {
    throw new ElectionError("agm_not_found", 404, "AGM not found.");
  }
  return { id: doc.id, ...doc.data } as AgmRecord;
}

/**
 * All AGM records in `year desc` order, shaped exactly as the
 * /api/agm GET route's original in-route read produced them:
 * `db.collection("agm_events").orderBy("year", "desc").get()`
 * mapped to `{ id, ...data }` per doc. The seam's listDocs has no
 * ordering contract (the bridge returns id.asc), so on the Supa
 * path the year-desc ordering is applied in memory; the Firestore
 * path keeps the query's own orderBy.
 */
export async function listAgms(db: Db): Promise<AgmRecord[]> {
  let viaSupa = false;
  let docs: DocData[] | null = null;
  if (agmSupaEnabled()) {
    try {
      docs = await seamListDocs("agm_events");
      viaSupa = true;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  if (!docs) {
    const snap = await db
      .collection("agm_events")
      .orderBy("year", "desc")
      .get();
    docs = snap.docs.map(
      (d: { id: string; data: () => Record<string, unknown> }) => ({
        id: d.id,
        data: d.data(),
      }),
    ) as DocData[];
  }
  if (viaSupa) {
    // F4 (BUILDOUT_AUDIT §5): Firestore orderBy("year") is also an
    // existence filter — records whose `year` is missing or not a
    // number never come back. The seam's listDocs has no such rule,
    // so the Supa arm excludes those records here to match; the
    // Firestore arm below keeps the query's own semantics untouched.
    docs = docs.filter((d) => typeof d.data.year === "number");
    const yearOf = (d: DocData): number => d.data.year as number;
    docs = [...docs].sort((a, b) => yearOf(b) - yearOf(a));
  }
  return docs.map((d) => ({ id: d.id, ...d.data }) as AgmRecord);
}

export interface CreateAgmInput {
  actorUid: string;
  /** Route gate result: National General Secretary or Founder. */
  actorMayConvene: boolean;
  year: number;
  title?: string;
  scheduledAtMillis: number;
  locationOrLink: string;
  meetingId?: string | null;
  electionId?: string | null;
}

export async function createAgm(
  db: Db,
  ports: ElectionPorts,
  input: CreateAgmInput,
  nowMillis: number = Date.now(),
): Promise<AgmRecord> {
  if (!input.actorMayConvene) {
    throw new ElectionError(
      "agm_convene_forbidden",
      403,
      "Only the National General Secretary or the Founder may create an AGM.",
    );
  }

  // Seats due: Board port is the source of truth; a linked election for
  // this cycle also means seats are due at this AGM.
  const due = await ports.board.readSeatsDue({ year: input.year });
  const seatsDue = due.seatsDue || input.electionId != null;

  const agenda: AgmAgendaItem[] = [
    { order: 1, title: "Opening and quorum verification", kind: "standard", electionId: null, documentIds: [] },
    { order: 2, title: "Audited accounts", kind: "accounts", electionId: null, documentIds: [] },
    { order: 3, title: "Audit report", kind: "audit_report", electionId: null, documentIds: [] },
  ];
  if (seatsDue) {
    agenda.push({
      order: agenda.length + 1,
      title: "Election of Member Governors",
      kind: "governor_election",
      electionId: input.electionId ?? null,
      documentIds: [],
    });
  }

  const members = await ports.fullMembers.listFullMembers();
  const rollSize = members.length;

  const ref = db.collection("agm_events").doc();
  const agmId = ref.id as string;

  const noticeObl = await ports.compliance.registerObligation({
    key: `agm:${agmId}:notice`,
    kind: "agm_notice_issue",
    title: `Issue 21-day AGM notice (${input.year})`,
    dueAtMillis: input.scheduledAtMillis - AGM_NOTICE_DAYS * DAY_MS,
    ownerRole: "national_general_secretary",
    agmId,
  });
  const agmObl = await ports.compliance.registerObligation({
    key: `agm:${agmId}:hold`,
    kind: "agm_hold",
    title: `Hold the AGM (${input.year})`,
    dueAtMillis: input.scheduledAtMillis,
    ownerRole: "national_general_secretary",
    agmId,
  });

  const agmData: Record<string, unknown> = {
    year: input.year,
    title: input.title ?? `Annual General Meeting ${input.year}`,
    meetingId: input.meetingId ?? null,
    scheduledAt: tsFromMillis(input.scheduledAtMillis),
    locationOrLink: input.locationOrLink,
    convenedByRole: "national_general_secretary",
    status: "notice_due",
    agenda,
    agendaFinalised: false,
    seatsDue,
    electionId: input.electionId ?? null,
    quorum: {
      basis: "full_members",
      rollSize,
      quorumRequired: Math.ceil(0.2 * rollSize),
      presentCount: null,
      verifiedAt: null,
      verifiedByUid: null,
    },
    accountsDocumentId: null,
    auditReportDocumentId: null,
    auditorAppointmentId: null,
    minutesRef: null,
    complianceObligationIds: { notice: noticeObl.obligationId, agm: agmObl.obligationId },
    createdByUid: input.actorUid,
    createdAt: tsFromMillis(nowMillis),
    updatedAt: serverTimestamp(),
  };
  await setTopDoc(ref, "agm_events", agmId, agmData);

  await writeElectionAudit(db, {
    action: "agm.create",
    actorUid: input.actorUid,
    targetUidOrResource: `agm:${agmId}`,
    payload: { year: input.year, seatsDue, electionId: input.electionId ?? null },
  });

  return getAgmOrThrow(db, agmId);
}

export async function updateAgenda(
  db: Db,
  agmId: string,
  callerUid: string,
  agenda: AgmAgendaItem[],
): Promise<AgmRecord> {
  const agm = await getAgmOrThrow(db, agmId);
  if (agm.agendaFinalised) {
    throw new ElectionError(
      "agenda_finalised",
      409,
      "The agenda is finalised; the served notice snapshot cannot be rewritten by agenda edits.",
    );
  }
  await updateAgmDoc(db, agmId, { agenda, updatedAt: serverTimestamp() });
  await writeElectionAudit(db, {
    action: "agm.agenda_update",
    actorUid: callerUid,
    targetUidOrResource: `agm:${agmId}`,
    payload: { items: agenda.length },
  });
  return getAgmOrThrow(db, agmId);
}

export async function finaliseAgenda(
  db: Db,
  agmId: string,
  callerUid: string,
): Promise<AgmRecord> {
  const agm = await getAgmOrThrow(db, agmId);
  if (agm.seatsDue && !agm.agenda.some((i) => i.kind === "governor_election")) {
    throw new ElectionError(
      "election_item_required",
      422,
      "Member Governor seats are due: the AGM agenda cannot be finalised without the governor_election item.",
    );
  }
  await updateAgmDoc(db, agmId, {
    agendaFinalised: true,
    updatedAt: serverTimestamp(),
  });
  await writeElectionAudit(db, {
    action: "agm.agenda_finalise",
    actorUid: callerUid,
    targetUidOrResource: `agm:${agmId}`,
    payload: { items: agm.agenda.length },
  });
  return getAgmOrThrow(db, agmId);
}

export interface IssueNoticeResult {
  noticeId: string;
  recipientCount: number;
  recipientsHash: string;
}

export async function issueNotice(
  db: Db,
  ports: ElectionPorts,
  agmId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<IssueNoticeResult> {
  const agm = await getAgmOrThrow(db, agmId);
  if (agm.status !== "notice_due" && agm.status !== "draft") {
    throw new ElectionError(
      "invalid_status",
      409,
      `Cannot issue the AGM notice while the AGM is in status "${agm.status}".`,
    );
  }

  // The agenda gate also binds notice issue: the notice carries the
  // agenda snapshot, and a seats-due AGM may not be noticed without
  // the election item (spec 3.2 collision note).
  if (agm.seatsDue && !agm.agenda.some((i) => i.kind === "governor_election")) {
    throw new ElectionError(
      "election_item_required",
      422,
      "Member Governor seats are due: the AGM notice cannot issue without the governor_election agenda item.",
    );
  }

  // 21-day rule, enforced, no override in v1.
  const scheduledAt = millisOf(agm.scheduledAt);
  if (scheduledAt - nowMillis < AGM_NOTICE_DAYS * DAY_MS) {
    throw new ElectionError(
      "notice_too_late",
      422,
      "The AGM notice must issue at least 21 days before the AGM (Constitution 11.7).",
    );
  }

  // Recipient set: the linked election's frozen roll when the AGM
  // carries the election (same cycle snapshot), else the Register of
  // Members Full Member snapshot. The source is recorded either way.
  let recipients: Array<{ uid: string; displayName: string }>;
  let rollReference: string;
  if (agm.electionId) {
    const election = await getElectionOrThrow(db, agm.electionId);
    if (election.voterRoll.status !== "frozen") {
      throw new ElectionError(
        "roll_not_frozen",
        409,
        "The linked election's roll must be frozen before it can serve as the notice recipient set.",
      );
    }
    const entries = await listRollEntries(db, agm.electionId);
    recipients = entries
      .filter((e) => e.eligibleToVote !== false)
      .map((e) => ({ uid: e.uid, displayName: e.displayName }));
    rollReference = `election_roll:${agm.electionId}`;
  } else {
    const members = await ports.fullMembers.listFullMembers();
    recipients = members.map((m) => ({ uid: m.uid, displayName: m.displayName }));
    rollReference = "register_of_members_snapshot";
  }

  const recipientUidsHash = sha256Hex(
    recipients.map((r) => r.uid).sort().join(","),
  );

  const noticeRef = agmRef(db, agmId).collection("notices").doc();
  const noticeId = noticeRef.id as string;
  const documentIds = agm.agenda.flatMap((i) => i.documentIds);
  const noticeData: Record<string, unknown> = {
    agmId,
    issuedByUid: callerUid,
    issuedAt: tsFromMillis(nowMillis),
    noticeDate: tsFromMillis(nowMillis),
    recipientSet: {
      source: "frozen_full_member_roll",
      rollReference,
      recipientCount: recipients.length,
      recipientUidsHash,
    },
    agendaSnapshot: agm.agenda,
    documentIds,
    dispatch: {
      channel: "notification_service",
      startedAt: tsFromMillis(nowMillis),
      completedAt: null,
    },
  };
  await setPathDoc(noticeRef, noticesPath(agmId), noticeId, noticeData);

  for (const r of recipients) {
    const delivery = await ports.notifications.notifyUser({
      uid: r.uid,
      type: "agm_notice",
      title: `AGM notice: ${agm.title}`,
      message: `The Annual General Meeting is scheduled for ${new Date(scheduledAt).toISOString()}. The agenda, including the Governor election item where seats are due, is served with this notice.`,
      agmId,
    });
    const recipientRef = noticeRef.collection("recipients").doc(r.uid);
    await setPathDoc(recipientRef, recipientsPath(agmId, noticeId), r.uid, {
      uid: r.uid,
      displayName: r.displayName,
      inAppNotificationId: delivery.inAppNotificationId,
      deliveryStatus: {
        inApp: delivery.inApp,
        email: delivery.email,
        push: delivery.push,
      },
      servedAt: delivery.inApp === "created" ? tsFromMillis(nowMillis) : null,
    });
  }

  await updateNoticeDoc(db, agmId, noticeId, {
    dispatch: {
      channel: "notification_service",
      startedAt: tsFromMillis(nowMillis),
      completedAt: tsFromMillis(Date.now()),
    },
  });
  await updateAgmDoc(db, agmId, {
    status: "notice_issued",
    updatedAt: serverTimestamp(),
  });
  await writeElectionAudit(db, {
    action: "agm.notice_issue",
    actorUid: callerUid,
    targetUidOrResource: `agm:${agmId}`,
    payload: { noticeId, recipientCount: recipients.length, recipientUidsHash },
  });

  return { noticeId, recipientCount: recipients.length, recipientsHash: recipientUidsHash };
}

export interface AgmNoticeDelivery {
  /** `{ id, ...noticeData }` for the first notice, or null when none. */
  notice: ({ id: string } & Record<string, unknown>) | null;
  /** Counts of recipients by `deliveryStatus.inApp` ("unknown" when absent). */
  deliveryCounts: Record<string, number>;
  /** Every recipient record as `{ id, ...data }` (route gates exposure). */
  recipients: Array<{ id: string } & Record<string, unknown>>;
}

/**
 * Notice dispatch + delivery proof for the /api/agm/[agmId]/notice
 * GET route, replicating its original in-route assembly exactly:
 * read `agm_events/{id}/notices`, take docs[0] (no notice -> the
 * route's `{ notice: null }` 200, NOT an error: there is no
 * not-found throw on this path, even for a missing AGM), then read
 * that notice's `recipients` subcollection (originally via
 * `noticeDoc.ref.collection("recipients")`; here the identical
 * collection addressed by path), count recipients by
 * `deliveryStatus?.inApp ?? "unknown"`, and return the notice,
 * the counts, and the full id-merged recipient list. The route
 * alone decides whether recipients are exposed (NGS / Founder)
 * or dropped to `undefined`.
 */
export async function getNoticeDelivery(
  db: Db,
  agmId: string,
): Promise<AgmNoticeDelivery> {
  const notices = await listCollectionPathDocs(
    noticesPath(agmId),
    agmRef(db, agmId).collection("notices"),
  );
  if (notices.length === 0) {
    return { notice: null, deliveryCounts: {}, recipients: [] };
  }
  const noticeDoc = notices[0];
  const notice = { id: noticeDoc.id, ...noticeDoc.data };
  const recipientDocs = await listCollectionPathDocs(
    recipientsPath(agmId, noticeDoc.id),
    agmRef(db, agmId)
      .collection("notices")
      .doc(noticeDoc.id)
      .collection("recipients"),
  );
  const counts: Record<string, number> = {};
  for (const r of recipientDocs) {
    const s =
      (r.data.deliveryStatus as { inApp?: string } | undefined)?.inApp ??
      "unknown";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return {
    notice,
    deliveryCounts: counts,
    recipients: recipientDocs.map((r) => ({ id: r.id, ...r.data })),
  };
}

// ---------------------------------------------------------------------------
// Documents (member-gated)
// ---------------------------------------------------------------------------

export interface AddAgmDocumentInput {
  kind: AgmDocument["kind"];
  title: string;
  driveFileId: string;
  driveLink: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  sourceModule: AgmDocument["sourceModule"];
}

export async function addAgmDocument(
  db: Db,
  agmId: string,
  callerUid: string,
  input: AddAgmDocumentInput,
  nowMillis: number = Date.now(),
): Promise<AgmDocument> {
  const agm = await getAgmOrThrow(db, agmId);
  const fullMembersOnly =
    input.kind === "audited_accounts" || input.kind === "audit_report";
  const ref = db.collection("agm_documents").doc();
  const documentData: Record<string, unknown> = {
    agmId,
    kind: input.kind,
    title: input.title,
    driveFileId: input.driveFileId,
    driveLink: input.driveLink,
    fileName: input.fileName,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    sourceModule: input.sourceModule,
    fullMembersOnly,
    uploadedByUid: callerUid,
    uploadedAt: tsFromMillis(nowMillis),
    publishedAt: tsFromMillis(nowMillis),
  };
  await setTopDoc(ref, "agm_documents", ref.id as string, documentData);
  if (input.kind === "audited_accounts") {
    await updateAgmDoc(db, agm.id, { accountsDocumentId: ref.id });
  }
  if (input.kind === "audit_report") {
    await updateAgmDoc(db, agm.id, { auditReportDocumentId: ref.id });
  }
  await writeElectionAudit(db, {
    action: "agm.document_add",
    actorUid: callerUid,
    targetUidOrResource: `agm:${agmId}`,
    payload: { documentId: ref.id, kind: input.kind, fullMembersOnly },
  });
  // Read back the stored doc. getTopDoc treats a Supabase miss as
  // authoritative; the one case it can miss after a successful write
  // is the write itself having fallen back to Firestore mid-outage,
  // so a null here re-reads Firestore before giving up.
  let stored = await getTopDoc(db, "agm_documents", ref.id as string);
  if (!stored) {
    const snap = await ref.get();
    if (snap.exists) {
      stored = { id: ref.id as string, data: snap.data() as Record<string, unknown> };
    }
  }
  return { id: ref.id, ...(stored?.data ?? documentData) } as AgmDocument;
}

/**
 * Read a document for a user. A non-Full Member gets 403 on a gated
 * document and NEVER receives a stored Drive link on any document
 * (route 21); gated metadata for non-gated documents is returned
 * without the link.
 */
export async function getAgmDocumentForUser(
  db: Db,
  documentId: string,
  opts: { isFullMember: boolean },
): Promise<Omit<AgmDocument, "driveLink"> & { driveLink: string | null }> {
  const stored = await getTopDoc(db, "agm_documents", documentId);
  if (!stored) {
    throw new ElectionError("document_not_found", 404, "Document not found.");
  }
  const doc = { id: documentId, ...stored.data } as AgmDocument;
  if (doc.fullMembersOnly && !opts.isFullMember) {
    throw new ElectionError(
      "full_member_required",
      403,
      "This document is available to Full Members only.",
    );
  }
  if (!opts.isFullMember) {
    return { ...doc, driveLink: null };
  }
  return doc;
}

export async function listAgmDocuments(
  db: Db,
  agmId: string,
  opts: { isFullMember: boolean },
): Promise<Array<Omit<AgmDocument, "driveLink"> & { driveLink: string | null }>> {
  let docs: DocData[] | null = null;
  if (agmSupaEnabled()) {
    try {
      docs = await seamListDocs("agm_documents", [["agmId", "==", agmId]]);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  if (!docs) {
    const snap = await db
      .collection("agm_documents")
      .where("agmId", "==", agmId)
      .get();
    docs = snap.docs.map(
      (d: { id: string; data: () => Record<string, unknown> }) => ({
        id: d.id,
        data: d.data(),
      }),
    ) as DocData[];
  }
  const out: Array<Omit<AgmDocument, "driveLink"> & { driveLink: string | null }> = [];
  for (const d of docs) {
    const doc = { id: d.id, ...d.data } as AgmDocument;
    if (doc.fullMembersOnly && !opts.isFullMember) continue;
    out.push(opts.isFullMember ? doc : { ...doc, driveLink: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auditor appointment (spec 3.6; B creates it until Workstream C claims it)
// INTEGRATION REWIRE (step 11, watch item W5): Workstream C (Finance) has
// claimed the record. The canonical shape is Finance's
// auditor_appointments/{fyLabel} (src/types/finance.ts), owned by
// Finance and consumed by the AGM workstream. This writer now writes
// THAT shape (fyLabel = "fy" + financialYear, ISO appointedAt, fallback
// kept consistent with appointedBy) instead of the parallel auto-id
// shape it originally used, so the collection has exactly one shape.
// Elections-only context (boardDecisionRef, founderFallbackReason,
// status) rides as additive fields on the same doc; a Finance PUT
// overwrite replaces the doc wholesale, which is the owner's right.
// ---------------------------------------------------------------------------

export interface CreateAuditorAppointmentInput {
  actorUid: string;
  financialYear: string;
  firmName: string;
  auditorName: string;
  appointedBy: "board" | "founder_fallback";
  boardDecisionRef?: string | null;
  founderFallbackReason?: string | null;
}

export async function createAuditorAppointment(
  db: Db,
  input: CreateAuditorAppointmentInput,
  nowMillis: number = Date.now(),
): Promise<AuditorAppointment> {
  if (
    input.appointedBy === "founder_fallback" &&
    (!input.founderFallbackReason || input.founderFallbackReason.trim() === "")
  ) {
    throw new ElectionError(
      "fallback_reason_required",
      422,
      "A Founder fallback appointment requires the reason (Constitution 13.13: Board had not appointed by 31 August).",
    );
  }
  const fyLabel = `fy${input.financialYear}`;
  const appointedAtIso = new Date(nowMillis).toISOString().slice(0, 10);
  const fallback = input.appointedBy === "founder_fallback";
  const ref = db.collection("auditor_appointments").doc(fyLabel);
  const appointmentData: Record<string, unknown> = {
    // Finance-canonical fields (src/types/finance.ts AuditorAppointment).
    fyLabel,
    auditorName: input.auditorName,
    firmName: input.firmName,
    appointedAt: appointedAtIso,
    appointedBy: input.appointedBy,
    fallback,
    appointedByUid: input.actorUid,
    engagementLetterDriveId: null,
    recordedBy: input.actorUid,
    // Elections additive context on the same doc (see header note).
    boardDecisionRef: input.boardDecisionRef ?? null,
    founderFallbackReason: input.founderFallbackReason ?? null,
    engagementLetter: null,
    status: "appointed",
  };
  await setTopDoc(ref, "auditor_appointments", fyLabel, appointmentData);
  await writeElectionAudit(db, {
    action: "agm.auditor_appoint",
    actorUid: input.actorUid,
    targetUidOrResource: `auditor_appointments/${fyLabel}`,
    payload: { financialYear: input.financialYear, appointedBy: input.appointedBy },
  });
  // Return the elections view of the same record.
  return {
    id: fyLabel,
    financialYear: input.financialYear,
    firmName: input.firmName,
    auditorName: input.auditorName,
    appointedBy: input.appointedBy,
    appointedAt: tsFromMillis(nowMillis),
    boardDecisionRef: input.boardDecisionRef ?? null,
    founderFallbackReason: input.founderFallbackReason ?? null,
    engagementLetter: null,
    status: "appointed",
  } as AuditorAppointment;
}
