/**
 * Phase 3 Elections suite + AGM types.
 *
 * Spec: bylaws_incorporation/implementation/fragments/elections_partB.md
 * (Workstream B - Elections Suite and AGM, Sections 3.1 to 3.6).
 *
 * Elections exist ONLY for Governor seats: v1 is the Member Governor
 * election (kind "member_governor", seatCategory "member_elected",
 * 2 seats). The election object rejects any office value that is not a
 * Governor seat. No elections for National President or any national
 * officer (Constitution 10.4, 15.1) - those are appointed, never elected.
 */

/** Structural stand-in satisfied by both admin and fake Timestamps. */
export interface FsTimestamp {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
}

/** v1 union: the only election kind that exists. */
export type ElectionKind = "member_governor";

/** Seat categories an election may fill. v1: member-elected Governors only. */
export type ElectionSeatCategory = "member_elected";

export const ELECTION_KIND: ElectionKind = "member_governor";
export const ELECTION_SEAT_CATEGORY: ElectionSeatCategory = "member_elected";
/** The 2 Member Governor seats filled by a v1 election. */
export const MEMBER_GOVERNOR_SEATS = 2;

export type ElectionStatus =
  | "draft"
  | "timetable_published"
  | "nominations_open"
  | "nominations_closed"
  | "candidates_certified"
  | "poll_open"
  | "poll_closed"
  | "counting"
  | "counted"
  | "tie_pending"
  | "declared"
  | "challenge_window"
  | "closed"
  | "cancelled";

/** Timetable map stored on the election doc (spec Section 3.2). */
export interface ElectionTimetable {
  electionDay: FsTimestamp;
  timetablePublishedAt: FsTimestamp | null;
  /** Recorded when publication happens after the T-30 deadline. */
  timetableLateReason: string | null;
  nominationOpenAt: FsTimestamp;
  nominationCloseAt: FsTimestamp;
  vettingDeadlineAt: FsTimestamp;
  /** Promised certified-list publication date, stated in the timetable. */
  candidateListDate: FsTimestamp;
  candidateListPublishedAt: FsTimestamp | null;
  pollOpenAt: FsTimestamp;
  pollCloseAt: FsTimestamp;
  challengeWindowClosesAt: FsTimestamp | null;
  certificateDeadlineAt: FsTimestamp | null;
}

export type VoterRollStatus = "not_built" | "built" | "frozen";

export interface VoterRollMeta {
  status: VoterRollStatus;
  builtAt: FsTimestamp | null;
  frozenAt: FsTimestamp | null;
  rollSize: number;
  /** SHA-256 over the sorted roll entry ids and snapshot fields. */
  rollHash: string;
}

export interface ElectionCounters {
  ballotsCast: number;
  markersCast: number;
  tokensRedeemed: number;
}

export interface ElectionComplianceObligations {
  timetable: string;
  agmNotice: string | null;
  agm: string | null;
  certificate: string;
  registrarFiling: string;
}

/** elections/{electionId} (spec Section 3.1). */
export interface Election {
  id: string;
  title: string;
  kind: ElectionKind;
  seatCategory: ElectionSeatCategory;
  seats: number;
  /** Phase 2 Board module seat identifiers the result will fill. */
  governorSeatIds: string[];
  status: ElectionStatus;
  returningOfficerUid: string;
  returningOfficerName: string;
  /** Must be the Founder; checked at create (Decision Rights row 5.25). */
  appointedByUid: string;
  appointedAt: FsTimestamp;
  /** Set at declaration; the recorded end of the RO term (Sec 01 C11). */
  roTermEndsAt: FsTimestamp | null;
  timetable: ElectionTimetable;
  voterRoll: VoterRollMeta;
  campaignCodeUrl: string | null;
  campaignCodeDriveFileId: string | null;
  complianceObligationIds: ElectionComplianceObligations;
  meetingId: string | null;
  agmId: string | null;
  counters: ElectionCounters;
  createdByUid: string;
  createdAt: FsTimestamp;
  updatedAt: FsTimestamp;
  cancelledReason: string | null;
}

/** elections/{electionId}/voter_roll/{uid} (spec Section 3.3). */
export interface VoterRollEntry {
  uid: string;
  displayName: string;
  chapterId: string | null;
  membershipClassAtFreeze: string;
  fullMemberSince: FsTimestamp | null;
  duesYear: string;
  registerEntryDate: FsTimestamp | null;
  eligibleToVote: boolean;
  exclusionReason: string | null;
  frozenAt: FsTimestamp | null;
}

export interface NominationConsent {
  driveFileId: string;
  driveLink: string;
  fileName: string;
  sha256: string;
  uploadedAt: FsTimestamp;
  uploadedByUid: string;
}

export interface NominationEligibility {
  isFullMember: boolean;
  fullMemberSince: FsTimestamp | null;
  sixMonthStandingMet: boolean;
  activeStrikes: number | null;
  /** "port" when the Phase 2 discipline port answered; otherwise the RO
   *  attestation fallback applies and the check is marked manual, never
   *  silently passed. */
  strikesCheckSource: "port" | "ro_attestation";
  checkedAt: FsTimestamp;
}

