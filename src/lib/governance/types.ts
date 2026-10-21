/**
 * Shared governance types for Phase 3 Part A (meetings, minutes, voting).
 *
 * Plain data only: no Firebase / Firestore imports, so this module is safe to
 * import from client components, server services, and pure engines alike.
 * The quorum engine (src/lib/governance/quorum-engine.ts) consumes the views
 * and record shapes defined here; callers pass plain data in and get plain
 * data out.
 */

/** Bodies that can hold a governed meeting (bodies.type, Phase 1 read contract). */
export type BodyType =
  | 'board'
  | 'nec'
  | 'council'
  | 'council_of_chapters'
  | 'general_body'
  | 'chapter_committee';

/**
 * Attendance mode for one member at one sitting.
 * `electronic` counts IDENTICALLY to `in_person` for quorum and voting (P-07).
 * `absent` never counts.
 */
export type AttendanceMode = 'in_person' | 'electronic' | 'absent';

/**
 * Plain view of one meeting_attendance record, as consumed by the engine.
 * `isPresent` is the stored derived flag (mode is not absent AND leftAt is
 * null); when it is absent the engine derives presence from `mode`/`leftAt`.
 * `leftAt` is an opaque timestamp value (ISO string, epoch ms, or Date) —
 * only its null-ness matters to the engine.
 */
export interface AttendanceRecord {
  uid: string;
  mode: AttendanceMode;
  isPresent?: boolean;
  leftAt?: unknown | null;
  /** Snapshot flag: this attendee is the Founder (adjourned-Board quorum + casting ballot). */
  isFounder?: boolean;
  displayName?: string;
}

/**
 * Read-only view of a body (bodies doc, Phase 1) plus the sitting facts the
 * engine needs. This is the ONLY source of quorum configuration for non-Board
 * bodies: the engine never infers membership or quorum from role tokens.
 */
export interface BodyConfigView {
  /** All eligible member uids of the body; the eligibility snapshot source. */
  memberUids: string[];
  bodyType: BodyType;
  /**
   * Quorum stored on the meeting at notice time. When set it wins over the
   * defaults (except that a Board adjourned sitting always requires 3 +
   * Founder — see evaluateQuorum).
   */
  quorumRequired?: number | null;
  /** Explicit quorum override carried on the body doc, if any. */
  quorumOverride?: number | null;
  /** True when this sitting is an adjourned reconvene of an earlier sitting. */
  isAdjournedSitting?: boolean;
  /**
   * Whether the Founder is present at this sitting. When omitted, the engine
   * derives it from attendance records carrying `isFounder: true`.
   */
  founderPresent?: boolean;
}

/** Majority rule copied from a decision class (decisionClasses doc, Phase 2). */
export type MajorityType =
  | 'ordinary_present_and_voting'
  | 'fraction_of_all_governors'
  | 'fraction_of_all_full_members'
  | 'fraction_of_all_representatives'
  | 'plurality'
  | 'single_person';

/** What a threshold fraction / majority is measured against. */
export type DenominatorKind =
  | 'present_and_voting'
  | 'all_governors'
  | 'all_full_members'
  | 'all_representatives'
  | 'snapshot_present';

/**
 * Read-only view of a decision class, as consumed at motion open.
 * `numerator`/`denominator` express the fraction for fraction classes
 * (e.g. 2/3 of all Governors is numerator 2, denominator 3).
 */
