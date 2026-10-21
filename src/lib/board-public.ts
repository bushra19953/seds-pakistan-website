/**
 * Public Board projection (Phase 2, spec C.4).
 *
 * ALLOW-LIST ONLY: toPublicSeat constructs the public object field by field
 * and NEVER spreads the seat document. Contact details, consent/vote/
 * election internals, removal records, notes, and bookkeeping fields never
 * leave the server. A recursive key-scan test pins the forbidden set.
 */

import {
  CATEGORY_LABELS,
  SEAT_KEYS,
  effectiveStatus,
  toJsDate,
  type GovernorSeat,
  type SeatKey,
} from '@/lib/governors';

export interface PublicSeat {
  seatKey: SeatKey;
  category: string;
  categoryLabel: string;
  status: 'seated' | 'vacant';
  holderName: string | null;
  publicBio: string | null;
  photoUrl: string | null;
  seatedAt: string | null;
  termExpiresAt: string | null;
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
];

function isoOrNull(value: unknown): string | null {
  const d = toJsDate(value);
  return d ? d.toISOString() : null;
}

export function toPublicSeat(seat: GovernorSeat, now: Date): PublicSeat {
  const eff = effectiveStatus(seat, now);
  const seated = eff.status === 'seated';
  return {
    seatKey: seat.seatKey,
    category: seat.category,
    categoryLabel: CATEGORY_LABELS[seat.category],
    status: eff.status,
    holderName: seated ? seat.holderName : null,
    publicBio: seated ? (seat.publicBio ?? null) : null,
    photoUrl: seated ? (seat.photoUrl ?? null) : null,
    seatedAt: seated ? isoOrNull(seat.seatedAt) : null,
    termExpiresAt: seated ? isoOrNull(seat.termExpiresAt) : null,
  };
}

export function vacantPublicSeat(seatKey: SeatKey, category: GovernorSeat['category']): PublicSeat {
  return {
    seatKey,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    status: 'vacant',
    holderName: null,
    publicBio: null,
    photoUrl: null,
    seatedAt: null,
    termExpiresAt: null,
  };
}

export { SEAT_KEYS };
