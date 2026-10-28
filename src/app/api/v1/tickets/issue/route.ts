import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
    getEventForIssue,
    getExistingTicketForIssue,
    getRegistrationForIssue,
    issueTicketAtomically,
    mirrorTicketProfileEntry,
} from '@/lib/supa-events/tickets';

// ─── QR Code generation (requires: npm install qrcode @types/qrcode) ─────────
async function generateQrDataUrl(text: string): Promise<string> {
    try {
        const QRCode = await import('qrcode');
        return await QRCode.toDataURL(text, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
            errorCorrectionLevel: 'M',
        });
    } catch {
        // Fallback: return empty string if qrcode not installed
        console.warn('[tickets/issue] qrcode package not installed.');
        return '';
    }
}

// ─── Ticket template images: REMOVED (audit item 14) ─────────────────────
// generateUniqueTicketImage used to fetch a request-supplied templateUrl
// server-side with no host validation (SSRF shape). It had zero callers:
// the live POST handler issues tickets through issueTicketAtomically and
// never called it, and its two helper siblings (generateQrBuffer,
// generateQrDataUrl_Fallback) were likewise unreferenced. All three are
// deleted. If template-rendered ticket images are ever wanted, the fetch
// must be allowlisted to the app's own configured hosts first.

// ─── Sequential ticket number ────────────────────────────────────────────────
// The counter transaction now lives in the tickets seam
// (src/lib/supa-events/tickets.ts: allocateNextTicketNumber) and stays on
// Firestore under both Supa flag states — see MANUAL_LIST.md entry E3-TX-1.

