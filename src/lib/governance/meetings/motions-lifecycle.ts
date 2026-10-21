/**
 * Motion lifecycle state machine (ws-a.md §3.5 status enum, §6.2).
 *
 * Pure functions, no I/O. The server service (src/lib/server/governance/
 * motions.ts) is the only writer of motion status and routes every change
 * through `assertMotionTransition`; API routes never write status directly.
 *
 * Legal transitions:
 *   open -> paused_quorum_lost        (quorum lost mid-meeting, §6.2)
 *   paused_quorum_lost -> open        (quorum regained; snapshot NOT retaken)
 *   open -> closed_passed             (close, threshold met)
 *   open -> closed_failed             (close, threshold not met / tie, no casting body)
 *   open -> closed_tied_pending_casting (close, ordinary tie at Board/Council)
 *   closed_tied_pending_casting -> closed_passed  (Founder casting ballot: for)
 *   closed_tied_pending_casting -> closed_failed  (casting ballot: against/abstain)
 *   open -> withdrawn                 (withdrawn before close)
 *   paused_quorum_lost -> withdrawn
 * Everything else is invalid: closed_* (other than the tied state) and
 * withdrawn are terminal, a paused motion must resume before it can close,
 * and no closed motion can ever reopen.
 */

import type { MotionStatus } from "./motions-types";

export class MotionError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "MotionError";
    this.code = code;
    this.status = status;
  }
}

export const MOTION_TRANSITIONS: Readonly<Record<MotionStatus, readonly MotionStatus[]>> = {
  open: ["paused_quorum_lost", "closed_passed", "closed_failed", "closed_tied_pending_casting", "withdrawn"],
  paused_quorum_lost: ["open", "withdrawn"],
  closed_tied_pending_casting: ["closed_passed", "closed_failed"],
  closed_passed: [],
  closed_failed: [],
  withdrawn: [],
};

export function canTransitionMotion(from: MotionStatus, to: MotionStatus): boolean {
  return (MOTION_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function isTerminalMotionStatus(status: MotionStatus): boolean {
  return status === "closed_passed" || status === "closed_failed" || status === "withdrawn";
}

export function assertMotionTransition(from: MotionStatus, to: MotionStatus): void {
  if (!canTransitionMotion(from, to)) {
    throw new MotionError(
      "invalid_motion_transition",
      `Motion cannot move from ${from} to ${to}`,
      409,
    );
  }
}

/**
 * Fields that may never be changed after a motion is opened. `threshold`,
 * `decisionClassId`, and `denominatorSnapshot` are the immutability core
 * (ws-a §3.5: threshold is copied at open and never re-read); identity and
 * provenance fields are frozen for the same reason.
 */
export const IMMUTABLE_MOTION_FIELDS: readonly string[] = [
  "id",
  "meetingId",
  "bodyId",
  "bodyType",
  "decisionClassId",
  "threshold",
  "denominatorSnapshot",
  "openedAt",
  "openedBy",
  "proposerUid",
];

/**
 * The single guard every motion update path runs. Any patch touching an
 * immutable field is rejected — for `threshold` with the dedicated
 * `threshold_immutable` code — even if the submitted value happens to equal
 * the stored one: there is no legitimate threshold update, so no update is
 * allowed to carry the field at all.
 */
export function guardMotionPatch(patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    if (key === "threshold") {
      throw new MotionError(
        "threshold_immutable",
        "A motion threshold is copied immutably at open and can never be updated",
        422,
      );
    }
    if (IMMUTABLE_MOTION_FIELDS.includes(key)) {
      throw new MotionError(
        "immutable_field",
        `Motion field ${key} cannot be changed after the motion is opened`,
        422,
      );
    }
  }
}
