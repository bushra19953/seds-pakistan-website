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
