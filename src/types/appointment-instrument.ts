/**
 * Appointment instruments (Phase 3 Workstream G, spec G.3).
 *
 * One document per appointment in `appointment_instruments/{id}`,
 * created server-side only by the letter-issue action. The letter of
 * record is reproducible from `letter.snapshot` alone; provenance fields
 * are copied once from the Phase 1 register record (D-G2) and never
 * overwritten. Ratification fields are READ-ONLY MIRRORS of the Phase 2
 * lifecycle state (D-G5): on any disagreement the lifecycle record wins.
 */

import type { Timestamp } from 'firebase/firestore';

export type RatificationState =
  | 'not_required'
  | 'pending_ratification'
  | 'ratified'
  | 'deemed_ratified'
  | 'refused';

export type AcceptanceStatus =
  | 'awaiting_upload'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'waived';

/** Every value printed on the letter, frozen at issue time (G.3.2). */
export interface LetterSnapshot {
  instrumentNumber: string;
  verificationCode: string;
  appointeeName: string;
  roleKey: string;
  roleDisplayName: string;
  chapterId: string | null;
  chapterName: string | null;
  appointedByName: string;
  appointedByOffice: string;
  authorityReference: string;
  appointedAtIso: string;
  effectiveFromIso: string;
  termEndsAtIso: string | null;
  /** Issue date of THIS letter (not part of the content hash, G.5.3). */
  issuedAtIso: string;
  ratificationRequired: boolean;
  /** Role Catalog pointer for the duties line, from taxonomy data. */
  catalogReference: string | null;
  /** Q-G5: registration status wording; never claims registration. */
  registrationStatusLine: string;
  /**
   * Banner printed on the PDF of record when the letter is not the
   * current clean original (superseded / refused wording set by the
   * download route from live instrument state). Null on a clean letter.
   */
  statusLine: string | null;
}

export interface LetterBlock {
  status: 'issued' | 'superseded';
  generatedAt: Timestamp;
  generatedByUid: string;
  templateVersion: string;
  verificationCode: string;
  contentHash: string;
  snapshot: LetterSnapshot;
  driveFileId: string | null;
  driveWebViewLink: string | null;
  fileName: string | null;
  sizeBytes: number | null;
}

export interface AcceptanceBlock {
  status: AcceptanceStatus;
  driveFileId?: string;
  driveWebViewLink?: string;
  fileName?: string;
  sizeBytes?: number;
  contentType?: string;
  /** SHA-256 of the file bytes, computed server-side at upload (G.4.2). */
  fileHash?: string;
  uploadedAt?: Timestamp;
  uploadedByUid?: string;
  checkedByUid?: string;
  checkedAt?: Timestamp;
  checkNote?: string;
  letterVerificationCodeSeen?: string;
  waiverDecisionId?: string;
}

export interface AppointmentInstrument {
  id: string;
  roleHistoryId: string;
  positionId: string | null;
  appointeeUid: string;
  appointeeDisplayName: string;
  roleKey: string;
  roleDisplayName: string;
  chapterId: string | null;
  category: string;
  appointedByUid: string;
  appointedByDisplayName: string;
  appointedByOffice: string;
  authorityReference: string;
  appointedAt: Timestamp;
  effectiveFrom: Timestamp;
  backdateReason: string | null;
  termEndsAt: Timestamp | null;
  ratificationRequired: boolean;
  ratificationState: RatificationState;
  ratificationDeadline: Timestamp | null;
  ratificationDecisionId: string | null;
  letter: LetterBlock | null;
  acceptance: AcceptanceBlock;
  supersededByInstrumentId: string | null;
  supersedesInstrumentId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdByUid: string;
}

/**
 * Register record as consumed from Phase 1 (D-G2/D-G3), normalized by
 * the register adapter. All instants are epoch ms at this boundary.
 */
export interface RegisterRecord {
  roleHistoryId: string;
  positionId: string | null;
  appointeeUid: string;
  appointeeDisplayName: string | null;
  roleKey: string;
  chapterId: string | null;
  chapterName: string | null;
  appointedByUid: string | null;
  appointedByDisplayName: string | null;
  appointedByOffice: string | null;
  authorityReference: string | null;
  appointedAtMs: number;
  effectiveFromMs: number;
  backdateReason: string | null;
}

/** Role taxonomy entry as consumed from Phase 1 (D-G4). */
export interface RoleTaxonomyEntry {
  roleKey: string;
  displayName: string;
  /** A Governor, B national officer, C chapter officer, D team/other. */
  category: string;
  /** The office that appoints this role (catalog "Appointed by" column). */
  appointedByOffice: string | null;
  authorityReference: string | null;
  ratificationRequired: boolean;
  /** Role Catalog pointer printed as the duties line, when present. */
  catalogReference: string | null;
  /** Fixed-term offices only; null for at-pleasure offices. */
  termEndsAtMs: number | null;
}

/** Lifecycle read model consumed from Phase 2 (D-G5) via the adapter. */
export interface LifecycleState {
  state: RatificationState;
  deadlineMs: number | null;
  decisionId: string | null;
}

/** Renderer input for the appointment letter (G.5.2). */
export interface AppointmentLetterData {
  instrumentNumber: string;
  verificationCode: string;
  verificationUrl: string;
  contentHashShort: string;
  issuedDateLine: string;
  appointeeName: string;
  roleDisplayName: string;
  chapterName: string | null;
  appointedByName: string;
  appointedByOffice: string;
  authorityReference: string;
  effectiveFromLine: string;
  termEndsAtLine: string | null;
  catalogReference: string | null;
  ratificationRequired: boolean;
  registrationStatusLine: string;
  statusLine: string | null;
}
