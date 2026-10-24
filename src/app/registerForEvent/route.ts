import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';

/**
 * POST /registerForEvent — free (and seat-holding) event registration.
 *
 * This route replaces the decommissioned Cloud Functions callable handler
 * `handleRegisterForEvent` (functions/src/index.ts). The standalone
 * register page (src/app/events/register/page.tsx) has always POSTed to
 * the relative path /registerForEvent with a callable-shaped body
 * ({ data: { eventId, whatsappE164, paymentMethod } }) and a Bearer
 * token; when the Functions plane was decommissioned the path stopped
 * existing in the Next app, so Confirm Seat failed for every event
 * (audit EV-P01). The route lives at exactly the path the client calls,
 * and the request/response envelopes mirror the callable protocol the
 * client was built against: success is 200 { result: ... }; failures are
 * { error: { status, message } }, which is the shape the page reads
 * (errData?.error?.message). The client flow is unchanged.
 *
 * Semantics are a port of the old handler's transaction, with two of its
 * proven defects corrected rather than replicated (audit EV-P02):
 *  - The handler computed published-ness as
 *    `String(event?.status || event?.published ? 'published' : 'draft')`,
 *    an operator-precedence trap that read ANY truthy status (including
 *    "draft") as published. Here a post is published iff
 *    status === 'published' or the legacy published flag is true — the
 *    same test the register page and the detail page apply.
 *  - The handler required registrationOpen to be strictly true while
 *    the page treats a missing field as open. Here a missing field means
 *    open, matching the page (an explicit false closes registration).
 *
 * Counter ownership (audit EV-P06): this endpoint is the writer for the
 * three public counters. Inside the same transaction that creates the
 * registration it unions the uid into BOTH attendeeIds and
 * registered_attendees_uids and sets registrationsCount to the
 * resulting attendeeIds length, so the three agree by construction.
 * The admin attendees panel applies the same rule on confirm/cancel.
 */

class RegistrationError extends Error {
    constructor(
        public code: string,
        public httpStatus: number,
        message: string,
    ) {
        super(message);
    }
}

function fail(err: RegistrationError) {
    return NextResponse.json(
        { error: { status: err.code, message: err.message } },
        { status: err.httpStatus },
    );
}

