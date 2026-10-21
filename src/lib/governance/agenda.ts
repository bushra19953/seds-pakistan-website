/**
 * Agenda builder — pure logic (ws-a.md A3, phase3_spec.md Part A §3.3, §4.3).
 * Source: item 14, P-03, Doc 07 sec 3.4.
 *
 * Rules implemented here (no I/O, no Firebase imports — imported by client
 * and server, mirroring src/lib/governance/types.ts conventions in ws-a §2.1):
 *
 * - The preliminary agenda is set by the presiding officer (the meeting's
 *   chairUid): the chair adds, edits and reorders items at any time before
 *   the meeting closes, and is never subject to the submission cutoff.
 * - The Founder may add an item to ANY body at ANY time (P-03): no 5-day
 *   cutoff and no post-notice 48-hour window applies to the Founder.
 * - A body member who is neither chair nor Founder uses the submission
 *   path: the item lands with source `member_submission`, addressed to the
 *   National General Secretary (the meeting's secretaryUid). For Board
 *   meetings only, a submission is rejected once `scheduledAt - now` is
 *   under 5 days (error_code agenda_cutoff_passed, ws-a §4.3).
 * - After notice has been sent (noticeSentAt set), agenda edits stamp
 *   agendaAmendedAt. While the meeting is more than 48 hours away a
 *   re-notice is required; inside 48 hours only the Founder may ADD an
 *   item and the addition must be notified immediately (ws-a §3.3).
 * - PATCH semantics (ws-a §4.3): edit + reorder only, chair or Founder.
 *   Deleting a Founder-added item by anyone except the Founder is refused.
 *
 * ADAPTER: who counts as chair / Founder / member is NOT decided here.
 * Callers pass an `AgendaActor` resolved through the agenda role adapter
 * (src/lib/server/governance/agenda-adapter.ts). This module only applies
 * the agenda rules to that resolved actor.
 */

// ---------------------------------------------------------------------------
// Types (agenda slice of ws-a §3.3; embedded on the meeting doc, ordered)
// ---------------------------------------------------------------------------

export type AgendaItemSource = "chair" | "founder" | "member_submission";

export interface AgendaAttachment {
  label: string;
  driveFileId: string | null;
  url: string | null;
}

export interface AgendaItem {
  itemId: string;
  title: string;
  description: string;
  proposerUid: string;
  source: AgendaItemSource;
  decisionClassId: string | null;
  attachments: AgendaAttachment[];
}

/** Minimal meeting shape the agenda rules consume (ws-a §3.3 subset). */
export interface AgendaMeetingRef {
  bodyId: string;
  bodyType: string;
  chairUid: string;
  secretaryUid: string;
  /** ISO string or epoch ms; normalised by callers to a Date before use. */
  scheduledAt: Date;
  status: string;
  noticeSentAt: Date | null;
  agenda: AgendaItem[];
}

/** Resolved actor, produced by the ADAPTER (see agenda-adapter.ts). */
export interface AgendaActor {
  uid: string;
  isFounder: boolean;
  isChair: boolean;
  isBodyMember: boolean;
}

export interface AgendaItemInput {
  title: string;
  description?: string | null;
  decisionClassId?: string | null;
  attachments?: Array<{
    label: string;
    driveFileId?: string | null;
    url?: string | null;
  }> | null;
}

export interface AgendaItemEdit {
  itemId: string;
  title?: string;
  description?: string;
  decisionClassId?: string | null;
}

