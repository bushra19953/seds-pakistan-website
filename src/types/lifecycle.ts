import type { Timestamp } from 'firebase/firestore';

// Lifecycle engine types (Phase 2, spec Section D).
// Source: ~/workspace/bylaws_incorporation/implementation/phase2_spec.md,
// Section D (D.1 catalog extension, D.2 guard, D.4 ratification,
// D.8 vacancy, D.10 probation restore).
// Stored in Firestore collections: ratifications, vacancies,
// probation_restores. Timestamps use Firestore server timestamps,
// following the convention in src/types/leave.ts.

export type LifecycleCategory = 'A' | 'B' | 'C';

export type LifecycleTier =
  | 'fullOfficer'
  | 'nonOfficerPool'
  | 'cadetship'
  | 'none';

export interface LifecycleRoleDefinition {
  key: string;
  category: LifecycleCategory;
  tier: LifecycleTier;
  chapterScoped: boolean;
  legacy?: {
    rolesCollectionKey?: string;
    usersCollectionAlias?: string;
  };
  appointingRoleKeys: string[];
  appointerNote?: string;
  defaultAppointer: boolean;
  minimumMembershipClassForFullPowers: 'Full' | 'Provisional' | null;
  ratificationRequired: boolean;
  probationRestorable: boolean;
  seatBound: boolean;
  holderCap: number | null;
}

// Sentinel used in appointingRoleKeys meaning the spec's
// "Board (FP interim)" (Section D.1 / Section 0 contract).
export const BOARD_APPOINTER_KEY = 'board_of_governors';

// Sentinel for the Founder as appointer / the self-referential root.
export const FOUNDER_APPOINTER_KEY = 'founder_appointer';

export interface DecidedConsent {
  id: string;
  subjectUid: string;
  roleKey: string | null;
  status: string;
}

// LifecycleContext and LifecycleGuardResult: shapes copied verbatim
// from spec D.2.
export interface LifecycleContext {
  targetUid: string;
  roleKey: string; // canonical catalog key
  action: 'appoint' | 'revoke' | 'demote';
  chapterSlug?: string; // required iff role.chapterScoped
  actorUid: string; // the authenticated caller of applyRoleChange
  actorRoleKeys: string[]; // actor's canonical keys, from authoritative store
  actorChapterSlug?: string;
  subjectMembershipClass: 'Full' | 'Provisional' | 'other' | null;
  subjectIsCadetInProbation: boolean;
  founderOverride: boolean; // true only if actorUid === FOUNDER_UID
  consentLookup: (matter: 'schedule_3_2_c') => DecidedConsent | null;
  seatOccupancy: { holderUids: string[]; cap: number | null };
  vacancyRecordId?: string;
  boardAppointerVoteId?: string; // governance_votes id when appointer is the Board
}

export type LifecycleGuardResult =
  | { allowed: true; appointerKey: string; viaFounderOverride: boolean }
  | {
      allowed: false;
      code:
        | 'APPOINTER_MISMATCH'
        | 'FOUNDER_OVERRIDE_ONLY'
        | 'CHAPTER_MISMATCH'
        | 'CROSS_CHAPTER_DENIED'
        | 'NOT_FULL_MEMBER'
        | 'CADET_IN_PROBATION'
        | 'SEAT_OCCUPIED'
        | 'ROLE_CATALOG_INCOMPLETE'
        | 'BOARD_APPOINTER_EVIDENCE_MISSING';
      appointerKey: string | null;
      detail: string;
    };

// ---------------------------------------------------------------------------
// D.4 Ratification records - collection `ratifications`
// Doc id: deterministic `rat_{appointmentId}`.
// ---------------------------------------------------------------------------

export type RatificationStatus =
  | 'pending'
  | 'ratified'
  | 'deemed_ratified'
  | 'refused';

export interface RatificationDoc {
  id: string;
  appointmentId: string;
  userId: string;
  roleKey: string;
  chapterSlug: string | null;
  appointedBy: string;
  appointedAt: Timestamp;
  ratificationDeadline: Timestamp;
  status: RatificationStatus;
  decidedAt: Timestamp | null;
  voteId: string | null;
  refusalVotesFor: number | null;
  refusalVotesAgainst: number | null;
  eligibleElectors: number | null;
  eligibleElectorUids?: string[];
  requiredRefusals: number | null;
  thresholdMet: boolean | null;
  revocationAuditId: string | null;
  revokedAt: Timestamp | null;
  revocationSkippedReason?: string | null;
  refusalSupersededBy?: string | null;
  createdBy: 'applyRoleChange';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// D.8 Vacancy derivation - collection `vacancies`
// Doc id deterministic: `vac_{scope}_{seatKey}_{chapterSlugOrNational}`.
// ---------------------------------------------------------------------------

export type VacancyScope = 'national' | 'chapter';

export type VacancyStatus = 'open' | 'filled' | 'superseded';

export type VacancyReason =
  | 'role_revoked'
  | 'role_reassigned'
  | 'probation_demotion'
  | 'refusal_revocation'
  | 'unknown';

export interface VacancyAlertsSent {
  day0: Timestamp | null;
  day7: Timestamp | null;
  day23: Timestamp | null;
  day30: Timestamp | null;
}

export interface VacancyDoc {
  id: string;
  seatKey: string;
  scope: VacancyScope;
  chapterSlug: string | null;
  roleKey: string;
  catalogCategory: LifecycleCategory;
  status: VacancyStatus;
  openedAt: Timestamp;
  openedAtSource?: 'audit_trail' | 'first_observation';
  daysOpen: number;
  lastHolderUid: string | null;
  lastHolderVacatedAt: Timestamp | null;
  vacancyReason: VacancyReason;
  founderFallbackDueAt: Timestamp;
  founderFallbackAvailable: boolean;
  alertsSent: VacancyAlertsSent;
  filledByUid: string | null;
  filledAt: Timestamp | null;
  fillingAppointmentId: string | null;
  chapterUnderConstituted: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// D.10 Probation restore - collection `probation_restores`
// Doc id is the warningId.
// ---------------------------------------------------------------------------

export type ProbationRestoreStatus =
  | 'pending'
  | 'restored_automatic'
  | 'reappointment_tasked'
  | 'escalated'
  | 'superseded';

export type ProbationRestoreMode = 'auto' | 'reappoint';

export interface ProbationRestoreDoc {
  id: string;
  warningId: string;
  userId: string;
  preWarningRoleKey: string | null;
  preWarningChapterSlug: string | null;
  demotedToRoleKey: string;
  probationEndsAt: Timestamp;
  status: ProbationRestoreStatus;
  restoreMode: ProbationRestoreMode;
  fellBackToReappointReason?: string | null;
  escalationReason?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}