export async function POST(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        // ── Auth & Role (Sequential as they are dependency for identity) ──────
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const callerUid = decoded.uid;

        // ── PARALLEL READS (The Performance Win) ─────────────────────────────
        const body = await request.json();
        const { eventId, uid, regId } = body as { eventId: string; uid: string; regId?: string };
        if (!eventId || !uid) return NextResponse.json({ error: 'Missing eventId or uid' }, { status: 400 });

        const registrationDocId = regId || uid;

        // Non-transactional reads route through the tickets seam: Supabase
        // (adapter over fs_* tables) when useSupa('tickets') is on, with a
        // Firestore fallback per read. The users read stays on Firestore —
        // it belongs to the identity cluster, not this seam.
        const [existingTicketQuery, eventSnap, regSnap, userSnap] = await Promise.all([
            getExistingTicketForIssue(db, eventId, uid),
            getEventForIssue(db, eventId),
            getRegistrationForIssue(db, eventId, registrationDocId),
            db.collection('users').doc(uid).get()
        ]);

        // ── Validations ──────────────────────────────────────────────────────
        const canIssue = await hasServerPermissionForUser(db, callerUid, 'canManageEvents');
        if (!canIssue) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        if (!existingTicketQuery.empty) {
            const doc = existingTicketQuery.docs[0];
            // Callers (the attendees panel, the orders panel) open
            // /events/ticket/<ticketId> from this value and members see
            // it in their profile: it must be the READABLE ticketId
            // field, not the deterministic doc id. Legacy tickets whose
            // doc id IS the readable id carry it in the field too, so
            // the field is correct for both generations; doc.id is
            // only the fallback for field-less legacy docs.
            return NextResponse.json({ ok: true, ticketId: doc.data().ticketId || doc.id, ticketNumber: doc.data().ticketNumber, existing: true });
        }

        if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

        // ── Graceful fallback for missing registration docs ───────────────────
        // Legacy orders (or orders created before the userId-as-docId fix) may
        // not have a registration doc keyed by uid. Check if there's a completed
        // order for this event/user — if so, auto-create the registration so the
        // ticket can still be issued without requiring admin to re-verify.
        let finalRegData: any;
        if (!regSnap.exists) {
            // Look for any order for this event by this user that has been verified or completed
            // IMPORTANT: Admin sets paymentStatus to 'verified' NOT 'completed' — must accept both
            const orderQuery = await db.collection('orders')
                .where('eventId', '==', eventId)
                .where('userId', '==', uid)
                .limit(10)
                .get();

            // Soft-deleted orders (Item 7, Q4) can neither confirm a seat nor
            // resurrect a ticket: skip any doc with deletedAt set.
            const liveDocs = orderQuery.docs.filter(d => {
                const dd: any = d.data();
                return dd.deletedAt === undefined || dd.deletedAt === null;
            });

            // Accept any order that has been admin-verified (not just 'pending')
            const validOrder = liveDocs.find(d => {
                const ps = d.data().paymentStatus;
                return ps === 'verified' || ps === 'completed' || ps === 'paid';
            });

            if (!validOrder) {
                // An order exists but its payment was never verified: that is an
                // unpaid registration, not a ticketable one. Never auto-confirm
                // it as verified (the old last-resort arm did exactly that).
                const anyOrder = liveDocs[0];
                if (!anyOrder) {
                    console.error(`[tickets/issue] No order found for uid=${uid} eventId=${eventId}`);
                    return NextResponse.json({ error: 'Registration not found and no order exists for this user/event' }, { status: 404 });
                }
                const orderPaymentStatus = anyOrder.data().paymentStatus || 'unpaid';
                return NextResponse.json({ error: `Registration payment not verified (paymentStatus: ${orderPaymentStatus}) - ticket cannot be issued for an unpaid registration` }, { status: 400 });
            } else {
                const orderData = validOrder.data();
                const userData2 = userSnap.data();
                const autoRegData = {
                    uid, orderId: validOrder.id, eventId,
                    displayName: orderData.buyer?.fullName || userData2?.displayName || 'Attendee',
                    email: orderData.buyer?.email || userData2?.email || '',
                    whatsappE164: orderData.buyer?.phone || orderData.buyer?.whatsappNumber || '',
                    status: 'confirmed', paymentStatus: 'verified',
                    paymentMethod: orderData.paymentMethod || 'bank_transfer',
                    paymentRef: orderData.proofOfPaymentUrl || '',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                await db.collection('events').doc(eventId).collection('registrations').doc(uid).set(autoRegData, { merge: true });
                finalRegData = autoRegData;
                console.log(`[tickets/issue] Auto-confirmed registration for uid=${uid} eventId=${eventId} from order=${validOrder.id}`);
            }
        } else {
            finalRegData = regSnap.data()!;
        }

        // Accept 'confirmed' OR 'verified' as valid — admin sometimes sets 'verified' directly
        if (finalRegData.status !== 'confirmed' && finalRegData.status !== 'verified') {
            return NextResponse.json({ error: `Registration not confirmed (status: ${finalRegData.status})` }, { status: 400 });
        }

        const userData = userSnap.data();
        const eventData = eventSnap.data()!;

        // ── Payment gate ─────────────────────────────────────────────────────
        // A confirmed seat is not a paid seat. For a paid event the
        // registration's paymentStatus must be 'verified' (the registration
        // vocabulary in types/event.ts; free events stamp 'verified' at
        // registration time and are not gated here). The attendees panel
        // disables its Issue button on this same condition, but the route
        // itself must enforce it: a direct API call bypasses the button.
        const isPaidEvent = eventData.paymentDetails?.isPaid === true;
        if (isPaidEvent && finalRegData.paymentStatus !== 'verified') {
            const paymentStatus = typeof finalRegData.paymentStatus === 'string' && finalRegData.paymentStatus
                ? finalRegData.paymentStatus
                : 'unpaid';
            return NextResponse.json({ error: `Registration payment not verified (paymentStatus: ${paymentStatus}) - ticket cannot be issued for an unpaid registration` }, { status: 400 });
        }

        // ── Pre-compute values needed inside the transaction ─────────────────
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://sedspakistan.live';

        // ── ATOMIC TICKET ISSUANCE (V15.0 - Deterministic & Transactional) ──
        // Isolated in the tickets seam (issueTicketAtomically) and kept on
        // Firestore under BOTH Supa flag states in this pass: the adapter
        // has no multi-document transaction, and splitting this write set
        // would break its atomicity. Postgres equivalent: MANUAL_LIST.md
        // entry E3-TX-2.
        const result = await issueTicketAtomically(db, {
            eventId,
            uid,
            registrationDocId: regId || uid,
            siteUrl,
            finalRegData,
            userData,
            eventData,
            generateQrDataUrl,
        });

        // Profile visibility (Issue Ticket defect wave): the transaction
        // arrayUnioned the ticket onto the Firestore user doc, which is
        // what the profile Tickets tab reads on the Firestore path. When
        // the profile seam serves fs_users, mirror the same entry there
        // or the issued ticket never appears in the member's profile.
        // Best-effort: the seam function swallows its own failures.
        if (!result.existing) {
            await mirrorTicketProfileEntry({
                uid,
                eventId,
                eventTitle: eventData.title || 'Event',
                ticketId: result.ticketId,
            });
        }

        return NextResponse.json({ ok: true, ...result });

    } catch (err: any) {
        console.error('[tickets/issue] Error:', err);
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
}
