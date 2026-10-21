/**
 * Board of Governors register - shared schema and pure logic
 * (Phase 2, Workstream C - spec Section C.1/C.2).
 *
 * The register is exactly nine seat documents in the `governors` collection,
 * one per seat, created only by the seed - never by the UI and never
 * deletable through any interface. History is an append-only subcollection
 * (governors/{seatKey}/history). Founder identity is a UID equality check
 * everywhere in this workstream, never a role check.
 *
 * Term model (spec C.1): termEnd is an EXCLUSIVE expiry instant - a seat is
 * term_expired when now >= termEnd. Founder-Appointed seats carry NO fixed
 * term (Constitution Art. 5; tenure ends on Founder removal), so their
 * termEnd is null and they never derive term_expired.
 */

export const GOVERNORS_COLLECTION = 'governors';
export const GOVERNOR_HISTORY_SUBCOLLECTION = 'history';

export type SeatKey =
  | 'seat_founder'
  | 'seat_fa_1'
  | 'seat_fa_2'
  | 'seat_fa_3'
  | 'seat_fa_4'
  | 'seat_co_1'
  | 'seat_co_2'
  | 'seat_me_1'
  | 'seat_me_2';

export type SeatCategory =
  | 'founder_ex_officio'
  | 'founder_appointed'
  | 'co_opted'
  | 'member_elected';

export const SEAT_KEYS: readonly SeatKey[] = [
  'seat_founder',
  'seat_fa_1',
  'seat_fa_2',
  'seat_fa_3',
  'seat_fa_4',
  'seat_co_1',
  'seat_co_2',
  'seat_me_1',
  'seat_me_2',
];

export const SEAT_ORDER: Record<SeatKey, number> = {
  seat_founder: 1,
  seat_fa_1: 2,
  seat_fa_2: 3,
  seat_fa_3: 4,
  seat_fa_4: 5,
  seat_co_1: 6,
  seat_co_2: 7,
  seat_me_1: 8,
  seat_me_2: 9,
};

export const CATEGORY_LABELS: Record<SeatCategory, string> = {
  founder_ex_officio: 'Founder - ex officio',
  founder_appointed: 'Founder-Appointed Governor',
  co_opted: 'Co-opted Governor',
  member_elected: 'Member-Elected Governor',
};

export function seatCategory(seatKey: SeatKey): SeatCategory {
  if (seatKey === 'seat_founder') return 'founder_ex_officio';
  if (seatKey.startsWith('seat_fa_')) return 'founder_appointed';
  if (seatKey.startsWith('seat_co_')) return 'co_opted';
  return 'member_elected';
}

/** The Phase 1 role key a seated holder carries, by category (spec C.1). */
export function holderRoleKeyFor(seatKey: SeatKey): string {
  switch (seatCategory(seatKey)) {
    case 'founder_appointed':
      return 'governor_founder';
    case 'co_opted':
      return 'governor_coopted';
    case 'member_elected':
      return 'governor_member';
    default:
      return 'founder_patron';
  }
}

export type GovernorStoredStatus = 'seated' | 'vacant' | 'awaiting_election';
export type GovernorEffectiveStatus = GovernorStoredStatus | 'term_expired';

export type GovernorVacateReason =
  | 'resigned'
  | 'deceased'
  | 'incapacitated'
  | 'other'
  | 'term_expired'
  | 'removed';

export type TermAlertStage = 'none' | 't30_sent' | 't7_sent' | 'expired_sent';

export interface AppointmentRecordRef {
  kind: 'consent' | 'board_vote' | 'election_result' | 'ex_officio';
  id: string | null;
  label: string;
}

export interface ElectionResult {
  electionDate: string;
  returningOfficerName: string;
  returningOfficerUid?: string | null;
  electorateLabel?: string;
  eligibleVoterCount: number;
  ballotsCast: number;
  votesForHolder: number;
  nominatedByNames: string[];
  candidateConsentRef: string;
  tieBreakByLot?: boolean;
  tieBreakNote?: string | null;
  minutesRef?: string | null;
  declaredAt?: string | null;
  recordedByUid?: string;
  recordingNotes?: string | null;
}

export interface RemovalRecord {
  removedByUid: string | null;
  removedByRole: string | null;
  cause: string;
  causeDetail: string | null;
  noticeDate: string | null;
  replyRef: string | null;
  voteRecordId: string | null;
  effectiveAt: unknown;
  recordedByUid: string;
}

