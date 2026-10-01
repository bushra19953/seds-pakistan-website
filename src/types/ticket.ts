import type { Timestamp } from 'firebase/firestore';

// ─── EventTicket: stored in Firestore `eventTickets/{ticketId}` ───────────────
export interface EventTicket {
    ticketId: string;           // doc ID = "EVT-{EVENT_SHORT}-{YYYYMMDD}-{SEQ}"
    ticketNumber: number;       // sequential per event (1, 2, 3…)
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
