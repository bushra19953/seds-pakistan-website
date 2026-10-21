/**
 * Applicant Status Portal: shared model for the induction application
 * pipeline (Workstream 4, spec section 3).
 *
 * The applications/{uid} document only stores a flat `status` value
 * (pending | under_review | on_hold | shortlisted | approved | rejected).
 * This module maps that status onto the applicant-facing pipeline
 * stages and derives everything the /apply/status portal renders:
 *
 *   Submitted -> Screening -> 72-Hour Crucible Sprint -> Final Onboarding
 *   -> Cadetship (Phase 2, Section F.7: the fifth stage, reached only by
 *   an approved applicant whose approval created a cadetship record; the
 *   stage and its payload stay inert while no cadetship exists)
 *
 * It also owns the reference-ID derivation, the domain-preference and
 * onboarding-milestone vocabularies, and the whitelisted validation for
 * the self-service updates accepted by
 * POST/PATCH /api/applications/status. No Firestore or network access
 * lives here, so every rule is unit-testable in isolation.
 */

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export type PipelineStageKey = 'submitted' | 'screening' | 'crucible' | 'onboarding' | 'cadetship';

export interface PipelineStageDefinition {
  key: PipelineStageKey;
  title: string;
  description: string;
  /** Field inside applications/{uid}.stageHistory that stamps this stage. */
  historyKey: 'submittedAt' | 'screeningAt' | 'crucibleAt' | 'onboardingAt' | 'decidedAt' | 'cadetshipAt';
}

export const PIPELINE_STAGES: PipelineStageDefinition[] = [
  {
    key: 'submitted',
    title: 'Submitted',
    description: 'Your application was received by SEDS Pakistan.',
    historyKey: 'submittedAt',
  },
  {
    key: 'screening',
    title: 'Screening',
    description: 'The induction team is reviewing your application.',
    historyKey: 'screeningAt',
  },
  {
    key: 'crucible',
    title: '72-Hour Crucible Sprint',
    description: 'Shortlisted candidates complete the 72-hour crucible sprint.',
    historyKey: 'crucibleAt',
  },
  {
    key: 'onboarding',
    title: 'Final Onboarding',
    description: 'Finish the onboarding checklist and join your chapter team.',
    historyKey: 'onboardingAt',
  },
  {
    key: 'cadetship',
    title: 'Cadetship',
    description: 'Your 8-week cadetship: complete the checklist and pass the week-8 review to become a Full Member.',
    historyKey: 'cadetshipAt',
  },
];

export type StageState = 'complete' | 'current' | 'upcoming' | 'skipped';

export interface PipelineStageState {
  key: PipelineStageKey;
  title: string;
  description: string;
  state: StageState;
  /** ISO timestamp for when the stage was reached, or null if unknown. */
  timestamp: string | null;
  note: string | null;
}

export type ApplicationStatusValue =
  | 'pending'
  | 'under_review'
  | 'shortlisted'
  | 'rejected'
  | 'on_hold'
  | 'approved';

export const KNOWN_APPLICATION_STATUSES: ApplicationStatusValue[] = [
  'pending',
  'under_review',
  'shortlisted',
  'rejected',
  'on_hold',
  'approved',
];

/**
 * The applications/{uid} document shape this module reads. Loose on
 * purpose: the induction form is admin-configured, so arbitrary extra
 * fields can be present and must be ignored, never echoed to the caller.
 */
export interface ApplicationRecord {
  status?: unknown;
  fullName?: unknown;
  university?: unknown;
  email?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  reviewed_at?: unknown;
  resume_url?: unknown;
  transcript_url?: unknown;
  portfolioLink?: unknown;
  githubLink?: unknown;
  domainPreferences?: unknown;
  onboardingMilestones?: unknown;
  stageHistory?: unknown;
  [key: string]: unknown;
}

/** Lowercased stored status, or null when the doc carries none. */
export function normalizeStatus(record: ApplicationRecord): string {
  return typeof record.status === 'string' && record.status.trim()
    ? record.status.trim().toLowerCase()
    : 'pending';
}

