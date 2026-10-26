import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { permissionsConfig } from '@/config/permissions.config';
import {
    getEventForRegistration,
    mirrorEventCounters,
    mirrorRegistrationWrite,
    registrationsSupaPrimary,
    runPaidRegistrationPrimary,
    runPaidRegistrationTransaction,
} from '@/lib/supa-events/registrations';

export async function POST(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const authHeader = request.headers.get('authorization');
        let uid: string | null = null;
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.split('Bearer ')[1];
            const decoded = await admin.auth().verifyIdToken(token);
            uid = decoded.uid;
        }

        if (!uid) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Discipline (spec E.4.8): event registration is a privilege; a
        // member under a Strike 2 suspension may not register.
        {
            const { suspensionBlock } = await import('@/lib/server/discipline/suspension');
            const block = await suspensionBlock(db, uid, new Date());
            if (block) {
                return NextResponse.json(block, { status: 403 });
            }
        }

        const body = await request.json();
        const { eventId, transactionId, screenshotLink, paymentMethod, amount, currency, buyer } = body;

        if (!eventId || !transactionId) {
            return NextResponse.json({ error: 'Missing required fields: eventId or transactionId' }, { status: 400 });
        }

        const eventRef = db.collection('events').doc(eventId);

        // Supabase seam (flag-gated, default OFF): when the events surface
        // is switched on and Supabase answers, the pre-transaction event
        // read comes from fs_events with timestamps normalized by the
        // seam, and it is authoritative — including not-found. Any
        // "unavailable" result (flag off, unconfigured, adapter error)
        // runs the Firestore read below exactly as before. The deadline
        // enforcement below consumes whichever read was selected
        // (VERIFICATION_SPEC section 2 T-1: the deadline stays pre-tx).
        const supaEvent = await getEventForRegistration(eventId);
        let eventData: Record<string, any>;
        if (supaEvent) {
            if (!supaEvent.found) {
                return NextResponse.json({ error: 'Event not found' }, { status: 404 });
            }
            eventData = supaEvent.data;
        } else {
            const eventSnap = await eventRef.get();
            if (!eventSnap.exists) {
                return NextResponse.json({ error: 'Event not found' }, { status: 404 });
            }
            eventData = eventSnap.data() as Record<string, any>;
        }

        // ── SERVER-SIDE DEADLINE ENFORCEMENT ────────────────────────────────────────
        // Prevents API-level bypass when UI shows Registration Closed
        const regDeadline = eventData.registrationDeadline;
        if (regDeadline) {
            const deadlineMs = regDeadline?.seconds
                ? regDeadline.seconds * 1000
                : new Date(regDeadline).getTime();
            if (Date.now() > deadlineMs) {
                return NextResponse.json(
                    { error: 'Registration has closed. The deadline for this event has passed.' },
                    { status: 400 }
                );
            }
        }

        // Idempotency (EV-P04): if a live registration already exists for
        // this user + event, a retry or double-click must never overwrite
        // it or mint a second order — return the existing state. The old
        // code blocked only an already-CONFIRMED registration; every
        // other re-POST overwrote the doc and added a fresh orders doc.
        // A CANCELLED registration is the one exception: it may be
        // replaced by a fresh submission (and exactly one new order).
        //
        // Capacity (EV-P06, paid arm): the free route
        // (app/registerForEvent) has always enforced capacity inside its
        // transaction; this route never did — it ran with no transaction
        // and no capacity check at all, and it never wrote the shared
        // counters, so a paid event could be oversold without limit and
        // a proof submitted without a prior seat-holding call was
        // invisible to every counter surface. The registration write,
        // the counter update, and the order now move in ONE transaction,
        // with the free route's exact semantics: duplicate check first
        // (a re-post by an existing registrant is never blocked by a
        // full event), then capacity against attendeeIds — the canonical
        // counter, from which cancelled registrants are removed by the
        // admin panel, so a cancelled registration consumes no seat.
        // The writer also applies the EV-P06 counter rule (union the uid
        // into attendeeIds and registered_attendees_uids, with
        // registrationsCount = attendeeIds.length), the same rule
        // /registerForEvent and the attendees panel apply.
        const orderRef = db.collection('orders').doc();

        // Additionally log this as a pending order in the unified store ledger so admins
        // can view and approve it through the standard financial pipeline
        const orderData = {
            status: 'pending_verification',
            buyerUserId: uid,
            buyer: buyer || {},
            amount: amount || 0,
            currency: currency || 'PKR',
            paymentMethod: paymentMethod || 'manual',
            receiptUrl: screenshotLink || transactionId,
            transactionId: transactionId,
            items: [{
                title: `Event Registration: ${eventData.title || eventId}`,
                eventId: eventId,
                type: 'event_ticket'
            }],
            originatingModule: 'Events',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // The transaction body lives in the registrations seam
        // (runPaidRegistrationTransaction), moved verbatim. While
        // SUPA_PRIMARY is off for 'events' it runs on Firestore exactly
        // as before (VERIFICATION_SPEC section 2 T-1). When
        // isSupaPrimary('events'), the seam's primary form runs
        // E2-TX-1 as ONE Postgres transaction (tx_events_register_paid)
        // as the only writer, and mirrors the committed result back to
        // Firestore post-commit, best-effort, inside the seam.
        const supaPrimary = registrationsSupaPrimary();
        const txArgs = {
            eventId,
            uid,
            transactionId,
            screenshotLink,
            paymentMethod,
            amount,
            currency,
            buyer,
            orderRef,
            orderData,
        };
        const txResult = supaPrimary
            ? await runPaidRegistrationPrimary(db, txArgs)
            : await runPaidRegistrationTransaction(db, txArgs);
        const outcome = txResult.outcome;

        if (!supaPrimary && outcome === 'created' && txResult.registrationData && txResult.counters) {
            // Dual-write mirrors (fire-and-swallow; no-ops when the flag
            // is off): copy exactly the payloads the transaction wrote.
            // The orders doc is NOT mirrored — it is the store cluster's
            // collection (VERIFICATION_SPEC section 5 C-1). On the
            // primary path the seam already mirrored in the other
            // direction, so these do not fire.
            await mirrorRegistrationWrite(eventId, uid, txResult.registrationData);
            await mirrorEventCounters(eventId, txResult.counters);
        }

        if (outcome === 'not-found') {
            return NextResponse.json({ error: 'Event not found' }, { status: 404 });
        }
        if (outcome === 'already-registered') {
            return NextResponse.json({
                ok: true,
                alreadyRegistered: true,
                message: 'You are already registered for this event. Your existing registration is unchanged.'
            });
        }
        if (outcome === 'full') {
            // Same outcome as the free route's capacity rejection:
            // HTTP 400 with the same message (this route's error
            // envelope is a plain string, as throughout the file).
            return NextResponse.json({ error: 'Sorry, this event is full' }, { status: 400 });
        }

        // Production-Grade Unified Notifications
        // 1. Notify User (P1: In-App + Push + Email)
        notificationService.send(uid, {
            type: 'event_registration_pending',
            title: '📝 Registration Submitted',
            body: `Your registration for "${eventData.title}" is under review. We'll notify you once verified.`,
            link: `/events/${eventId}`,
        }, 'P1').catch(err => console.error('[event-registrations] User notification failed:', err));

        // 2. Notify Admins (P2: In-App + Push)
        notificationService.broadcastByRoles(permissionsConfig.canManageEvents, {
            type: 'admin_registration_alert',
            title: '🎟️ New Event Registration',
            body: `${buyer?.fullName || 'A user'} registered for "${eventData.title}". Action required: Verification.`,
            link: `/admin/finance?tab=orders`,
        }, 'P2').catch(err => console.error('[event-registrations] Admin notification failed:', err));

        return NextResponse.json({
            ok: true,
            message: 'Proof submitted. An admin will verify your payment and confirm your registration shortly.'
        });

    } catch (err: any) {
        console.error('[event-registrations API] POST error:', err);
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
}