export interface AgendaPatch {
  items?: AgendaItemEdit[];
  /** Full permutation of the surviving itemIds, in the new order. */
  order?: string[];
  /** Item ids to delete (PATCH is edit/reorder per spec; deletions ride
   *  here so the Founder-item deletion guard in §4.3 has a surface). */
  removeItemIds?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Board member submission cutoff: 5 days before the meeting (ws-a §4.3). */
export const BOARD_AGENDA_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000;

/** Post-notice window inside which only the Founder may add (ws-a §3.3). */
export const FOUNDER_ONLY_ADD_WINDOW_MS = 48 * 60 * 60 * 1000;

export const AGENDA_ERROR_CODES = {
  cutoffPassed: "agenda_cutoff_passed",
  lateWindowFounderOnly: "agenda_late_window_founder_only",
  notAMember: "agenda_not_a_member",
  editForbidden: "agenda_edit_forbidden",
  founderItemDeleteForbidden: "agenda_founder_item_delete_forbidden",
  meetingClosed: "meeting_closed",
  validation: "agenda_validation_failed",
  itemNotFound: "agenda_item_not_found",
  orderMismatch: "agenda_order_mismatch",
} as const;

export type AgendaErrorCode =
  (typeof AGENDA_ERROR_CODES)[keyof typeof AGENDA_ERROR_CODES];

export class AgendaError extends Error {
  code: AgendaErrorCode;
  /** HTTP status the API route should answer with (ws-a §4.3). */
  status: number;
  constructor(code: AgendaErrorCode, status: number, message: string) {
    super(message);
    this.name = "AgendaError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Actor classification + gates
// ---------------------------------------------------------------------------

export type AgendaActorKind = "founder" | "chair" | "member" | "outsider";

/** Founder wins over chair, chair over member (a Founder who also chairs
 *  still acts with Founder rights, including inside every cutoff). */
export function classifyAgendaActor(actor: AgendaActor): AgendaActorKind {
  if (actor.isFounder) return "founder";
  if (actor.isChair) return "chair";
  if (actor.isBodyMember) return "member";
  return "outsider";
}

/** Preliminary-agenda editing (PATCH) is chair or Founder only (ws-a §4.3). */
export function canEditPreliminaryAgenda(actor: AgendaActor): boolean {
  const kind = classifyAgendaActor(actor);
  return kind === "chair" || kind === "founder";
}

/** Closed / cancelled meetings take no agenda changes (chair gate is
 *  "any time before close", ws-a §4.3). */
export function isMeetingClosedForAgenda(meeting: AgendaMeetingRef): boolean {
  return meeting.status === "closed" || meeting.status === "cancelled";
}

function assertMeetingOpen(meeting: AgendaMeetingRef): void {
  if (isMeetingClosedForAgenda(meeting)) {
    throw new AgendaError(
      AGENDA_ERROR_CODES.meetingClosed,
      409,
      "Agenda is locked: the meeting is closed or cancelled.",
    );
  }
}

// ---------------------------------------------------------------------------
// Cutoff helpers
// ---------------------------------------------------------------------------

/** The instant the Board 5-day submission cutoff falls, or null for
 *  non-Board bodies (the cutoff exists only for Board meetings, §4.3). */
export function agendaCutoffAt(meeting: AgendaMeetingRef): Date | null {
  if (meeting.bodyType !== "board") return null;
  return new Date(meeting.scheduledAt.getTime() - BOARD_AGENDA_CUTOFF_MS);
}

/** True when a Board member submission at `now` is inside the cutoff. */
export function isInsideBoardCutoff(
  meeting: AgendaMeetingRef,
  now: Date,
): boolean {
  const cutoff = agendaCutoffAt(meeting);
  if (!cutoff) return false;
  // "scheduledAt minus now is under 5 days" (§4.3): strictly under rejects;
  // exactly at the cutoff instant the submission is still in time.
  return now.getTime() > cutoff.getTime();
}

/** True when notice is sent and the meeting starts within 48 hours. */
export function isInsideFounderOnlyWindow(
  meeting: AgendaMeetingRef,
  now: Date,
): boolean {
  if (!meeting.noticeSentAt) return false;
  const msUntil = meeting.scheduledAt.getTime() - now.getTime();
  return msUntil >= 0 && msUntil < FOUNDER_ONLY_ADD_WINDOW_MS;
}

/** After a post-notice amendment made while the meeting is still more
 *  than 48 hours away, a re-notice email is required (ws-a §3.3). */
export function amendmentRequiresReNotice(
  meeting: AgendaMeetingRef,
  now: Date,
): boolean {
  if (!meeting.noticeSentAt) return false;
  return meeting.scheduledAt.getTime() - now.getTime() >= FOUNDER_ONLY_ADD_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Submission evaluation (POST /agenda)
// ---------------------------------------------------------------------------

export interface SubmissionDecision {
  allowed: true;
  source: AgendaItemSource;
  /** Submissions are addressed to the NGS (meeting secretaryUid); chair
   *  and Founder items are part of the preliminary agenda itself. */
  addressedToUid: string | null;
  notifyImmediately: boolean;
  requiresReNotice: boolean;
}

/**
 * Decide whether `actor` may add an item at `now`, and with what source.
 * Throws AgendaError carrying the spec error_code on refusal.
 */
export function evaluateAgendaSubmission(
  meeting: AgendaMeetingRef,
  actor: AgendaActor,
  now: Date,
): SubmissionDecision {
  assertMeetingOpen(meeting);
  const kind = classifyAgendaActor(actor);

  if (kind === "outsider") {
    throw new AgendaError(
      AGENDA_ERROR_CODES.notAMember,
      403,
      "Only the presiding officer, the Founder, or a member of this body may add agenda items.",
    );
  }

  // Founder: any body, any time, no cutoff of any kind (P-03).
  if (kind === "founder") {
    return {
      allowed: true,
      source: "founder",
      addressedToUid: null,
      notifyImmediately: isInsideFounderOnlyWindow(meeting, now),
      requiresReNotice: amendmentRequiresReNotice(meeting, now),
    };
  }

  // Post-notice, inside 48 hours: only the Founder may add (ws-a §3.3).
  if (isInsideFounderOnlyWindow(meeting, now)) {
    throw new AgendaError(
      AGENDA_ERROR_CODES.lateWindowFounderOnly,
      422,
      "The meeting starts within 48 hours and its notice has been sent: only the Founder may add agenda items now.",
    );
  }

  // Chair: preliminary agenda, never cut off (ws-a §4.3).
  if (kind === "chair") {
    return {
      allowed: true,
      source: "chair",
      addressedToUid: null,
      notifyImmediately: false,
      requiresReNotice: amendmentRequiresReNotice(meeting, now),
    };
  }

  // Body member submission path: Board 5-day cutoff applies (§4.3).
  if (isInsideBoardCutoff(meeting, now)) {
    throw new AgendaError(
      AGENDA_ERROR_CODES.cutoffPassed,
      422,
      "Board agenda submissions close 5 days before the meeting; this submission is inside the cutoff.",
    );
  }
  return {
    allowed: true,
    source: "member_submission",
    addressedToUid: meeting.secretaryUid || null,
    notifyImmediately: false,
    requiresReNotice: amendmentRequiresReNotice(meeting, now),
  };
}

// ---------------------------------------------------------------------------
// Item construction / validation
// ---------------------------------------------------------------------------

export function normalizeAttachments(
  input: AgendaItemInput["attachments"],
): AgendaAttachment[] {
  if (!input) return [];
  return input.map((a) => {
    const label = typeof a?.label === "string" ? a.label.trim() : "";
    if (!label) {
      throw new AgendaError(
        AGENDA_ERROR_CODES.validation,
        422,
        "Every agenda attachment needs a label.",
      );
    }
    return {
      label,
      driveFileId: a.driveFileId ?? null,
      url: a.url ?? null,
    };
  });
}

export function buildAgendaItem(
  input: AgendaItemInput,
  proposerUid: string,
  source: AgendaItemSource,
  itemId: string,
): AgendaItem {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) {
    throw new AgendaError(
      AGENDA_ERROR_CODES.validation,
      422,
      "An agenda item needs a title.",
    );
  }
  return {
    itemId,
    title,
    description:
      typeof input.description === "string" ? input.description : "",
    proposerUid,
    source,
    decisionClassId: input.decisionClassId ?? null,
    attachments: normalizeAttachments(input.attachments),
  };
}

/** Append an item; the embedded array order IS the agenda order (§3.3). */
export function appendAgendaItem(
  agenda: AgendaItem[],
  item: AgendaItem,
): AgendaItem[] {
  return [...agenda, item];
}

// ---------------------------------------------------------------------------
// PATCH: edit + reorder (+ guarded deletion)
// ---------------------------------------------------------------------------

export interface AgendaPatchResult {
  agenda: AgendaItem[];
  /** True when the patch changed anything (drives agendaAmendedAt). */
  changed: boolean;
}

/**
 * Apply a preliminary-agenda patch. Chair or Founder only.
 * - edits: title / description / decisionClassId per itemId.
 * - order: full permutation of the itemIds that survive the patch.
 * - removeItemIds: deleting a Founder-added item is Founder-only (§4.3).
 */
export function applyAgendaPatch(
  meeting: AgendaMeetingRef,
  actor: AgendaActor,
  patch: AgendaPatch,
): AgendaPatchResult {
  assertMeetingOpen(meeting);
  if (!canEditPreliminaryAgenda(actor)) {
    throw new AgendaError(
      AGENDA_ERROR_CODES.editForbidden,
      403,
      "Only the presiding officer or the Founder may edit the preliminary agenda.",
    );
  }

  const byId = new Map(meeting.agenda.map((item) => [item.itemId, item]));
  let changed = false;

  for (const edit of patch.items ?? []) {
    const existing = byId.get(edit.itemId);
    if (!existing) {
      throw new AgendaError(
        AGENDA_ERROR_CODES.itemNotFound,
        404,
        `Agenda item ${edit.itemId} does not exist on this meeting.`,
      );
    }
    const next: AgendaItem = { ...existing };
    if (edit.title !== undefined) {
      const title = edit.title.trim();
      if (!title) {
        throw new AgendaError(
          AGENDA_ERROR_CODES.validation,
          422,
          "An agenda item title cannot be emptied.",
        );
      }
      next.title = title;
    }
    if (edit.description !== undefined) next.description = edit.description;
    if (edit.decisionClassId !== undefined) {
      next.decisionClassId = edit.decisionClassId;
    }
    if (
      next.title !== existing.title ||
      next.description !== existing.description ||
      next.decisionClassId !== existing.decisionClassId
    ) {
      changed = true;
    }
    byId.set(edit.itemId, next);
  }

  for (const itemId of patch.removeItemIds ?? []) {
    const existing = byId.get(itemId);
    if (!existing) {
      throw new AgendaError(
        AGENDA_ERROR_CODES.itemNotFound,
        404,
        `Agenda item ${itemId} does not exist on this meeting.`,
      );
    }
    if (existing.source === "founder" && !actor.isFounder) {
      throw new AgendaError(
        AGENDA_ERROR_CODES.founderItemDeleteForbidden,
        403,
        "A Founder-added agenda item may only be removed by the Founder.",
      );
    }
    byId.delete(itemId);
    changed = true;
  }

  let result = meeting.agenda
    .filter((item) => byId.has(item.itemId))
    .map((item) => byId.get(item.itemId) as AgendaItem);

  if (patch.order !== undefined) {
    const surviving = new Set(result.map((item) => item.itemId));
    const orderSet = new Set(patch.order);
    if (
      patch.order.length !== surviving.size ||
      orderSet.size !== patch.order.length ||
      [...surviving].some((id) => !orderSet.has(id))
    ) {
      throw new AgendaError(
        AGENDA_ERROR_CODES.orderMismatch,
        422,
        "order must list every surviving agenda item exactly once.",
      );
    }
    const before = result.map((item) => item.itemId).join(" ");
    result = patch.order.map((id) => byId.get(id) as AgendaItem);
    if (result.map((item) => item.itemId).join(" ") !== before) {
      changed = true;
    }
  }

  return { agenda: result, changed };
}
