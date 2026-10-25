/**
 * Events cluster seam — TICKETS + VERIFY (Supabase migration, implementer E3).
 *
 * One seam module for the ticket surfaces:
 *   - POST /api/v1/tickets/issue   (src/app/api/v1/tickets/issue/route.ts)
 *   - GET  /verify/ticket/[ticketId] (src/app/verify/ticket/[ticketId]/page.tsx)
 *   - /events/ticket/[ticketId]    (client page — NOT served by this seam;
 *     it reads through the client Firestore SDK and stays on Firestore in
 *     this pass. See MANUAL_LIST.md, entry E3-CLIENT-1, and the H-04 note.)
 *
 * Rules for this pass (NEVER-BULK):
 * - The route's NON-transactional reads may serve from Supabase when
 *   `useSupa('tickets')` is on AND a Supabase client is configured, via the
 *   shared adapter in `@/lib/supa` (fs_* jsonb landing tables:
 *   eventTickets -> fs_eventTickets, events -> fs_events, registrations ->
 *   fs_group_registrations with parent_path='events/<eventId>').
 *   Any adapter failure falls back to Firestore for that read.
 * - BOTH Firestore transactions stay on Firestore under BOTH flag states:
 *     1. the sequential ticket-number counter transaction, and
 *     2. the atomic issuance transaction (ticket doc + registration stamp +
 *        event counter + user eventsAttended, in one runTransaction).
 *   Their Postgres equivalents are manual work, documented in
 *   ~/workspace/supabase-migration/events-cluster/MANUAL_LIST.md
 *   (entries E3-TX-1 and E3-TX-2). Do NOT bulk-move them to the adapter:
 *   the adapter has no multi-document transaction primitive.
 *
 * H-04 — PRESERVED, DO NOT "FIX": the verify page looks a ticket up BY
 * DOCUMENT ID while the client ticket page looks it up BY THE `ticketId`
 * FIELD, and issuance writes the doc under a deterministic id
 * (`<eventId>_<uid>`) with the readable id only in the `ticketId` field.
 * The two lookups therefore resolve different ticket generations. Every
 * read in this seam reproduces its surface's original lookup key exactly.
 * Full note with file:line evidence: MANUAL_LIST.md, entry H-04.
 *
 * Timestamp normalization: Firestore Timestamps land in jsonb in serialized
 * form ({ _seconds, _nanoseconds } from the migration dump, or ISO strings).
 * Consumers of ticket docs (the verify page's safeDate/safeIssuedDate) read
 * `ts._seconds`. `normalizeTimestampLike` converts every representation the
 * seam can meet into a plain `{ _seconds, _nanoseconds, seconds,
 * nanoseconds }` object so rendering is byte-identical on both backends.
 */

import admin from 'firebase-admin';
import { getSupaAdapter, getSupaClient, useSupa, type SupaDoc } from '@/lib/supa';
import { notificationService } from '@/lib/server/notification-service';

/* ------------------------------------------------------------------ types */

type FirestoreDb = FirebaseFirestore.Firestore;

/** Minimal snapshot shape the migrated call sites consume. */
export interface DocSnapLike {
  exists: boolean;
  id: string;
  data: () => Record<string, any> | undefined;
}

export interface QuerySnapLike {
  empty: boolean;
  docs: Array<{ id: string; data: () => Record<string, any> }>;
}

/* ------------------------------------------------------- flag / fallback */

export const TICKETS_SUPA_SURFACE = 'tickets';

