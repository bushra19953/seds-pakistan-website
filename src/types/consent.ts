import type { Timestamp } from 'firebase/firestore';

// Founder Consent request types (Phase 2, Workstream A).
// Stored in Firestore collection: consent_requests.
// Mirrors Exhibit A of the Reserved Powers Schedule (see
// ~/workspace/bylaws_incorporation/implementation/phase2_spec.md, Section A.4).
// proposedActDate is a YYYY-MM-DD string (leave-system convention);
// every other date field is a Firestore server Timestamp or null.

export type ConsentStatus =
  | 'draft'
  | 'pending'
  | 'further_information_requested'
  | 'consented'
  | 'refused'
  | 'conditional'
  | 'waived'
  | 'deemed_withheld'
  | 'executed'
  | 'cancelled';

// The Founder's decision on a request. deemed_withheld and waived are
// statuses, not decisions; a request in either status has decision null.
export type ConsentDecision =
  | 'consent_given'
  | 'consent_refused'
  | 'conditional_consent';

// hard_block: the gated act cannot proceed without a decided consent.
// record_only: the consent is recorded but does not block the act.
export type GateMode = 'hard_block' | 'record_only';

// Reference to a file held in Google Drive. References only: no bytes
// or base64 are ever stored on the consent document.
export interface ConsentAttachment {
  fileName: string;
  driveFileId: string;
  downloadUrl: string;
  sizeBytes: number;
  contentType: string;
  uploadedByUid: string;
  uploadedAt: Timestamp;
}

// One Reserved Matter from the Reserved Powers Schedule seed data
// (spec A.3). The canonical list lives in src/lib/consents/reserved-matters.ts.
export interface ReservedMatter {
  matterKey: string;
  scheduleSection: string;
  label: string;
  defaultGateMode: GateMode;
}

export interface ConsentRequest {
  id: string;
  // Human request number (FC-YYYY-NNNN), assigned at submission.
  // Drafts carry null so numbers have no gaps from abandoned drafts.
  requestNumber: string | null;
  status: ConsentStatus;
  // Server-set from the verified session, never client-supplied.
  requestedByUid: string;
  // Snapshot of users/{uid}.displayName at filing.
  requesterName: string;
  // Snapshot of the catalog role key, resolved server-side from roles/{uid}.
  requesterRoleKey: string;
  // Display/filter context only.
  requesterChapterId: string | null;
  matterKey: string;
  // Denormalised from the seed data, server-set from matterKey.
  scheduleSection: string;
  matterLabel: string;
  // Snapshot at submission, so a later gate-mode change does not rewrite history.
  gateModeAtFiling: GateMode;
  // "Proposed Act, stated in full". Min 20 chars at submission.
  proposedAct: string;
  proposedActDate: string;
  // Integer >= 0; null = not applicable; 0 is stored as 0.
  amountPkr: number | null;
  // Required at submission when matterKey is related_party_contract.
  relatedPartyName: string | null;
  relatedPartyInterest: string | null;
  // Min 20 chars at submission (Schedule s.4.3).
  materialFacts: string;
  attachments: ConsentAttachment[];
  isUrgent: boolean;
  // Required when isUrgent is true.
  urgencyReason: string | null;
  decision: ConsentDecision | null;
  // Required when decision is conditional_consent (conditions and/or scope).
  conditions: string | null;
  // Schedule s.4.5 partial consent scopes.
  consentedScope: string | null;
  refusedScope: string | null;
  decisionDate: Timestamp | null;
  // Founder UID, or the literal 'system_cron' for deemed_withheld.
  decidedByUid: string | null;
  // Format FOUNDER:<FOUNDER_UID>:<ISO ts>. A recorded attestation marker
  // tied to the authenticated Founder session, NOT a cryptographic signature.
  founderSignatureMarker: string | null;
  furtherInformationRequest: string | null;
  furtherInformationResponse: string | null;
  // Receipt moment the restarted 30-day clock runs from (s.4.4).
  informationReceivedAt: Timestamp | null;
  // Exhibit A "Date of request".
  submittedAt: Timestamp | null;
  // submittedAt + 30 calendar days, or informationReceivedAt + 30 days
  // after a further-information cycle.
  decisionDeadlineAt: Timestamp | null;
  // Cron T-7 idempotency stamp; reset to null whenever the clock restarts.
  deadlineWarningSentAt: Timestamp | null;
  deemedWithheldAt: Timestamp | null;
  // Required on the waive action.
  waiverNote: string | null;
  executedAt: Timestamp | null;
  executionNote: string | null;
  cancelledAt: Timestamp | null;
  cancellationReason: string | null;
  // The gate subject this consent covers (set on founder-act records;
  // the filing flow does not write it). See consent-gate subjectMatches.
  subjectRef?: Record<string, unknown> | null;
  // Provenance marker: 'founder-act' on records the gate auto-created
  // when the Founder performed a gated act (createFounderActConsent).
  decidedVia?: string | null;
  // Decision moment. The filing flow writes decisionDate/decidedAtSort;
  // founder-act records also write decidedAt, which the gate's expiry
  // logic reads.
  decidedAt?: Timestamp | null;
  // Server-maintained sort key set on every terminal decision event
  // (incl. deemed withheld and waiver) so register queries are clean.
  decidedAtSort: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
