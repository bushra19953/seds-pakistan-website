/**
 * Quorum adapter — the ONLY quorum entry point for the meeting lifecycle
 * slice (Phase 3, Workstream A, worker 5: lifecycle + auto-adjourn).
 *
 * ADAPTER NOTE (worker 4 dependency): the shared quorum engine is owned by
 * worker 4 and lands at `src/lib/governance/quorum-engine.ts`
 * (phase3_spec Part A, section 6.2). That file did NOT exist in this tree
 * when this slice was built, so this adapter ships a spec-faithful fallback
 * implementation of `evaluateQuorum` / `computePresent` (section 6.2 rules,
 * verbatim) behind the same call shape. When quorum-engine.ts lands, the
 * integration step is a one-line change inside this file: register the real
 * engine via `registerQuorumEngine()` (or replace the fallback body with a
 * re-export). No caller of this slice ever imports quorum math directly or
 * re-implements it; every caller goes through this adapter.
 *
 * Rules implemented by the fallback (spec 6.2):
 * - computePresent: count of attendance docs with isPresent true.
 *   Electronic counts identically to in person; absent never counts.
 * - Board ordinary sitting: present >= required (quorumRequired, default 5).
 * - Board adjourned sitting: present >= 3 AND founderPresent true.
 * - Other bodies: present >= required (the meeting's stored quorumRequired).
 * Returns { met, presentCount, required, founderConditionMet }.
 */

import { evaluateQuorum as engineEvaluate } from './quorum-engine';
import type { AttendanceRecord, BodyConfigView } from './types';

export type GovernanceBodyType =
  | 'board'
  | 'nec'
  | 'council'
  | 'council_of_chapters'
  | 'general_body'
  | 'chapter_committee';

export interface AttendanceLike {
  uid: string;
  /** in_person | electronic | absent (spec 3.4). */
  mode?: string | null;
  isPresent: boolean;
  isFounder?: boolean;
}

export interface QuorumEvaluationInput {
  bodyType: string;
  /** The meeting's stored quorumRequired (spec 3.3); recomputation uses the
   *  stored value, not a live recount of a possibly changed body. */
  quorumRequired: number;
  /** True when this sitting is itself an adjourned reconvene sitting
   *  (meeting.type === 'adjourned'), which triggers the reduced Board rule. */
  isAdjournedSitting: boolean;
  attendance: AttendanceLike[];
}

export interface QuorumEvaluation {
  met: boolean;
  presentCount: number;
  required: number;
  founderPresent: boolean;
  /** For the Board adjourned rule: true when a Founder is present. For all
   *  other sittings the founder condition does not apply and this mirrors
   *  founderPresent so callers can log it uniformly. */
  founderConditionMet: boolean;
}

export type QuorumEngineFn = (input: QuorumEvaluationInput) => QuorumEvaluation;

let registeredEngine: QuorumEngineFn | null = null;

/**
 * Integration hook for worker 4's shared engine. When
 * `src/lib/governance/quorum-engine.ts` exists, a wiring module calls this
 * once with its `evaluateQuorum` so every lifecycle caller transparently
 * uses the shared implementation. Until then the fallback below is used.
 */
export function registerQuorumEngine(fn: QuorumEngineFn | null): void {
  registeredEngine = fn;
}

/** True when a shared engine has been registered (false = fallback active). */
export function hasRegisteredQuorumEngine(): boolean {
  return registeredEngine !== null;
}

export function computePresent(attendance: AttendanceLike[]): number {
  return attendance.filter((a) => a.isPresent).length;
}

export function isFounderPresent(attendance: AttendanceLike[]): boolean {
  return attendance.some((a) => a.isPresent && a.isFounder === true);
}

/** Spec 6.2 fallback implementation (see header). */
function fallbackEvaluateQuorum(input: QuorumEvaluationInput): QuorumEvaluation {
  const presentCount = computePresent(input.attendance);
  const founderPresent = isFounderPresent(input.attendance);
  const isBoard = input.bodyType === 'board';

  if (isBoard && input.isAdjournedSitting) {
    // Reduced adjourned rule: 3 present WITH the Founder present.
    const required = 3;
    const founderConditionMet = founderPresent;
    return {
      met: presentCount >= required && founderConditionMet,
      presentCount,
      required,
      founderPresent,
      founderConditionMet,
    };
  }

  const required =
    Number.isFinite(input.quorumRequired) && input.quorumRequired > 0
      ? input.quorumRequired
      : isBoard
        ? 5
        : presentCount; // no stored requirement and not Board: cannot fail on count alone
  return {
    met: presentCount >= required,
    presentCount,
    required,
    founderPresent,
    founderConditionMet: founderPresent,
  };
}

/**
 * INTEGRATION (step 9): the real quorum engine has landed
 * (src/lib/governance/quorum-engine.ts), so the default path now bridges
 * to it - the fallback below is retained only as the documented spec
 * reference and is no longer used at runtime. The bridge passes the
 * meeting's stored quorumRequired through (the engine's own rule order
 * still forces 3 + Founder for a Board adjourned sitting) and maps the
 * adapter's AttendanceLike records onto engine AttendanceRecords; the
 * stored isPresent flag wins in both implementations, so presence
 * counts are identical. memberUids is passed empty: the adapter input
 * carries no membership list, and the engine only consults it when no
 * quorumRequired is stored (the degenerate case, where the fallback
 * also could not fail the sitting).
 */
function engineEvaluateQuorum(input: QuorumEvaluationInput): QuorumEvaluation {
  const result = engineEvaluate({
    memberUids: [],
    bodyType: input.bodyType as BodyConfigView['bodyType'],
    quorumRequired: input.quorumRequired,
    isAdjournedSitting: input.isAdjournedSitting,
  }, input.attendance.map((a) => ({
    uid: a.uid,
    mode: (a.mode ?? 'in_person') as AttendanceRecord['mode'],
    isPresent: a.isPresent,
    isFounder: a.isFounder,
  })));
  return {
    met: result.met,
    presentCount: result.presentCount,
    required: result.required,
    founderPresent: result.founderPresent,
    founderConditionMet: result.founderConditionMet,
  };
}

export function evaluateQuorum(input: QuorumEvaluationInput): QuorumEvaluation {
  if (registeredEngine) return registeredEngine(input);
  return engineEvaluateQuorum(input);
}