export interface GovernorSeat {
  seatKey: SeatKey;
  seatOrder: number;
  category: SeatCategory;
  status: GovernorStoredStatus;
  holderUid: string | null;
  holderName: string | null;
  holderEmail?: string | null;
  holderExternalId?: string | null;
  holderRoleKey: string | null;
  isExternal: boolean;
  publicBio?: string | null;
  photoUrl?: string | null;
  termStart: unknown;
  termEnd: unknown;
  termYears: number | null;
  isInitialStaggerTerm: boolean;
  seatedAt: unknown;
  vacatedAt: unknown;
  vacancySince: unknown;
  lastVacancyReason: string | null;
  lastHolderName?: string | null;
  lastHolderUid?: string | null;
  appointedBy: string | null;
  appointedByName?: string | null;
  appointmentRecordRef: AppointmentRecordRef | null;
  consentRequestId?: string | null;
  voteRecordId?: string | null;
  electionResult?: ElectionResult | null;
  removalRecord?: RemovalRecord | null;
  vacateRecord?: {
    reason: GovernorVacateReason | string;
    at: unknown;
    by: string;
    byName?: string | null;
    note?: string | null;
    recordRef?: string | null;
  } | null;
  notes?: string | null;
  termAlertStage: TermAlertStage;
  version: number;
  createdAt?: unknown;
  updatedAt?: unknown;
  updatedBy?: string | null;
}

export interface GovernorSeatView extends GovernorSeat {
  effectiveStatus: GovernorEffectiveStatus;
  daysToTermEnd: number | null;
  isStaggerSeed: boolean;
  vacancyDays: number | null;
}

/** Firestore Timestamp | Date | ISO string | null -> Date | null. */
export function toJsDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof v.toDate === 'function') {
      const d = v.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    const seconds = typeof v.seconds === 'number' ? v.seconds : v._seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000);
  }
  return null;
}

/** Adds whole calendar years on UTC fields; Feb 29 clamps to Feb 28. */
export function addCalendarYears(date: Date, years: number): Date {
  const result = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  result.setUTCFullYear(result.getUTCFullYear() + years);
  // Feb 29 rolls to Mar 1 in non-leap target years; clamp back to Feb 28.
  if (result.getUTCMonth() !== date.getUTCMonth()) {
    result.setUTCDate(0); // last day of the previous month (Feb 28)
  }
  return result;
}

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Calendar date in Asia/Karachi as a UTC-midnight Date (the term-math
 * convention, spec C.1): PKT is a fixed UTC+5 with no DST, so no Intl data
 * is required. Term ends are stored as 00:00 Asia/Karachi instants.
 */
export function karachiMidnight(date: Date): Date {
  const shifted = new Date(date.getTime() + KARACHI_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
}

/**
 * The single source of truth for expiry (spec C.2): read-time derivation.
 * termEnd is EXCLUSIVE: expired when now >= termEnd. The Founder seat and
 * termless (Founder-Appointed) seats never derive term_expired.
 */
export function effectiveStatus(seat: GovernorSeat, now: Date): GovernorEffectiveStatus {
  if (seat.status === 'awaiting_election') return 'awaiting_election';
  if (seat.status === 'vacant' || !seat.holderName) return 'vacant';
  if (seat.seatKey === 'seat_founder') return 'seated';
  const termEnd = toJsDate(seat.termEnd);
  if (termEnd && now.getTime() >= termEnd.getTime()) return 'term_expired';
  return 'seated';
}

export function toSeatView(seat: GovernorSeat, now: Date): GovernorSeatView {
  const eff = effectiveStatus(seat, now);
  const termEnd = toJsDate(seat.termEnd);
  const vacancySince = toJsDate(seat.vacancySince);
  return {
    ...seat,
    effectiveStatus: eff,
    daysToTermEnd:
      eff === 'seated' && termEnd
        ? Math.ceil((termEnd.getTime() - now.getTime()) / 86400000)
        : null,
    isStaggerSeed: seat.isInitialStaggerTerm === true,
    vacancyDays:
      eff !== 'seated' && vacancySince
        ? Math.max(0, Math.floor((now.getTime() - vacancySince.getTime()) / 86400000))
        : null,
  };
}

/** Strict majority of the Governors seated when the vote opened (C.2). */
export function requiredVotes(seatedAtOpen: number): number {
  return Math.floor(seatedAtOpen / 2) + 1;
}

/**
 * Seed term years for the FIRST seating of each staggered seat (spec C.1):
 * seat_co_1 = 1, seat_me_1 = 2, seat_co_2 = 3, seat_me_2 = 3, so no year
 * carries more than two termed expiries. Later seatings are always 3 years
 * and the stagger self-perpetuates. Founder-Appointed seats have no term.
 */
export const STAGGER_SEED_YEARS: Partial<Record<SeatKey, number>> = {
  seat_co_1: 1,
  seat_me_1: 2,
  seat_co_2: 3,
  seat_me_2: 3,
};

export const STANDARD_TERM_YEARS = 3;

export function seedTermYears(
  seatKey: SeatKey,
  everSeated: boolean,
): { years: number | null; isStagger: boolean } {
  const category = seatCategory(seatKey);
  if (category === 'founder_ex_officio' || category === 'founder_appointed') {
    return { years: null, isStagger: false };
  }
  if (!everSeated && seatKey in STAGGER_SEED_YEARS) {
    return { years: STAGGER_SEED_YEARS[seatKey] as number, isStagger: true };
  }
  return { years: STANDARD_TERM_YEARS, isStagger: false };
}