/**
 * Which pipeline stage (0-based index into PIPELINE_STAGES) the stored
 * status places the applicant in. Rejection is terminal at screening:
 * the applicant never reaches the crucible or onboarding stages.
 */
export function stageIndexForStatus(status: string): number {
  switch (status) {
    case 'pending':
    case 'under_review':
    case 'on_hold':
    case 'rejected':
      return 1; // Screening
    case 'shortlisted':
      return 2; // 72-Hour Crucible Sprint
    case 'approved':
      return 3; // Final Onboarding
    default:
      return 1;
  }
}

/** The stageHistory key an admin status change should stamp, if any. */
export function stageHistoryKeyForStatus(status: string): string | null {
  switch (status) {
    case 'pending':
    case 'under_review':
    case 'on_hold':
      return 'screeningAt';
    case 'shortlisted':
      return 'crucibleAt';
    case 'approved':
      return 'onboardingAt';
    case 'rejected':
      return 'decidedAt';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Normalize any Firestore-ish timestamp representation (client or Admin
 * SDK Timestamp, Date, { seconds } object, epoch millis, ISO string)
 * into an ISO string, or null when the value carries no usable date.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'object') {
    const anyValue = value as Record<string, unknown>;
    if (typeof anyValue.toDate === 'function') {
      try {
        const date = (anyValue.toDate as () => Date).call(value);
        return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
      } catch {
        return null;
      }
    }
    if (typeof anyValue.seconds === 'number') {
      const millis = anyValue.seconds * 1000 + Math.floor(((anyValue.nanoseconds as number) || 0) / 1e6);
      return new Date(millis).toISOString();
    }
    if (typeof anyValue._seconds === 'number') {
      const millis = anyValue._seconds * 1000 + Math.floor(((anyValue._nanoseconds as number) || 0) / 1e6);
      return new Date(millis).toISOString();
    }
  }
  return null;
}

function stageHistoryOf(record: ApplicationRecord): Record<string, unknown> {
  return record.stageHistory && typeof record.stageHistory === 'object'
    ? (record.stageHistory as Record<string, unknown>)
    : {};
}

/**
 * Best-known timestamp for a pipeline stage. Prefers the explicit
 * stageHistory stamp (written by admin status changes and by the
 * submit path) and falls back to fields that already exist on older
 * documents so no backfill is needed:
 * - Submitted: created_at
 * - Screening: created_at (screening starts at submission)
 * - Crucible / Onboarding: reviewed_at, the last admin review action
 */
function stageTimestamp(record: ApplicationRecord, stageKey: PipelineStageKey, reached: boolean): string | null {
  if (!reached) return null;
  const history = stageHistoryOf(record);
  const historyKey = stageKey === 'submitted'
    ? 'submittedAt'
    : PIPELINE_STAGES.find((s) => s.key === stageKey)?.historyKey;
  const stamped = historyKey ? normalizeTimestamp(history[historyKey]) : null;
  if (stamped) return stamped;
  switch (stageKey) {
    case 'submitted':
    case 'screening':
      return normalizeTimestamp(record.created_at);
    case 'crucible':
    case 'onboarding':
    case 'cadetship':
      // Readers tolerate both: legacy docs carry reviewed_at (snake_case),
      // writers now emit reviewedAt (Phase 2 F.8 standardisation).
      return (
        normalizeTimestamp(record.reviewed_at) ??
        normalizeTimestamp(record.reviewedAt) ??
        normalizeTimestamp(record.updated_at)
      );
    default:
      return null;
  }
}