export type NominationStatus =
  | "submitted"
  | "under_review"
  | "accepted"
  | "rejected"
  | "withdrawn";

/** elections/{electionId}/nominations/{nominationId} (spec Section 3.5). */
export interface Nomination {
  id: string;
  electionId: string;
  candidateUid: string;
  candidateName: string;
  /** Exactly 2, distinct, neither equal to candidateUid. */
  nominatorUids: string[];
  candidateStatement: string;
  consent: NominationConsent;
  campaignCodeAcceptedAt: FsTimestamp;
  eligibility: NominationEligibility;
  status: NominationStatus;
  roDecision: {
    decidedByUid: string;
    decidedAt: FsTimestamp;
    reason: string | null;
  } | null;
  certifiedAt: FsTimestamp | null;
  submittedAt: FsTimestamp;
}

export type ElectionOfficialRole = "teller" | "observer";

/** elections/{electionId}/officials/{uid} (spec Section 3.5). */
export interface ElectionOfficial {
  uid: string;
  name: string;
  officialRole: ElectionOfficialRole;
  appointedByUid: string;
  forCandidateUid: string | null;
  /** Must be false for tellers; enforced server-side. */
  isCandidate: boolean;
  appointedAt: FsTimestamp;
}

export interface CutoffTie {
  tiedCandidateUids: string[];
  votesEach: number;
  seatsContested: number;
}

export type CountRecordStatus = "open" | "tallied" | "tie_pending" | "signed_off";

/** elections/{electionId}/count_record/main (spec Section 3.5). */
export interface CountRecord {
  openedByUid: string;
  openedAt: FsTimestamp;
  tellerUids: string[];
  ballotsCounted: number;
  blankBallots: number;
  invalidBallots: number;
  tallies: Record<string, number>;
  turnout: {
    rollSize: number;
    ballotsCast: number;
    markersCast: number;
    tokensRedeemed: number;
    reconciled: boolean;
  };
  cutoffTie: CutoffTie | null;
  signedOffBy: {
    roUid: string | null;
    roAt: FsTimestamp | null;
    tellerUids: string[];
    tellersAt: FsTimestamp | null;
  };
  /** Count end: the moment the final sign-off landed. Certificate
   *  deadline is this plus 24 hours (Sec 7.9). */
  signedOffAt: FsTimestamp | null;
  status: CountRecordStatus;
}

export interface TieLotWitness {
  uid: string | null;
  name: string;
  capacity: "candidate" | "observer" | "teller" | "other";
  presenceConfirmed: boolean;
}

/**
 * elections/{electionId}/tie_lots/{lotId} (spec Section 3.5).
 * The draw itself happens offline (Sec 7.8) in the presence of the tied
 * candidates or their observers. The system RECORDS the event; it never
 * generates the draw. An unrecorded draw has no effect.
 */
export interface TieLotRecord {
  id: string;
  electionId: string;
  reason: string;
  tiedCandidateUids: string[];
  votesEach: number;
  /** Free text recorded by the RO before the draw outcome is entered. */
  method: string;
  drawnByUid: string;
  drawnAt: FsTimestamp;
  witnesses: TieLotWitness[];
  outcomeWinningCandidateUid: string;
  evidence: { driveFileId: string; driveLink: string; sha256: string } | null;
  recordedByUid: string;
  recordedAt: FsTimestamp;
}

export interface ElectedGovernor {
  candidateUid: string;
  name: string;
  votes: number;
  seatCategory: ElectionSeatCategory;
  termStart: FsTimestamp;
  termEnd: FsTimestamp | null;
}

/** elections/{electionId}/result/main (spec Section 3.5). */
export interface ElectionResult {
  declaredByUid: string;
  declaredAt: FsTimestamp;
  elected: ElectedGovernor[];
  totals: {
    tallies: Record<string, number>;
    ballotsCounted: number;
    blankBallots: number;
    invalidBallots: number;
  };
  tieLotId: string | null;
  certificate: {
    driveFileId: string;
    driveLink: string;
    sha256: string;
    issuedAt: FsTimestamp;
    deliveredTo: string[];
    deliveryDeadlineAt: FsTimestamp;
  };
  governorRegisterWriteback: {
    status: "pending" | "written" | "failed";
    writtenAt: FsTimestamp | null;
    governorIds: string[];
    error: string | null;
  };
  lifecycleNotification: {
    status: "pending" | "sent" | "failed";
    sentAt: FsTimestamp | null;
  };
  decisionRecordId: string | null;
  registrarFilingObligationId: string;
  publishedAt: FsTimestamp;
}

export type ChallengeStatus = "filed" | "under_review" | "upheld" | "dismissed";

/** elections/{electionId}/challenges/{challengeId} (spec Section 3.5). */
export interface ElectionChallenge {
  id: string;
  electionId: string;
  challengerUid: string;
  grounds: string;
  filedAt: FsTimestamp;
  withinWindow: boolean;
  status: ChallengeStatus;
  roRuling: {
    ruledByUid: string;
    ruledAt: FsTimestamp;
    ruling: string;
    effectOnResult: "none" | "result_amended" | "election_voided";
  } | null;
}