export interface DecisionClassView {
  id?: string;
  majorityType: MajorityType;
  numerator: number | null;
  denominator?: number | null;
  denominatorKind: DenominatorKind;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

/**
 * Threshold copied IMMUTABLY onto a motion at open and never re-read from the
 * class afterwards. `requiredCount` is computed at open for fraction types
 * from the denominator snapshot.
 */
export interface MotionThreshold {
  majorityType: MajorityType;
  numerator: number | null;
  denominator?: number | null;
  denominatorKind: DenominatorKind;
  requiredCount: number | null;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

/**
 * Denominator frozen at motion open. Later joins/leaves NEVER change an open
 * motion's snapshot; a paused motion resumes with this original snapshot.
 */
export interface DenominatorSnapshot {
  /** Every eligible uid of the body at open (copy — safe from caller mutation). */
  eligibleUids: string[];
  /** Uids present at open (in person or electronic — identical weight). */
  presentUids: string[];
  presentCount: number;
  /** eligibleUids.length at open; the "whole" for fraction thresholds. */
  wholeBodyCount: number;
}

/** A single ballot choice. */
export type BallotChoice = 'for' | 'against' | 'abstain';

/**
 * Plain view of one traceable ballot. A Founder casting ballot carries
 * `isCastingVote: true` and is ALWAYS tallied separately from ordinary votes.
 */
export interface BallotRecord {
  voterUid: string;
  choice: BallotChoice;
  isCastingVote?: boolean;
  isProxy?: boolean;
  proxyForUid?: string | null;
}

/** Ordinary vote tallies. Casting ballots are NEVER included here. */
export interface VoteTallies {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
}

/** Motion lifecycle statuses the quorum engine reasons about. */
export type MotionStatus =
  | 'open'
  | 'paused_quorum_lost'
  | 'closed_passed'
  | 'closed_failed'
  | 'closed_tied_pending_casting'
  | 'withdrawn';

/** Result of a quorum evaluation / verification. */
export interface QuorumEvaluation {
  /** True when the sitting may conduct business (and motions may open). */
  met: boolean;
  presentCount: number;
  /** The quorum number applied for this sitting. */
  required: number;
  /** True when this sitting's quorum rule includes a Founder-presence condition. */
  founderRequired: boolean;
  /** The Founder-presence condition itself (true when not required). */
  founderConditionMet: boolean;
  founderPresent: boolean;
}

/** Outcome of a threshold evaluation at motion close. */
export type ThresholdOutcome = 'passed' | 'failed' | 'tie_pending_casting';

/** Full threshold evaluation result, shaped to fill a motion's `result` map. */
export interface ThresholdEvaluation {
  outcome: ThresholdOutcome;
  /** Mirrors `outcome === 'passed'`. */
  thresholdMet: boolean;
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  /**
   * The denominator the threshold was measured against: present-and-voting
   * (for + against) for ordinary, the snapshot whole-body count for fraction
   * types, present-and-voting for plurality, 1 for single_person.
   */
  denominatorUsed: number;
  /** Votes-for required to pass (fraction types); null for ordinary/plurality. */
  requiredCount: number | null;
  /** True when a Founder casting ballot decided (or was recorded on) this motion. */
  castingVoteUsed: boolean;
  /** The casting choice, recorded SEPARATELY — never merged into the tallies. */
  castingChoice: BallotChoice | null;
}

/** The single Founder casting ballot on a tied motion. */
export interface CastingBallotRecord {
  voterUid: string;
  choice: BallotChoice;
  isCastingVote: true;
}

/** Minimal motion view the engine needs to report quorum-loss effects. */
export interface MotionQuorumView {
  motionId: string;
  status: MotionStatus;
}

/**
 * Report of what a quorum change means for one motion. The engine REPORTS;
 * it never mutates motions — the caller applies `resultingStatus`.
 */
export interface MotionQuorumEffect {
  motionId: string;
  previousStatus: MotionStatus;
  resultingStatus: MotionStatus;
  action: 'pause' | 'resume' | 'none';
}

// ---------------------------------------------------------------------------
// Governance RECORDS types (Phase 3 Workstream D) - INTEGRATION NOTE
// (step 12): this section lived at this same path on the records branch
// while the meetings section above lived here on the meetings-core
// branch. The two modules share no export names, so the file is a union:
// meetings/quorum types above, records types below. Importers of either
// half are unaffected.
// ---------------------------------------------------------------------------

// Governance records: core types and id scheme (Workstream D, spec 3.1-3.4).
// Pure module: no Firestore, no Drive, no server imports, so it is safe to
// import from client code, API routes, and unit tests alike.

export const SERIES = [
  'constitution_suite',
  'policy',
  'mou',
  'minutes',
  'resolution',
  'registrar_filing',
  'fbr_receipt',
  'benchmarking_pack',
  'charter',
  'acceptance_letter',
  'consent_record',
  'other',
] as const;
export type GovernanceSeries = (typeof SERIES)[number];

export const STATUS = [
  'draft',
  'approved',
  'effective',
  'superseded',
  'archived',
] as const;
export type GovernanceStatus = (typeof STATUS)[number];

export const ADOPTION_STATUS = [
  'not_adopted',
  'adopted_pending_execution',
  'adopted_executed',
  'not_applicable',
] as const;
export type AdoptionStatus = (typeof ADOPTION_STATUS)[number];

export const EFFECTIVE_STATUS = [
  'not_in_force_pending_registration',
  'in_force',
  'not_applicable',
] as const;
export type EffectiveStatus = (typeof EFFECTIVE_STATUS)[number];

export const ACCESS_LEVEL = [
  'officer_only',
  'board_council',
  'members',
  'public',
] as const;
export type AccessLevel = (typeof ACCESS_LEVEL)[number];

export const REDACTION_STATUS = [
  'not_required',
  'redacted',
  'UNREDACTED_DO_NOT_PUBLISH',
] as const;
export type RedactionStatus = (typeof REDACTION_STATUS)[number];

// Spec 3.3: fixed series -> code map used in family ids.
export const SERIES_CODE: Record<GovernanceSeries, string> = {
  constitution_suite: 'cs',
  policy: 'pol',
  mou: 'mou',
  minutes: 'min',
  resolution: 'res',
  registrar_filing: 'reg',
  fbr_receipt: 'fbr',
  benchmarking_pack: 'bench',
  charter: 'chr',
  acceptance_letter: 'acc',
  consent_record: 'con',
  other: 'oth',
};

export const SERIES_BY_CODE: Record<string, GovernanceSeries> = Object.fromEntries(
  Object.entries(SERIES_CODE).map(([series, code]) => [code, series as GovernanceSeries]),
);

// Spec 3.4 status machine. Transitions run only through the transition route.
// 'superseded' is system-only: it is set automatically when a successor
// version in the same family reaches approved, never by an admin directly.
// It is listed here so the machine is complete; route code must reject a
// direct admin request for it.
export const STATUS_TRANSITIONS: Record<GovernanceStatus, GovernanceStatus[]> = {
  draft: ['approved', 'archived', 'superseded'],
  approved: ['effective', 'archived', 'superseded'],
  effective: ['archived', 'superseded'],
  archived: ['superseded'],
  superseded: [],
};

export function isValidStatusTransition(from: GovernanceStatus, to: GovernanceStatus): boolean {
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

// References out of a record (spec 3.2 links map). Plain ids only; the API
// never embeds the linked document's data.
export type RegisterKind =
  | 'members'
  | 'roles'
  | 'interests'
  | 'consents'
  | 'governors'
  | 'decisions';

export interface GovernanceRecordLinks {
  decisionRecordId?: string;
  meetingId?: string;
  obligationId?: string;
  registerRefs?: Array<{ register: RegisterKind; entryId: string }>;
  chapterId?: string;
}

// One document per VERSION of a document (spec 3.1/3.2). recordDate,
// createdAt, and updatedAt are ISO strings at this layer; API routes adapt
// Firestore Timestamps to and from this shape.
export interface GovernanceRecord {
  recordId: string;
  familyId: string;
  series: GovernanceSeries;
  layer: number | null;
  title: string;
  parties: string[];
  recordDate: string;
  version: number;
  supersedesRecordId: string | null;
  supersededByRecordId: string | null;
  status: GovernanceStatus;
  adoptionStatus: AdoptionStatus;
  // System-only: written only by deriveEffectiveStatus, never by a client.
  effectiveStatus: EffectiveStatus;
  driveFileId: string | null;
  driveUrl: string | null;
  driveFolderId: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  uploadedBy: string;
  approvedBy: string | null;
  consentId: string | null;
  accessLevel: AccessLevel;
  redactionStatus: RedactionStatus;
  redactedFromRecordId: string | null;
  links: GovernanceRecordLinks;
  notes: string;
  createdAt: string | null;
  updatedAt: string | null;
}

// --- Family id and record id scheme (spec 3.3) ---

// Slug: lowercase kebab-case, [a-z0-9-], max 40 chars, no leading, trailing,
// or doubled hyphens.
export const SLUG_MAX_LENGTH = 40;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: unknown): slug is string {
  return (
    typeof slug === 'string' &&
    slug.length >= 1 &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(slug)
  );
}

export function makeFamilyId(series: GovernanceSeries, slug: string): string {
  const code = SERIES_CODE[series];
  if (!code) {
    throw new Error(`makeFamilyId: unknown series "${String(series)}"`);
  }
  if (!isValidSlug(slug)) {
    throw new Error(
      `makeFamilyId: invalid slug "${String(slug)}" (lowercase kebab-case, [a-z0-9-], max ${SLUG_MAX_LENGTH} chars)`,
    );
  }
  return `govfam-${code}-${slug}`;
}

export const FAMILY_ID_PATTERN = /^govfam-([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function isValidFamilyId(familyId: unknown): familyId is string {
  if (typeof familyId !== 'string') return false;
  const match = FAMILY_ID_PATTERN.exec(familyId);
  if (!match) return false;
  if (!(match[1] in SERIES_BY_CODE)) return false;
  return isValidSlug(match[2]);
}

export function parseFamilyId(
  familyId: string,
): { series: GovernanceSeries; seriesCode: string; slug: string } | null {
  if (!isValidFamilyId(familyId)) return null;
  const match = FAMILY_ID_PATTERN.exec(familyId) as RegExpExecArray;
  return {
    series: SERIES_BY_CODE[match[1]],
    seriesCode: match[1],
    slug: match[2],
  };
}

export function makeRecordId(familyId: string, version: number): string {
  if (!isValidFamilyId(familyId)) {
    throw new Error(`makeRecordId: invalid familyId "${String(familyId)}"`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`makeRecordId: version must be a positive integer, got ${String(version)}`);
  }
  return `${familyId}--v${String(version).padStart(3, '0')}`;
}

export const RECORD_ID_PATTERN = /^(govfam-[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)*)--v(\d{3,})$/;

export function parseRecordId(
  recordId: string,
): { familyId: string; version: number } | null {
  if (typeof recordId !== 'string') return null;
  const match = RECORD_ID_PATTERN.exec(recordId);
  if (!match) return null;
  const familyId = match[1];
  if (!isValidFamilyId(familyId)) return null;
  const version = Number.parseInt(match[2], 10);
  if (!Number.isInteger(version) || version < 1) return null;
  return { familyId, version };
}