/** Derive the full stage tracker state from an application record. */
export function derivePipeline(record: ApplicationRecord): {
  status: string;
  terminalRejected: boolean;
  currentStageIndex: number;
  stages: PipelineStageState[];
} {
  const status = normalizeStatus(record);
  const terminalRejected = status === 'rejected';
  // The cadetship stage (index 4) is reached only when the approval pipe
  // stamped a cadetshipId onto the record (Phase 2 F.6/F.7). A legacy
  // approved record without one stays at Final Onboarding, exactly as
  // before F shipped.
  const hasCadetship =
    status === 'approved' &&
    typeof record.cadetshipId === 'string' &&
    record.cadetshipId !== '';
  const cadetshipOutcome =
    typeof record.cadetshipOutcome === 'string' ? record.cadetshipOutcome : null;
  const currentStageIndex = hasCadetship
    ? PIPELINE_STAGES.length - 1
    : stageIndexForStatus(status);

  const stages: PipelineStageState[] = PIPELINE_STAGES.map((stage, index) => {
    let state: StageState;
    if (terminalRejected) {
      // Submitted and screening happened; the later stages never will.
      state = index <= currentStageIndex ? 'complete' : 'skipped';
      if (index === currentStageIndex) state = 'complete';
    } else if (stage.key === 'cadetship' && hasCadetship) {
      if (cadetshipOutcome === 'confirmed') state = 'complete';
      else if (cadetshipOutcome === 'exited') state = 'skipped';
      else state = 'current';
    } else if (index < currentStageIndex) {
      state = 'complete';
    } else if (index === currentStageIndex) {
      state = 'current';
    } else {
      state = 'upcoming';
    }
    const reached = state === 'complete' || state === 'current';
    let note: string | null = null;
    if (status === 'on_hold' && stage.key === 'screening' && state === 'current') {
      note = 'Your application is on hold. The team will resume screening soon.';
    }
    if (status === 'under_review' && stage.key === 'screening' && state === 'current') {
      note = 'Under review by the induction team.';
    }
    if (terminalRejected && stage.key === 'screening') {
      note = 'This application was not accepted for this intake.';
    }
    return {
      key: stage.key,
      title: stage.title,
      description: stage.description,
      state,
      timestamp: stageTimestamp(record, stage.key, reached),
      note,
    };
  });

  return { status, terminalRejected, currentStageIndex, stages };
}

// ---------------------------------------------------------------------------
// Reference ID
// ---------------------------------------------------------------------------

export const REFERENCE_ID_PATTERN = /^SEDS-[A-Z0-9]{6}$/;

/**
 * Public application reference ID, derived deterministically from the
 * application document id (the applicant UID). UIDs are not guessable,
 * and the lookup API additionally requires the applicant email to match,
 * so a reference ID on its own never discloses another applicant's data.
 */
