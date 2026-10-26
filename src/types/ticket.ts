import type { Timestamp } from 'firebase/firestore';

// ─── EventTicket: stored in Firestore `eventTickets/{docId}` ──────────────────
// Shape alignment note (Supabase migration, E3): as actually written by
// POST /api/v1/tickets/issue, the DOCUMENT id is the deterministic
// "{eventId}_{uid}" (mirrored in the `dbId` field); the readable
// "EVT-{EVENT_SHORT}-{YYYYMMDD}-{SEQ}" id lives in the `ticketId` FIELD.
// Legacy tickets predate that scheme and use the readable id AS the doc id.
// H-04 (fixed 2026-10-26, Issue Ticket defect wave): the verify page now
// resolves by the `ticketId` FIELD like the client ticket page's second
// strategy, with a guarded doc-id fallback for the legacy generation —
// the deterministic doc id is a storage key, not a ticket credential.
export interface EventTicket {
    ticketId: string;           // readable id FIELD = "EVT-{EVENT_SHORT}-{YYYYMMDD}-{SEQ}"
    dbId?: string;              // deterministic doc id "{eventId}_{uid}" (current issuance)
    ticketNumber: number;       // sequential per event (1, 2, 3…)
    registrationId?: string;    // uid of the registration the ticket was issued from
    uniqueTicketUrl?: string;   // hosted commemorative ticket image URL ('' when none)
    uid: string;                // owner Firebase UID
    displayName: string;        // snapshot of name at issuance
    email: string;
    eventId: string;
    eventTitle: string;
    eventDate: Timestamp | null;
    eventVenue: string;
    registrationDeadline: Timestamp | null;
    issuedAt: Timestamp;
    status: 'valid' | 'revoked';
    qrCodeDataUrl: string;      // base64 PNG — embedded in printed ticket
    verificationUrl: string;    // /verify/ticket/{ticketId}
    paymentMethod: string;
    paymentRef: string;         // transaction ID / order ID
}

// ─── Slim reference stored in users/{uid}.eventsAttended array ───────────────
export interface EventAttendedRef {
    eventId: string;
    eventTitle: string;
    ticketId: string;
    attendedAt: Timestamp;
}