/** True only when the flag is on AND a Supabase client is configured. */
export function ticketsSupaEnabled(): boolean {
  try {
    return useSupa(TICKETS_SUPA_SURFACE) && getSupaClient() !== null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------- timestamp normalization */

/**
 * Convert any stored timestamp representation into the plain shape the
 * verify/ticket renderers already understand:
 *   { _seconds, _nanoseconds, seconds, nanoseconds }
 * Handles: Firestore Timestamp instances (toDate()/seconds), the jsonb
 * serialized form ({ _seconds, _nanoseconds } or { seconds, nanoseconds }),
 * ISO strings, Dates, and epoch-millis numbers. Anything else (including
 * null/undefined) is returned unchanged.
 */
export function normalizeTimestampLike(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (value instanceof Date) {
    const millis = value.getTime();
    if (Number.isNaN(millis)) return value;
    return secondsShape(Math.floor(millis / 1000), (millis % 1000) * 1_000_000);
  }

  if (typeof value === 'string') {
    const millis = Date.parse(value);
    if (Number.isNaN(millis)) return value;
    return secondsShape(Math.floor(millis / 1000), (millis % 1000) * 1_000_000);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return secondsShape(Math.floor(value / 1000), (value % 1000) * 1_000_000);
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toDate === 'function') {
      try {
        return normalizeTimestampLike((v.toDate as () => Date)());
      } catch {
        return value;
      }
    }
    const secondsRaw =
      typeof v._seconds === 'number'
        ? v._seconds
        : typeof v.seconds === 'number'
          ? v.seconds
          : undefined;
    if (secondsRaw !== undefined) {
      const nanosRaw =
        typeof v._nanoseconds === 'number'
          ? v._nanoseconds
          : typeof v.nanoseconds === 'number'
            ? v.nanoseconds
            : 0;
      return secondsShape(secondsRaw, nanosRaw);
    }
  }

  return value;
}

function secondsShape(seconds: number, nanoseconds: number) {
  return { _seconds: seconds, _nanoseconds: nanoseconds, seconds, nanoseconds };
}

/** Ticket-doc fields that carry timestamps in the stored shape. */
export const TICKET_TIMESTAMP_FIELDS = ['eventDate', 'issuedAt', 'registrationDeadline'] as const;

/**
 * Return a copy of a ticket doc's data with its timestamp fields normalized.
 * Applied ONLY to adapter-sourced (jsonb) ticket data: the Firestore
 * fallback path returns genuine Firestore Timestamps untouched, exactly as
 * today (VERIFICATION_SPEC §3.4(c) — normalization is a property of the
 * adapter read, not a rewrite of the fallback shape).
 *
 * NORMALIZATION CONFLICT (coordinator to adjudicate, same conflict E1
 * recorded): VERIFICATION_SPEC §3.4(a) prescribes ISO-8601 strings on
 * adapter reads; the E3 tasking prescribes {seconds/_seconds-compatible}
 * shapes at this seam so the verify page's safeDate/safeIssuedDate
 * (which read `ts._seconds`) render unchanged without editing them.
 * E3 implemented the tasking. If the ruling goes the other way, the
 * change is confined to `normalizeTimestampLike` here plus re-pointing
 * the verify page's two helpers at the datetime oracle.
 */
export function normalizeTicketData<T extends Record<string, any>>(data: T): T {
  const out: Record<string, any> = { ...data };
  for (const field of TICKET_TIMESTAMP_FIELDS) {
    if (field in out) out[field] = normalizeTimestampLike(out[field]);
  }
  return out as T;
}

/* ------------------------------------------------------------ snap shapes */

function docSnap(id: string, data: Record<string, any> | undefined): DocSnapLike {
  return { exists: data !== undefined, id, data: () => data };
}

function querySnap(rows: SupaDoc[]): QuerySnapLike {
  const docs = rows.map((row) => {
    const { id, ...data } = row;
    return { id, data: () => data as Record<string, any> };
  });
  return { empty: docs.length === 0, docs };
}

/* ------------------------------------------------------------- issue reads */
/*
 * The issue route's parallel reads. Flag ON: adapter first, Firestore on any
 * adapter error. Flag OFF: Firestore only (the adapter is never touched).
 */

export async function getExistingTicketForIssue(
  db: FirestoreDb,
  eventId: string,
  uid: string,
): Promise<QuerySnapLike> {
  if (ticketsSupaEnabled()) {
    try {
      const rows = await getSupaAdapter().listDocs('eventTickets', {
        where: [
          ['eventId', '==', eventId],
          ['uid', '==', uid],
        ],
        limit: 1,
      });
      if (rows.length > 0) {
        return querySnap(
          rows.map((row) => ({ ...row, ...normalizeTicketData(row as Record<string, any>) })),
        );
      }
      return querySnap([]);
    } catch (err) {
      console.error('[supa-events/tickets] adapter existing-ticket read failed; falling back to Firestore:', err);
    }
  }
  const snap = await db
    .collection('eventTickets')
    .where('eventId', '==', eventId)
    .where('uid', '==', uid)
    .limit(1)
    .get();
  return {
    empty: snap.empty,
    docs: snap.docs.map((d) => ({
      id: d.id,
      data: () => d.data() as Record<string, any>,
    })),
  };
}

export async function getEventForIssue(
  db: FirestoreDb,
  eventId: string,
): Promise<DocSnapLike> {
  if (ticketsSupaEnabled()) {
    try {
      const row = await getSupaAdapter().getDoc('events', eventId);
      if (row) {
        const { id: _id, ...data } = row;
        void _id;
        return docSnap(eventId, data as Record<string, any>);
      }
      return docSnap(eventId, undefined);
    } catch (err) {
      console.error('[supa-events/tickets] adapter event read failed; falling back to Firestore:', err);
    }
  }
  const snap = await db.collection('events').doc(eventId).get();
  return docSnap(snap.id, snap.exists ? (snap.data() as Record<string, any>) : undefined);
}

export async function getRegistrationForIssue(
  db: FirestoreDb,
  eventId: string,
  registrationDocId: string,
): Promise<DocSnapLike> {
  if (ticketsSupaEnabled()) {
    try {
      // Adapter resolves the 3-segment path to fs_group_registrations
      // scoped by parent_path='events/<eventId>' — the migration kit's
      // landing shape for events/{id}/registrations docs.
      const row = await getSupaAdapter().getDoc(
        `events/${eventId}/registrations`,
        registrationDocId,
      );
      if (row) {
        const { id: _id, ...data } = row;
        void _id;
        return docSnap(registrationDocId, data as Record<string, any>);
      }
      return docSnap(registrationDocId, undefined);
    } catch (err) {
      console.error('[supa-events/tickets] adapter registration read failed; falling back to Firestore:', err);
    }
  }
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection('registrations')
    .doc(registrationDocId)
    .get();
  return docSnap(snap.id, snap.exists ? (snap.data() as Record<string, any>) : undefined);
}

/* ------------------------------------------------------------ verify read */

/**
 * Verify-page read: BY DOCUMENT ID, exactly as the page has always done
 * (H-04: issuance writes current tickets under `<eventId>_<uid>`, so a
 * doc-id lookup by the readable EVT- id only resolves legacy tickets whose
 * doc id IS the readable id. That divergence is preserved, not repaired.)
 *
 * Returns the ticket data with timestamps normalized, or null when the doc
 * does not exist. Throws only when NO backend can serve the read, matching
 * the page's "Unable to verify ticket at this time" arm.
 */
export async function getTicketByDocIdForVerify(
  db: FirestoreDb,
  ticketId: string,
): Promise<Record<string, any> | null> {
  if (ticketsSupaEnabled()) {
    try {
      const row = await getSupaAdapter().getDoc('eventTickets', ticketId);
      if (!row) return null;
      const { id: _id, ...data } = row;
      void _id;
      return normalizeTicketData(data as Record<string, any>);
    } catch (err) {
      console.error('[supa-events/tickets] adapter verify read failed; falling back to Firestore:', err);
    }
  }
  const snap = await db.collection('eventTickets').doc(ticketId).get();
  if (!snap.exists) return null;
  // Firestore arm: data returned untouched (genuine Timestamps, §3.4(c)).
  return snap.data() as Record<string, any>;
}

/* ------------------------------------------------- Firestore transactions */
/*
 * NEVER-BULK: both transactions below stay on Firestore under BOTH flag
 * states in this pass. Postgres equivalents: MANUAL_LIST.md E3-TX-1/E3-TX-2.
 */

/**
 * Sequential ticket number: reads events/{eventId}.ticketCount and writes
 * back +1 inside a Firestore transaction. (Formerly a helper in the issue
 * route; the issuance transaction below inlines the same counter step —
 * both are isolated here so the counter logic has exactly one home.)
 */
export async function allocateNextTicketNumber(
  db: FirestoreDb,
  eventId: string,
): Promise<number> {
  const counterRef = db.collection('events').doc(eventId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const current = (snap.data()?.ticketCount as number) || 0;
    const next = current + 1;
    tx.update(counterRef, { ticketCount: next });
    return next;
  });
  return result;
}

