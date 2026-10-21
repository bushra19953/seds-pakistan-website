/**
 * Cadetship shared types (phase2_spec.md Section F.1).
 * Client-safe: no Firestore or network access lives here.
 */

export type CadetshipStatus =
  | 'active'
  | 'under_review'
  | 'confirmed'
  | 'extended'
  | 'exited'
  | 'superseded';

/** Statuses in which a cadetship is still live (blocks a second enrolment). */
export const CADETSHIP_LIVE_STATUSES: CadetshipStatus[] = [
  'active',
  'under_review',
  'extended',
];

export const EXIT_REASONS = [
  'evaluation_failed',
  'withdrew',
  'no_engagement',
  'dues_unresolved',
  'conduct',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export interface OrientationItem {
  done: boolean;
  attestedBy: string | null;
  attestedAt: Date | null;
}

export interface WorkshopAttestation {
  attestedBy: string;
  attestedAt: Date;
  eventRef: string | null;
}

export interface WorkshopsItem {
  count: number;
  attestations: WorkshopAttestation[];
}

export interface SprintTaskItem {
  taskId: string | null;
  completedAt: Date | null;
  detectedBy: 'auto' | 'officer' | null;
}

export interface CadetshipItems {
  orientation: OrientationItem;
  workshops: WorkshopsItem;
  sprintTask: SprintTaskItem;
}

export interface ConductBlock {
  acknowledged: boolean;
  acknowledgedAt: Date | null;
}

export interface DuesGateSnapshot {
  status: 'not_checked' | 'passed' | 'blocked';
  lastCheckedAt: Date | null;
  /** Raw value returned by the Phase 1 resolver, stored verbatim. */
  duesStatus: string | null;
}

export type DecisionOutcome = 'confirmed' | 'extended' | 'exited';

export interface CadetshipDecision {
  outcome: DecisionOutcome | null;
  decidedBy: string | null;
  decidedByRole: string | null;
  decidedAt: Date | null;
  round: 1 | 2;
  note: string | null;
  /** Member-facing summary written by the deciding officer, or null. */
  memberNote: string | null;
  exitReason: ExitReason | null;
  resolutionOf: 'disagreement' | null;
  chosenRecommendation: EvaluationRecommendation | null;
}

export interface CadetshipDoc {
  id: string;
  personUid: string;
  applicationId: string;
  cohortId: string;
  chapterId: string;
  createdVia: 'application_approval' | 'shortlist_redirect';
  status: CadetshipStatus;
  startedAt: Date;
  probationEnd: Date;
  extendedTo: Date | null;
  extensionUsed: boolean;
  /** Round 2 only: set by the cron stanza when extendedTo passes. */
  reviewDue?: boolean;
  items: CadetshipItems;
  conduct: ConductBlock;
  duesGate: DuesGateSnapshot;
  decision: CadetshipDecision;
  /** Set when the post-confirmation membership-class write is outstanding. */
  membershipClassWritePending?: boolean;
  evaluationReminderSentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

export type EvaluationRecommendation = 'confirm' | 'extend' | 'exit';

export interface EvaluationDoc {
  evaluatorUid: string;
  /** Snapshot of the role the evaluator held at submission time. */
  evaluatorRoleKey: string;
  evaluatorChapterId: string | null;
  recommendation: EvaluationRecommendation;
  note: string;
  submittedAt: Date;
  revisedAt: Date | null;
  singleEvaluatorReason: 'no_team_lead' | null;
}

export function emptyCadetshipItems(): CadetshipItems {
  return {
    orientation: { done: false, attestedBy: null, attestedAt: null },
    workshops: { count: 0, attestations: [] },
    sprintTask: { taskId: null, completedAt: null, detectedBy: null },
  };
}

export function initialDuesGate(): DuesGateSnapshot {
  return { status: 'not_checked', lastCheckedAt: null, duesStatus: null };
}

export function initialDecision(round: 1 | 2 = 1): CadetshipDecision {
  return {
    outcome: null,
    decidedBy: null,
    decidedByRole: null,
    decidedAt: null,
    round,
    note: null,
    memberNote: null,
    exitReason: null,
    resolutionOf: null,
    chosenRecommendation: null,
  };
}
