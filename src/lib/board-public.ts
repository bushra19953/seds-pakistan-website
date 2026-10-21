/**
 * Public Board projection (Phase 2, spec C.3/C.4).
 *
 * ALLOW-LIST ONLY: toPublicSeat constructs the public object field by field
 * from exactly the specced fields and NEVER spreads the seat document. Only
 * effectively seated seats are returned at all. Contact details, consent /
 * vote / election internals, removal records, notes, and bookkeeping fields
 * never leave the server; a recursive key-scan test pins the forbidden set.
 */

import {
  CATEGORY_LABELS,
  effectiveStatus,
  toJsDate,
  type GovernorSeat,
} from '@/lib/governors';

export interface PublicSeat {
  seatKey: string;
  seatCategory: string;
  categoryLabel: string;
  holderName: string | null;
  termStart: string | null;
  termEnd: string | null;
  isFounderSeat: boolean;
}

export const PUBLIC_BOARD_FORBIDDEN_KEYS: readonly string[] = [
  'holderEmail',
  'holderUid',
  'holderExternalId',
  'consentRequestId',
  'voteRecordId',
  'electionResult',
  'removalRecord',
  'vacateRecord',
  'notes',
  'appointedBy',
  'appointedByName',
  'version',
  'termAlertStage',
  'lastHolderName',
  'lastHolderUid',
  'appointmentBasis',
  'appointmentRecordRef',
  'holderRoleKey',
  'publicBio',
  'photoUrl',
];

function isoOrNull(value: unknown): string | null {
  const d = toJsDate(value);
  return d ? d.toISOString() : null;
}

/** Returns the public projection, or null when the seat is not seated. */
export function toPublicSeat(seat: GovernorSeat, now: Date): PublicSeat | null {
  if (effectiveStatus(seat, now) !== 'seated') return null;
  return {
    seatKey: seat.seatKey,
    seatCategory: seat.category,
    categoryLabel: CATEGORY_LABELS[seat.category],
    holderName: seat.holderName,
    termStart: isoOrNull(seat.termStart),
    termEnd: isoOrNull(seat.termEnd),
    isFounderSeat: seat.seatKey === 'seat_founder',
  };
}