export interface IssueTicketAtomicallyInput {
  eventId: string;
  uid: string;
  /** registrations doc id to stamp (regId || uid, resolved by the route). */
  registrationDocId: string;
  siteUrl: string;
  finalRegData: Record<string, any>;
  userData: Record<string, any> | undefined;
  eventData: Record<string, any>;
  /** QR encoder injected by the route (the `qrcode` package lives there). */
  generateQrDataUrl: (text: string) => Promise<string>;
}

export interface IssueTicketAtomicallyResult {
  ticketId: string;
  ticketNumber: number;
  existing: boolean;
}

/**
 * Atomic ticket issuance (V15.0 — deterministic & transactional), moved
 * verbatim from the issue route. Writes, in ONE Firestore transaction:
 *   - eventTickets/{eventId}_{uid}   (doc id is the DETERMINISTIC id; the
 *     readable EVT- id lives in the doc's `ticketId` field — see H-04)
 *   - events/{eventId}               (ticketCount counter, sequential number)
 *   - events/{eventId}/registrations/{registrationDocId} (ticket stamp)
 *   - users/{uid}                    (eventsAttended arrayUnion, if absent)
 * Stays on Firestore under both flag states: the Supabase adapter offers no
 * multi-table transaction, and a partial move would break the atomicity
 * this transaction exists for. Postgres equivalent: MANUAL_LIST.md E3-TX-2.
 */
