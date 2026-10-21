/**
 * Board of Governors register - shared schema and pure logic
 * (Phase 2, Workstream C - spec Section C.1/C.2).
 *
 * The register is exactly nine seat documents in the `governors` collection,
 * one per seat, created only by code seed - never by the UI and never
 * deletable through any interface. Founder identity is a UID equality check
 * everywhere in this workstream, never a role check.
 */

export const GOVERNORS_COLLECTION = 'governors';
export const GOVERNORS_HISTORY_COLLECTION = 'governors_history';

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

export type SeatCategory = 'Founder' | 'Founder-Appointed' | 'Co-opted' | 'Member-Elected';

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

export const CATEGORY_LABELS: Record<SeatCategory, string> = {
  Founder: 'Founder Governor',
  'Founder-Appointed': 'Founder-Appointed Governor',
  'Co-opted': 'Co-opted Governor',
  'Member-Elected': 'Member Governor',
};

export function seatCategory(seatKey: SeatKey): SeatCategory {
  if (seatKey === 'seat_founder') return 'Founder';
  if (seatKey.startsWith('seat_fa_')) return 'Founder-Appointed';
  if (seatKey.startsWith('seat_co_')) return 'Co-opted';
  return 'Member-Elected';
}

export type GovernorSeatStatus = 'seated' | 'vacant';

export type GovernorVacateReason = 'resigned' | 'removed' | 'term_expired' | 'deceased' | 'other';

export interface GovernorSeat {
  seatKey: SeatKey;
  category: SeatCategory;
  status: GovernorSeatStatus;
  holderUid: string | null;
  holderName: string | null;
  holderEmail?: string | null;
  holderExternalId?: string | null;
  publicBio?: string | null;
  photoUrl?: string | null;
  seatedAt: unknown;
  termExpiresAt: unknown | null;
  appointmentBasis?: string | null;
  consentRequestId?: string | null;
  voteRecordId?: string | null;
  electionResult?: Record<string, unknown> | null;
  appointedBy: string | null;
  appointedByName?: string | null;
  notes?: string | null;
  termAlertStage: 0 | 1 | 2;
  version: number;
  lastHolderName?: string | null;
  lastHolderUid?: string | null;
  vacateRecord?: {
    reason: GovernorVacateReason | string;
    at: unknown;
    by: string;
    byName?: string | null;
    note?: string | null;
  } | null;
  /** Set when the last vacate was a Founder-recorded removal (spec C.2.2). */
  removalRecord?: {
    reason: string;
    at: unknown;
    by: string;
    byName?: string | null;
    note?: string | null;
  } | null;
}

export type GovernorStoredStatus = GovernorSeatStatus | 'term_expired';

export interface GovernorSeatView extends Omit<GovernorSeat, 'status'> {
  status: GovernorSeatStatus;
  storedStatus: GovernorStoredStatus;
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
  const targetYear = result.getUTCFullYear() + years;
  result.setUTCFullYear(targetYear);
  // Feb 29 rolls to Mar 1 in non-leap target years; clamp back to Feb 28.
  if (result.getUTCMonth() !== date.getUTCMonth()) {
    result.setUTCDate(0); // last day of the previous month (Feb 28/29)
  }
  return result;
}

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Calendar date in Asia/Karachi as a UTC-midnight Date (the term-math
 * convention, spec C.2.4): no Intl data required because PKT is a fixed
 * UTC+5 with no DST.
 */
export function karachiMidnight(date: Date): Date {
  const shifted = new Date(date.getTime() + KARACHI_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
}

export function effectiveStatus(
  seat: GovernorSeat,
  now: Date,
): { status: GovernorSeatStatus; storedStatus: GovernorStoredStatus } {
  // A seat is occupied iff it is marked seated AND names a holder. External
  // (account-less) Governors legitimately have holderUid null - the holder
  // NAME is the occupancy signal, never the UID.
  if (seat.status === 'vacant' || !seat.holderName) {
    return { status: 'vacant', storedStatus: 'vacant' };
  }
  if (seat.seatKey === 'seat_founder') {
    // The Founder seat never expires and is never vacated by the system.
    return { status: 'seated', storedStatus: 'seated' };
  }
  const expiry = toJsDate(seat.termExpiresAt);
  if (expiry && karachiMidnight(now).getTime() > karachiMidnight(expiry).getTime()) {
    return { status: 'vacant', storedStatus: 'term_expired' };
  }
  return { status: 'seated', storedStatus: 'seated' };
}

export function toSeatView(seat: GovernorSeat, now: Date): GovernorSeatView {
  const eff = effectiveStatus(seat, now);
  return { ...seat, status: eff.status, storedStatus: eff.storedStatus };
}

export type CooptionMethod = 'vote' | 'founder_quorum_lock';

export interface CooptionOpenState {
  seatedAtOpen: number;
  seatedSeatKeys: SeatKey[];
  method: CooptionMethod;
  requiredVotes: number | null;
}

/** Strict majority of the Governors seated when the vacancy opened (C.2.2). */
export function requiredCooptionVotes(seatedAtOpen: number): number {
  return Math.floor(seatedAtOpen / 2) + 1;
}

export function cooptionOpenState(
  seats: Array<GovernorSeat & { status: GovernorSeatStatus }>,
): CooptionOpenState {
  const seatedSeatKeys = seats.filter((s) => s.status === 'seated').map((s) => s.seatKey);
  const seatedAtOpen = seatedSeatKeys.length;
  if (seatedAtOpen === 1 && seatedSeatKeys[0] === 'seat_founder') {
    // Founder Quorum Lock: the Founder alone is the Board quorate.
    return { seatedAtOpen, seatedSeatKeys, method: 'founder_quorum_lock', requiredVotes: null };
  }
  return {
    seatedAtOpen,
    seatedSeatKeys,
    method: 'vote',
    requiredVotes: requiredCooptionVotes(seatedAtOpen),
  };
}

/**
 * Seed term years for the FIRST seating of each staggered seat (spec C.2.1).
 * Once a seat has ever been seated, every later seating is a standard
 * three-year term and this map no longer applies.
 */
export const STAGGER_SEED_YEARS: Partial<Record<SeatKey, number>> = {
  seat_co_1: 1,
  seat_me_1: 2,
  seat_co_2: 3,
  seat_me_2: 3,
};

export const STANDARD_TERM_YEARS = 3;

export function seedTermYears(seatKey: SeatKey, everSeated: boolean): number | null {
  if (seatKey === 'seat_founder') return null;
  if (seatKey.startsWith('seat_fa_')) return STANDARD_TERM_YEARS;
  if (!everSeated && seatKey in STAGGER_SEED_YEARS) {
    return STAGGER_SEED_YEARS[seatKey] as number;
  }
  return STANDARD_TERM_YEARS;
}