export function makeReferenceId(uid: string): string {
  const slug = String(uid || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase()
    .padEnd(6, '0');
  return `SEDS-${slug}`;
}

/** Normalize user-entered reference input for comparison. Null if malformed. */
export function normalizeReferenceId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const candidate = input.trim().toUpperCase();
  return REFERENCE_ID_PATTERN.test(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Domain preferences (spec section 3: multi-choice domains)
// ---------------------------------------------------------------------------

export interface DomainPreferenceOption {
  value: string;
  label: string;
}

export const DOMAIN_PREFERENCES: DomainPreferenceOption[] = [
  { value: 'propulsion', label: 'Propulsion' },
  { value: 'avionics_embedded', label: 'Avionics and Embedded' },
  { value: 'gnc', label: 'GNC' },
  { value: 'flight_dynamics', label: 'Flight Dynamics' },
  { value: 'design_media', label: 'Design and Media' },
  { value: 'corporate_partnerships', label: 'Corporate Partnerships' },
];

export const DOMAIN_PREFERENCE_VALUES: string[] = DOMAIN_PREFERENCES.map((d) => d.value);

/** Keep only whitelisted domain values, de-duplicated, in canonical order. */
export function sanitizeDomainPreferences(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const chosen = new Set<string>();
  for (const value of input) {
    if (typeof value === 'string' && DOMAIN_PREFERENCE_VALUES.includes(value)) {
      chosen.add(value);
    }
  }
  return DOMAIN_PREFERENCE_VALUES.filter((value) => chosen.has(value));
}

// ---------------------------------------------------------------------------
// Onboarding milestones (spec section 3: shortlisted candidates)
// ---------------------------------------------------------------------------

export interface OnboardingMilestoneDefinition {
  key: string;
  title: string;
  description: string;
}

export const ONBOARDING_MILESTONES: OnboardingMilestoneDefinition[] = [
  {
    key: 'cruciblePledge',
    title: '72-Hour Crucible pledge',
    description: 'Commit to the 72-hour crucible sprint rules and schedule.',
  },
  {
    key: 'whatsappJoined',
    title: 'Chapter WhatsApp group joined',
    description: 'Join your chapter WhatsApp group and introduce yourself.',
  },
  {
    key: 'starterRepoAccess',
    title: 'Starter repo access confirmed',
    description: 'Confirm you can open the starter repository shared by your team lead.',
  },
];

export const ONBOARDING_MILESTONE_KEYS: string[] = ONBOARDING_MILESTONES.map((m) => m.key);

/** Milestones unlock once a candidate is shortlisted (crucible stage) or later. */
export function milestonesUnlocked(status: string): boolean {
  return status === 'shortlisted' || status === 'approved';
}

/** Stored milestone map: key -> ISO completion timestamp or null. */
export function readMilestones(record: ApplicationRecord): Record<string, string | null> {
  const stored = record.onboardingMilestones && typeof record.onboardingMilestones === 'object'
    ? (record.onboardingMilestones as Record<string, unknown>)
    : {};
  const result: Record<string, string | null> = {};
  for (const key of ONBOARDING_MILESTONE_KEYS) {
    result[key] = normalizeTimestamp(stored[key]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface ApplicantDocuments {
  resumeUrl: string | null;
  transcriptUrl: string | null;
  portfolioLink: string | null;
  githubLink: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readDocuments(record: ApplicationRecord): ApplicantDocuments {
  return {
    resumeUrl: stringOrNull(record.resume_url),
    transcriptUrl: stringOrNull(record.transcript_url),
    portfolioLink: stringOrNull(record.portfolioLink),
    githubLink: stringOrNull(record.githubLink),
  };
}

// ---------------------------------------------------------------------------
// Cadetship tracker payload (Phase 2, Section F.7)
// ---------------------------------------------------------------------------

export interface CadetshipTrackerPayload {
  /** Effective (read-time derived) status, never the raw stored value. */
  status: string;
  cohortId: string;
  cohortLabel: string;
  /** Week number, display-capped at 8 in round 1 and 12 once extended. */
  week: number;
  weekCap: number;
  probationEnd: string | null;
  extendedTo: string | null;
  items: {
    orientation: boolean;
    workshops: { count: number; required: number };
    sprintTask: boolean;
    conduct: boolean;
  };
  /** Member-facing decision view: memberNote only, never the internal note. */
  decision: {
    outcome: string | null;
    memberNote: string | null;
    decidedAt: string | null;
    exitReason: string | null;
  } | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function cohortLabelFor(cohortId: string): string {
  const match = /^(\d{4})-cohort-(\d+)$/.exec(cohortId);
  if (!match) return cohortId;
  const endYear = parseInt(match[1], 10);
  return `FY${endYear - 1}-${String(endYear).slice(2)} Cohort ${match[2]}`;
}

/**
 * Build the cadetship payload block from a raw cadetships doc (any
 * timestamp representation; normalized here). Pure: the API route does
 * the Firestore read and hands the data in. Returns null for no record.
 * The week/status derivations mirror src/lib/cadetship/checklist.ts and
 * the clock helpers on purpose: this module is client-safe and must not
 * import the server tree; the two implementations are pinned by tests on
 * both sides.
 */
export function buildCadetshipPayload(
  raw: Record<string, unknown> | null | undefined,
  now: Date
): CadetshipTrackerPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const startedAtIso = normalizeTimestamp(raw.startedAt);
  const probationEndIso = normalizeTimestamp(raw.probationEnd);
  const extendedToIso = normalizeTimestamp(raw.extendedTo);
  const storedStatus = typeof raw.status === 'string' ? raw.status : 'active';

  // Read-time derivation (F.3): an active record past probationEnd reads
  // as under_review even before the cron stanza flips the stored value.
  let status = storedStatus;
  if (
    storedStatus === 'active' &&
    probationEndIso &&
    now.getTime() >= Date.parse(probationEndIso)
  ) {
    status = 'under_review';
  }

  const startedMs = startedAtIso ? Date.parse(startedAtIso) : now.getTime();
  const rawWeek = Math.max(1, Math.floor((now.getTime() - startedMs) / WEEK_MS) + 1);
  const extended = storedStatus === 'extended' || extendedToIso != null;
  const weekCap = extended ? 12 : 8;

  const items = (raw.items ?? {}) as Record<string, any>;
  const workshops = (items.workshops ?? {}) as Record<string, any>;
  const decisionRaw = (raw.decision ?? null) as Record<string, any> | null;

  return {
    status,
    cohortId: typeof raw.cohortId === 'string' ? raw.cohortId : '',
    cohortLabel: cohortLabelFor(typeof raw.cohortId === 'string' ? raw.cohortId : ''),
    week: Math.min(rawWeek, weekCap),
    weekCap,
    probationEnd: probationEndIso,
    extendedTo: extendedToIso,
    items: {
      orientation: items.orientation?.done === true,
      workshops: {
        count: typeof workshops.count === 'number' ? workshops.count : 0,
        required: 2,
      },
      sprintTask: items.sprintTask?.taskId != null,
      conduct: (raw.conduct as Record<string, any> | undefined)?.acknowledged === true,
    },
    decision: decisionRaw
      ? {
          outcome: typeof decisionRaw.outcome === 'string' ? decisionRaw.outcome : null,
          memberNote: typeof decisionRaw.memberNote === 'string' ? decisionRaw.memberNote : null,
          decidedAt: normalizeTimestamp(decisionRaw.decidedAt),
          exitReason: typeof decisionRaw.exitReason === 'string' ? decisionRaw.exitReason : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Status payload (the only shape the API route returns)
// ---------------------------------------------------------------------------

export interface ApplicantStatusPayload {
  referenceId: string;
  fullName: string | null;
  university: string | null;
  status: string;
  terminalRejected: boolean;
  currentStageIndex: number;
  stages: PipelineStageState[];
  documents: ApplicantDocuments;
  domainPreferences: string[];
  milestones: Record<string, string | null>;
  milestonesEditable: boolean;
  canEdit: boolean;
  submittedAt: string | null;
  updatedAt: string | null;
  /** Phase 2 F.7: the cadetship block, or null when no cadetship exists. */
  cadetship: CadetshipTrackerPayload | null;
  /**
   * True for applicants approved before the cadetship pipe shipped (no
   * cadetship record): the portal renders their approved state exactly as
   * before - F never retroactively cadetships the existing membership.
   */
  legacyApproved: boolean;
}

/**
 * Build the sanitized portal payload from a raw application record.
 * Only portal fields are copied across: dynamic form answers, review
 * internals (reviewed_by, rejection_reason, pre_score) and any other
 * stored fields never leave the server.
 *
 * options.fallbackDomainPreferences supplies the users/{uid} mirror
 * value when the application doc itself carries none (a resubmission
 * replaces the application doc wholesale, which would otherwise wipe
 * preferences saved through the portal).
 */
export function buildStatusPayload(
  record: ApplicationRecord,
  uid: string,
  options: {
    canEdit: boolean;
    fallbackDomainPreferences?: unknown;
    cadetship?: CadetshipTrackerPayload | null;
  }
): ApplicantStatusPayload {
  const pipeline = derivePipeline(record);
  const ownPreferences = sanitizeDomainPreferences(record.domainPreferences);
  const domainPreferences = ownPreferences.length > 0
    ? ownPreferences
    : sanitizeDomainPreferences(options.fallbackDomainPreferences);
  const cadetship = options.cadetship ?? null;
  const legacyApproved =
    pipeline.status === 'approved' &&
    !cadetship &&
    !(typeof record.cadetshipId === 'string' && record.cadetshipId !== '');
  return {
    referenceId: makeReferenceId(uid),
    fullName: stringOrNull(record.fullName),
    university: stringOrNull(record.university),
    status: pipeline.status,
    terminalRejected: pipeline.terminalRejected,
    currentStageIndex: pipeline.currentStageIndex,
    stages: pipeline.stages,
    documents: readDocuments(record),
    domainPreferences,
    milestones: readMilestones(record),
    milestonesEditable: milestonesUnlocked(pipeline.status),
    canEdit: options.canEdit,
    submittedAt: normalizeTimestamp(record.created_at),
    updatedAt: normalizeTimestamp(record.updated_at),
    cadetship,
    legacyApproved,
  };
}

// ---------------------------------------------------------------------------
// Self-service update validation (used by PATCH /api/applications/status)
// ---------------------------------------------------------------------------

const MAX_LINK_LENGTH = 2048;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function validateLink(value: unknown, options: { drive: boolean; label: string }): ValidationResult<string | null> {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${options.label} must be a link.` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_LINK_LENGTH) return { ok: false, error: `${options.label} link is too long.` };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `${options.label} must be a valid URL.` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `${options.label} must start with http:// or https://.` };
  }
  if (options.drive && !parsed.hostname.includes('drive.google.com')) {
    return { ok: false, error: `${options.label} must be a Google Drive link.` };
  }
  return { ok: true, value: trimmed };
}

export interface DocumentUpdate {
  resume_url?: string | null;
  transcript_url?: string | null;
  portfolioLink?: string | null;
  githubLink?: string | null;
}

const DOCUMENT_FIELDS: Array<{
  inputKey: string;
  docKey: keyof DocumentUpdate;
  drive: boolean;
  label: string;
}> = [
  { inputKey: 'resumeUrl', docKey: 'resume_url', drive: true, label: 'Resume' },
  { inputKey: 'transcriptUrl', docKey: 'transcript_url', drive: true, label: 'Transcript' },
  { inputKey: 'portfolioLink', docKey: 'portfolioLink', drive: false, label: 'Portfolio link' },
  { inputKey: 'githubLink', docKey: 'githubLink', drive: false, label: 'GitHub link' },
];

/**
 * Validate a documents update from the portal. Only the four known link
 * fields are accepted; anything else (status, reviewed_by, role, ...)
 * is rejected outright so the self-service endpoint can never become a
 * privilege-escalation path.
 */
export function validateDocumentUpdate(input: unknown): ValidationResult<DocumentUpdate> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Documents must be an object.' };
  }
  const source = input as Record<string, unknown>;
  const allowed = new Set(DOCUMENT_FIELDS.map((f) => f.inputKey));
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) return { ok: false, error: `Unknown document field: ${key}` };
  }
  const update: DocumentUpdate = {};
  for (const field of DOCUMENT_FIELDS) {
    if (!(field.inputKey in source)) continue;
    const result = validateLink(source[field.inputKey], { drive: field.drive, label: field.label });
    if (!result.ok) return result;
    update[field.docKey] = result.value;
  }
  return { ok: true, value: update };
}

/** Validate a domain-preferences update: whitelist values only. */
export function validateDomainPreferences(input: unknown): ValidationResult<string[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'Domain preferences must be a list.' };
  for (const value of input) {
    if (typeof value !== 'string' || !DOMAIN_PREFERENCE_VALUES.includes(value)) {
      return { ok: false, error: `Unknown domain preference: ${String(value)}` };
    }
  }
  return { ok: true, value: sanitizeDomainPreferences(input) };
}

/**
 * Validate a milestone toggle update. Keys must be known milestones and
 * values booleans. Completion gating by status happens in the caller
 * via milestonesUnlocked.
 */
export function validateMilestoneUpdate(input: unknown): ValidationResult<Record<string, boolean>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Milestones must be an object.' };
  }
  const source = input as Record<string, unknown>;
  const update: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ONBOARDING_MILESTONE_KEYS.includes(key)) {
      return { ok: false, error: `Unknown milestone: ${key}` };
    }
    if (typeof value !== 'boolean') {
      return { ok: false, error: `Milestone ${key} must be true or false.` };
    }
    update[key] = value;
  }
  if (Object.keys(update).length === 0) {
    return { ok: false, error: 'No milestones provided.' };
  }
  return { ok: true, value: update };
}