/** Stored ballot doc (spec Section 3.4(c)). NO identity fields, ever. */
export interface BallotDoc {
  electionId: string;
  choices: string[];
  castDay: string;
  isBlank: boolean;
}

/** Cast marker doc (spec Section 3.4(b)). NO choice fields, ever. */
export interface CastMarkerDoc {
  electionId: string;
  castDay: string;
  pollWindow: string;
}

/** Eligibility token doc (spec Section 3.4(a)). NO uid, ever. */
export interface EligibilityTokenDoc {
  electionId: string;
  issuedAt: FsTimestamp;
  expiresAt: FsTimestamp;
  redeemedAt: FsTimestamp | null;
  redeemedDay: string | null;
}

// ---------------------------------------------------------------------------
// AGM (spec Section 3.6, fallback agm_events shape)
// ---------------------------------------------------------------------------

export type AgmStatus =
  | "draft"
  | "notice_due"
  | "notice_issued"
  | "held"
  | "minutes_draft"
  | "minutes_approved"
  | "closed"
  | "cancelled";

export type AgmAgendaItemKind =
  | "standard"
  | "accounts"
  | "audit_report"
  | "governor_election"
  | "dissolution"
  | "other";

export interface AgmAgendaItem {
  order: number;
  title: string;
  kind: AgmAgendaItemKind;
  electionId: string | null;
  documentIds: string[];
}

/** agm_events/{agmId} (spec Section 3.6). */
export interface AgmRecord {
  id: string;
  year: number;
  title: string;
  meetingId: string | null;
  scheduledAt: FsTimestamp;
  locationOrLink: string;
  convenedByRole: "national_general_secretary";
  status: AgmStatus;
  agenda: AgmAgendaItem[];
  agendaFinalised: boolean;
  /** True when Member Governor seats are due for this AGM cycle. */
  seatsDue: boolean;
  electionId: string | null;
  quorum: {
    basis: "full_members";
    rollSize: number;
    /** 20 percent of Full Members, rounded up (Constitution 10.6). */
    quorumRequired: number;
    presentCount: number | null;
    verifiedAt: FsTimestamp | null;
    verifiedByUid: string | null;
  };
  accountsDocumentId: string | null;
  auditReportDocumentId: string | null;
  auditorAppointmentId: string | null;
  minutesRef: {
    meetingMinutesId: string | null;
    driveFileId: string | null;
    status: string;
  } | null;
  complianceObligationIds: { notice: string; agm: string };
  createdByUid: string;
  createdAt: FsTimestamp;
  updatedAt: FsTimestamp;
}

/** agm_events/{agmId}/notices/{noticeId} (spec Section 3.6). */
export interface AgmNotice {
  id: string;
  agmId: string;
  issuedByUid: string;
  issuedAt: FsTimestamp;
  noticeDate: FsTimestamp;
  recipientSet: {
    source: "frozen_full_member_roll";
    rollReference: string;
    recipientCount: number;
    recipientUidsHash: string;
  };
  agendaSnapshot: AgmAgendaItem[];
  documentIds: string[];
  dispatch: {
    channel: "notification_service";
    startedAt: FsTimestamp;
    completedAt: FsTimestamp | null;
  };
}

export interface AgmNoticeRecipient {
  uid: string;
  displayName: string;
  inAppNotificationId: string | null;
  deliveryStatus: {
    inApp: "created" | "failed";
    email: "sent" | "failed" | "skipped";
    push: "sent" | "failed" | "skipped";
  };
  servedAt: FsTimestamp | null;
}

export type AgmDocumentKind =
  | "audited_accounts"
  | "audit_report"
  | "agenda"
  | "notice"
  | "minutes"
  | "other";

/** agm_documents/{documentId} (spec Section 3.6). */
export interface AgmDocument {
  id: string;
  agmId: string;
  kind: AgmDocumentKind;
  title: string;
  driveFileId: string;
  driveLink: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  sourceModule: "workstream_c_finance" | "manual_upload";
  /** True for audited_accounts and audit_report; enforced in API + rules. */
  fullMembersOnly: boolean;
  uploadedByUid: string;
  uploadedAt: FsTimestamp;
  publishedAt: FsTimestamp | null;
}

/** auditor_appointments/{appointmentId} (spec Section 3.6). */
export interface AuditorAppointment {
  id: string;
  financialYear: string;
  firmName: string;
  auditorName: string;
  appointedBy: "board" | "founder_fallback";
  appointedAt: FsTimestamp;
  boardDecisionRef: string | null;
  /** Required when appointedBy is founder_fallback (Constitution 13.13). */
  founderFallbackReason: string | null;
  engagementLetter: {
    driveFileId: string;
    driveLink: string;
    sha256: string;
  } | null;
  status:
    | "appointed"
    | "engagement_signed"
    | "fieldwork_done"
    | "report_delivered"
    | "replaced";
}
