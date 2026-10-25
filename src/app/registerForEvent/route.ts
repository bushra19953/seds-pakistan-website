import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import {
    RegistrationError,
    mirrorEventCounters,
    mirrorRegistrationWrite,
    runFreeRegistrationTransaction,
} from '@/lib/supa-events/registrations';

export { RegistrationError };

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

        // The transaction body lives in the registrations seam
        // (runFreeRegistrationTransaction), moved verbatim. It stays on
        // Firestore under both flag states — the adapter has no
        // transaction primitive and the capacity invariant cannot be
        // split across stores (VERIFICATION_SPEC section 2 T-2).
        const txResult = await runFreeRegistrationTransaction(db, {
            eventId,
            uid,
            data,
        });
        const result = { ok: txResult.ok, alreadyRegistered: txResult.alreadyRegistered };

        if (!txResult.alreadyRegistered && txResult.registrationData && txResult.counters) {
            // Dual-write mirrors (fire-and-swallow; no-ops when the flag
            // is off): copy exactly the payloads the transaction wrote.
            // The duplicate arm mirrors nothing — it wrote nothing.
            await mirrorRegistrationWrite(eventId, uid, txResult.registrationData);
            await mirrorEventCounters(eventId, txResult.counters);
        }

        return NextResponse.json({ result });
    } catch (err: any) {
        if (err instanceof RegistrationError) {
            return fail(err);
        }
        console.error('[registerForEvent] POST error:', err);
        return fail(new RegistrationError('internal', 500, err?.message || 'Registration failed'));
    }
}