export async function POST(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return fail(new RegistrationError('internal', 500, 'Firestore not initialized'));
        }

        // Auth: the callable dispatcher verified the Bearer ID token and
        // handed the handler a null auth when it was missing/invalid;
        // the handler then rejected unauthenticated. Same contract here.
        const authHeader = request.headers.get('authorization');
        let uid: string | null = null;
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.split('Bearer ')[1];
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                uid = decoded.uid;
            } catch {
                uid = null;
            }
        }
        if (!uid) {
            return fail(new RegistrationError('unauthenticated', 401, 'User must be signed in'));
        }

        // Discipline (spec E.4.8): event registration is a privilege; a
        // member under a Strike 2 suspension may not register. Same gate
        // as the paid route (app/api/event-registrations).
        {
            const { suspensionBlock } = await import('@/lib/server/discipline/suspension');
            const block = await suspensionBlock(db, uid, new Date());
            if (block) {
                return NextResponse.json(block, { status: 403 });
            }
        }

        const body = await request.json().catch(() => null);
        const data = (body && typeof body === 'object' ? (body as any).data ?? body : {}) as Record<string, any>;
        const eventId = typeof data?.eventId === 'string' ? data.eventId.trim() : '';
        if (!eventId) {
            return fail(new RegistrationError('invalid-argument', 400, 'eventId is required'));
        }

        const result = await db.runTransaction(async (tx) => {
            const eventRef = db.collection('events').doc(eventId);
            const regRef = eventRef.collection('registrations').doc(uid);
            const userRef = db.collection('users').doc(uid);
            const configRef = db.collection('warningConfig').doc('global');

            const [eventSnap, regSnap, userSnap, configSnap] = await Promise.all([
                tx.get(eventRef),
                tx.get(regRef),
                tx.get(userRef),
                tx.get(configRef),
            ]);

            if (!eventSnap.exists) {
                throw new RegistrationError('not-found', 404, 'Event not found');
            }
            const event = (eventSnap.data() || {}) as Record<string, any>;

            // A soft-deleted event is not registerable (the public
            // surfaces treat it as non-existent).
            if (event.deleted === true) {
                throw new RegistrationError('not-found', 404, 'Event not found');
            }

            // Enforcement: block blacklisted users while enforcement is
            // enabled (ported from the function handler; the flag lives
            // on the Firestore profile, not the Auth object).
            const userData = (userSnap.data() || {}) as Record<string, any>;
            const configData = configSnap.exists
                ? ((configSnap.data() || {}) as Record<string, any>)
                : { enforcementEnabled: true };
            if (configData.enforcementEnabled && userData.isBlacklisted === true) {
                throw new RegistrationError(
                    'permission-denied',
                    403,
                    'Your account is currently blacklisted. Event registration is restricted.',
                );
            }

            const isPublished = event.status === 'published' || event.published === true;
            const registrationOpen = (event.registrationOpen ?? true) === true;
            if (!isPublished || !registrationOpen) {
                throw new RegistrationError('failed-precondition', 400, 'Registration is closed for this event');
            }

            // Duplicate = idempotent success (ported): an existing
            // non-cancelled registration returns success with NO writes,
            // so retries and double-clicks can never create a second
            // record or move the counters. This check runs before the
            // capacity check, as it did in the handler.
            if (regSnap.exists) {
                const existingStatus = String((regSnap.data() as any)?.status || 'pending');
                if (existingStatus !== 'cancelled') {
                    return { ok: true, alreadyRegistered: true };
                }
            }

            // Capacity (audit EV-P03), enforced against the canonical
            // counter — attendeeIds, the array the CTA and the register
            // page both read for their Full states. Events that define
            // no capacity (missing/0) are uncapped, as in the handler.
            const attendeeIds: string[] = Array.isArray(event.attendeeIds)
                ? event.attendeeIds.filter((x: any) => typeof x === 'string')
                : [];
            const capacity = Number(event.capacity || 0);
            if (capacity > 0 && attendeeIds.length >= capacity) {
                throw new RegistrationError('failed-precondition', 400, 'Sorry, this event is full');
            }

            const now = admin.firestore.FieldValue.serverTimestamp();
            const registeredUids: string[] = Array.isArray(event.registered_attendees_uids)
                ? event.registered_attendees_uids.filter((x: any) => typeof x === 'string')
                : [];
            const nextAttendeeIds = attendeeIds.includes(uid) ? attendeeIds : [...attendeeIds, uid];
            const nextRegisteredUids = registeredUids.includes(uid) ? registeredUids : [...registeredUids, uid];

            // One writer, one transaction: the registration record and
            // all three counters move together.
            tx.update(eventRef, {
                attendeeIds: nextAttendeeIds,
                registered_attendees_uids: nextRegisteredUids,
                registrationsCount: nextAttendeeIds.length,
                updatedAt: now,
            });

            const isPaidEvent = event?.paymentDetails?.isPaid === true;
            tx.set(regRef, {
                uid,
                eventId,
                displayName: userData.displayName || null,
                email: userData.email || null,
                whatsappE164: typeof data?.whatsappE164 === 'string' ? data.whatsappE164 : null,
                status: 'pending',
                paymentStatus: isPaidEvent ? 'unpaid' : 'verified',
                paymentMethod: typeof data?.paymentMethod === 'string'
                    ? data.paymentMethod
                    : (event?.paymentDetails?.method || null),
                paymentRef: null,
                createdAt: now,
                updatedAt: now,
            }, { merge: true });

            return { ok: true, alreadyRegistered: false };
        });

        return NextResponse.json({ result });
    } catch (err: any) {
        if (err instanceof RegistrationError) {
            return fail(err);
        }
        console.error('[registerForEvent] POST error:', err);
        return fail(new RegistrationError('internal', 500, err?.message || 'Registration failed'));
    }
}