export async function issueTicketAtomically(
  db: FirestoreDb,
  input: IssueTicketAtomicallyInput,
): Promise<IssueTicketAtomicallyResult> {
  const { eventId, uid, siteUrl, finalRegData, userData, eventData } = input;

  const deterministicTicketId = `${eventId}_${uid}`;
  const ticketRef = db.collection('eventTickets').doc(deterministicTicketId);
  const regDocRef = db
    .collection('events')
    .doc(eventId)
    .collection('registrations')
    .doc(input.registrationDocId);
  const userRef = db.collection('users').doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const ticketSnap = await tx.get(ticketRef);

    // If ticket already exists, just return it (Prevents Duplication)
    if (ticketSnap.exists) {
      const existingData = ticketSnap.data()!;
      return {
        ticketId: existingData.ticketId || deterministicTicketId,
        ticketNumber: existingData.ticketNumber as number,
        existing: true,
      };
    }

    // Get next sequential number
    const eventCounterRef = db.collection('events').doc(eventId);
    const eventCounterSnap = await tx.get(eventCounterRef);
    const currentCount = (eventCounterSnap.data()?.ticketCount as number) || 0;
    const nextCount = currentCount + 1;
    tx.update(eventCounterRef, { ticketCount: nextCount });

    // Generate Readable Ticket ID (for display/QR)
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const eventShort = eventId.slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const seqPart = nextCount.toString().padStart(4, '0');
    const readableTicketId = `EVT-${eventShort}-${datePart}-${seqPart}`;

    const verificationUrl = `${siteUrl}/verify/ticket/${readableTicketId}`;

    // The QR must encode THIS ticket's verification URL, so it can
    // only be generated now that the real readable id exists (the
    // old code generated it before the transaction from a literal
    // PLACEHOLDER id). Regenerating on a transaction retry is safe:
    // the payload is a pure function of the id chosen in that attempt.
    const qrCodeDataUrl = await input.generateQrDataUrl(verificationUrl).catch(() => '');

    const ticketData = {
      ticketId: readableTicketId,
      dbId: deterministicTicketId,
      ticketNumber: nextCount,
      uid,
      eventId,
      displayName: finalRegData.displayName || userData?.displayName || 'Attendee',
      email: finalRegData.email || userData?.email || '',
      eventTitle: eventData.title || 'Event',
      eventDate: eventData.startAt || null,
      eventVenue: eventData.venue || eventData.location || 'TBD',
      issuedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'valid',
      qrCodeDataUrl,
      verificationUrl,
      uniqueTicketUrl: '',
      paymentMethod: finalRegData.paymentMethod || 'manual',
      paymentRef: finalRegData.transactionId || finalRegData.paymentRef || '',
      registrationId: uid,
    };

    tx.set(ticketRef, ticketData);
    tx.update(regDocRef, {
      ticketId: readableTicketId,
      ticketIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const eventsAttended = Array.isArray(userData?.eventsAttended) ? userData.eventsAttended : [];
    const isAlreadyInProfile = eventsAttended.some((e: any) => e.eventId === eventId);
    if (!isAlreadyInProfile) {
      tx.update(userRef, {
        eventsAttended: admin.firestore.FieldValue.arrayUnion({
          eventId,
          eventTitle: eventData.title || 'Event',
          ticketId: readableTicketId,
          uniqueTicketUrl: '',
          attendedAt: admin.firestore.Timestamp.fromDate(new Date()),
        }),
      });
    }

    // Production-Grade Unified Notification (P1: In-App + Push + Email)
    notificationService
      .send(
        uid,
        {
          type: 'ticket_issued',
          title: '🎟️ Your Ticket is Ready!',
          body: `Your ticket for "${eventData.title}" has been issued. Ticket #${nextCount}.`,
          link: '',
          metadata: {
            ticketId: readableTicketId,
            eventId,
          },
        },
        'P1',
      )
      .catch((err) => console.error('[tickets/issue] Notification failed:', err));

    return { ticketId: readableTicketId, ticketNumber: nextCount, existing: false };
  });

  return result;
}
