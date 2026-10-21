/**
 * Urgent decisions by the National President - pure types and timer math.
 *
 * Source: ws-a.md (Workstream A, Phase 3 Meetings/Minutes/Voting) sections
 * 3.13 (urgent_decisions data model), 4.8 (routes), 6.5 (flow and timers).
 * Doc 04 secs 4.10 and 4.11.
 *
 * This module is PURE: no Firebase, no I/O, no Date.now() inside the math -
 * every function takes the instant it evaluates so the server service and
 * the governance-timers cron share exactly one implementation of the two
 * deadlines, and unit tests can pin month-boundary behaviour.
 *
 * Timer semantics (ws-a 6.5 / 6.6):
 * - notificationDueAt  = createdAt + 24 hours. The timer tracks CONFIRMATION
 *   of the Board/Founder notification (dispatch itself is synchronous at
 *   submit). Unconfirmed at the deadline -> escalate to the Founder, once.
 * - ratificationDueAt  = createdAt + 30 days. Unratified at the deadline ->
 *   status void_retroactive; the register entry is void EFFECTIVE FROM the
 *   original createdAt (voidEffectiveFrom), never deleted.
 *
 * NOTE on types placement: ws-a 2.1 puts shared governance types in
 * src/lib/governance/types.ts. That file belongs to the Meetings Core slice
 * and does not exist on this branch yet, so the urgent-decision types live
 * here (ADAPTER) and can be re-exported from types.ts when it lands.
 */

export const URGENT_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const URGENT_RATIFICATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type UrgentDecisionStatus =
  | 'notified_pending_confirmation'
  | 'active_pending_ratification'
  | 'ratified'
  | 'void_retroactive';

export const URGENT_VOID_REASON_RATIFICATION_EXPIRED =
  'ratification_deadline_expired';

/**
 * The urgent_decisions/{decisionId} document shape (ws-a 3.13), with
 * timestamps expressed as epoch milliseconds at this pure layer. The server
 * service converts to/from Firestore Timestamps at the storage boundary.
 */
export interface UrgentDecisionRecord {
  id: string;
  presidentUid: string;
  title: string;
  description: string;
  decisionClassId: string;
  /** Why delay would harm SEDS Pakistan (Doc 04 sec 4.10). Required. */
  harmStatement: string;
  status: UrgentDecisionStatus;
  createdAtMs: number;
  /** createdAtMs + 24h. Confirmation deadline (NOT dispatch). */
  notificationDueAtMs: number;
  /** When Board + Founder notifications were dispatched (normally = createdAt). */
  notifiedAtMs: number | null;
  notificationConfirmedAtMs: number | null;
  notificationConfirmedBy: string | null;
  escalatedToFounderAtMs: number | null;
  /** Body assigned to the class in the decision-class matrix. */
  ratifyingBodyId: string;
  /** createdAtMs + 30 days. */
  ratificationDueAtMs: number;
  ratificationDecisionId: string | null;
  ratificationMotionId: string | null;
  voidedAtMs: number | null;
  voidReason: string | null;
  affectedPartyUids: string[];
  /** decisions register entry id, created at submit (pending_ratification). */
  decisionId: string;
}

/** 24-hour notification-confirmation deadline, computed from creation. */
export function notificationDueAt(createdAt: Date | number): Date {
  const ms = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  return new Date(ms + URGENT_NOTIFICATION_WINDOW_MS);
}

/** 30-day ratification deadline, computed from creation. */
export function ratificationDueAt(createdAt: Date | number): Date {
  const ms = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  return new Date(ms + URGENT_RATIFICATION_WINDOW_MS);
}

export function isPendingStatus(status: UrgentDecisionStatus): boolean {
  return (
    status === 'notified_pending_confirmation' ||
    status === 'active_pending_ratification'
  );
}

/**
 * T4 (ws-a 6.6): escalation is due when the decision is still awaiting
 * notification confirmation, the 24h deadline has passed, and it has not
 * already been escalated. The escalatedToFounderAtMs guard is what makes
 * the cron idempotent.
 */
export function isEscalationDue(
  rec: Pick<
    UrgentDecisionRecord,
    'status' | 'notificationDueAtMs' | 'escalatedToFounderAtMs'
  >,
  nowMs: number
): boolean {
  return (
    rec.status === 'notified_pending_confirmation' &&
    rec.escalatedToFounderAtMs === null &&
    nowMs >= rec.notificationDueAtMs
  );
}

/**
 * T5 (ws-a 6.6): voiding is due when a still-pending decision passes its
 * 30-day ratification deadline. Applies to both pending statuses (a
 * decision whose notification was never confirmed still voids).
 */
export function isRatificationExpired(
  rec: Pick<UrgentDecisionRecord, 'status' | 'ratificationDueAtMs'>,
  nowMs: number
): boolean {
  return isPendingStatus(rec.status) && nowMs >= rec.ratificationDueAtMs;
}

export type RatifyCheck =
  | { ok: true }
  | {
      ok: false;
      error_code:
        | 'already_ratified'
        | 'decision_void'
        | 'ratification_deadline_expired';
    };

/**
 * Whether a ratification may still be recorded at `nowMs`. Ratifying
 * exactly AT the deadline is too late: the cron voids at >= due time, so
 * the service applies the same boundary (now must be strictly before
 * ratificationDueAtMs) - one boundary, shared by route and cron.
 */
export function checkRatifiable(
  rec: Pick<UrgentDecisionRecord, 'status' | 'ratificationDueAtMs'>,
  nowMs: number
): RatifyCheck {
  if (rec.status === 'ratified') return { ok: false, error_code: 'already_ratified' };
  if (rec.status === 'void_retroactive')
    return { ok: false, error_code: 'decision_void' };
  if (nowMs >= rec.ratificationDueAtMs)
    return { ok: false, error_code: 'ratification_deadline_expired' };
  return { ok: true };
}

/** Status after notification confirmation (ws-a 6.5). Ratified/void are terminal. */
export function statusAfterConfirmation(
  status: UrgentDecisionStatus
): UrgentDecisionStatus {
  return status === 'notified_pending_confirmation'
    ? 'active_pending_ratification'
    : status;
}
