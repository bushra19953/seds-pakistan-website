import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { hasServerPermission } from '@/lib/server/permissions';

// ─── QR Code generation (requires: npm install qrcode @types/qrcode) ─────────
async function generateQrBuffer(text: string): Promise<Buffer> {
    const QRCode = await import('qrcode');
    return await QRCode.toBuffer(text, {
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'H',
    });
}

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

// ─── Unique Ticket Image Generation using Sharp ──────────────────────────────
async function generateUniqueTicketImage(
    templateUrl: string,
    qrBuffer: Buffer,
    attendeeName: string,
    ticketId: string,
    config: any
): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    const response = await fetch(templateUrl);
    if (!response.ok) throw new Error(`Failed to fetch template: ${response.statusText}`);
    const templateBuffer = Buffer.from(await response.arrayBuffer());

    const metadata = await sharp(templateBuffer).metadata();
    const width = metadata.width || 1200;
    const height = metadata.height || 750;

    const overlays = config?.overlays || {};

    const svgParts: string[] = [];

    if (overlays.name?.enabled !== false) {
        const x = (overlays.name?.x ?? 50) * width / 100;
        const y = (overlays.name?.y ?? 50) * height / 100;
        const size = overlays.name?.size ?? 40;
        const color = overlays.name?.color ?? '#FFFFFF';
        // Sanitize name for SVG
        const safeName = attendeeName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        svgParts.push(`<text x="${x}" y="${y}" font-family="sans-serif" font-weight="bold" font-size="${size}" fill="${color}" text-anchor="middle">${safeName}</text>`);
    }

    if (overlays.ticketNum?.enabled !== false) {
        const x = (overlays.ticketNum?.x ?? 50) * width / 100;
        const y = (overlays.ticketNum?.y ?? 60) * height / 100;
        const size = overlays.ticketNum?.size ?? 24;
        const color = overlays.ticketNum?.color ?? '#AAAAAA';
        svgParts.push(`<text x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" fill="${color}" text-anchor="middle">${ticketId}</text>`);
    }

    if (overlays.email?.enabled !== false && config?.email) {
        const x = (overlays.email?.x ?? 50) * width / 100;
        const y = (overlays.email?.y ?? 70) * height / 100;
        const size = overlays.email?.size ?? 20;
        const color = overlays.email?.color ?? '#CCCCCC';
        const safeEmail = config.email.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        svgParts.push(`<text x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" fill="${color}" text-anchor="middle">${safeEmail}</text>`);
    }

    if (overlays.eventTitle?.enabled !== false && config?.eventTitle) {
        const x = (overlays.eventTitle?.x ?? 50) * width / 100;
        const y = (overlays.eventTitle?.y ?? 30) * height / 100;
        const size = overlays.eventTitle?.size ?? 32;
        const color = overlays.eventTitle?.color ?? '#FFFFFF';
        const safeTitle = config.eventTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        svgParts.push(`<text x="${x}" y="${y}" font-family="sans-serif" font-weight="bold" font-size="${size}" fill="${color}" text-anchor="middle">${safeTitle}</text>`);
    }

    const svgOverlay = Buffer.from(`<svg width="${width}" height="${height}">${svgParts.join('')}</svg>`);

    const composites: any[] = [
        { input: svgOverlay, top: 0, left: 0 }
    ];

    if (overlays.qrCode?.enabled !== false) {
        const qrX = (overlays.qrCode?.x ?? 80) * width / 100;
        const qrY = (overlays.qrCode?.y ?? 80) * height / 100;
        const qrSize = overlays.qrCode?.size ?? 150;

        const resizedQr = await sharp(qrBuffer).resize(qrSize, qrSize).toBuffer();
        composites.push({
            input: resizedQr,
            left: Math.round(qrX - qrSize / 2),
            top: Math.round(qrY - qrSize / 2)
        });
    }

    return await sharp(templateBuffer)
        .composite(composites)
        .png()
        .toBuffer();
}

async function generateQrDataUrl_Fallback(text: string): Promise<string> {
    try {
        const QRCode = await import('qrcode');
        return await QRCode.toDataURL(text, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
            errorCorrectionLevel: 'M',
        });
    } catch {
        return '';
    }
}

// ─── Sequential ticket number using Firestore transaction ────────────────────
async function getNextTicketNumber(
    db: FirebaseFirestore.Firestore,
    eventId: string
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

        const [callerSnap, existingTicketQuery, eventSnap, regSnap, userSnap] = await Promise.all([
            db.collection('users').doc(callerUid).get(),
            db.collection('eventTickets').where('eventId', '==', eventId).where('uid', '==', uid).limit(1).get(),
            db.collection('events').doc(eventId).get(),
            db.collection('events').doc(eventId).collection('registrations').doc(registrationDocId).get(),
            db.collection('users').doc(uid).get()
        ]);

        // ── Validations ──────────────────────────────────────────────────────
        const callerRole = (callerSnap.data()?.role as string) || 'member';
        const canIssue = await hasServerPermission(callerRole, 'canManageEvents');
        if (!canIssue) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        if (!existingTicketQuery.empty) {
            const doc = existingTicketQuery.docs[0];
            return NextResponse.json({ ok: true, ticketId: doc.id, ticketNumber: doc.data().ticketNumber, existing: true });
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

            // Accept any order that has been admin-verified (not just 'pending')
            const validOrder = orderQuery.docs.find(d => {
                const ps = d.data().paymentStatus;
                return ps === 'verified' || ps === 'completed' || ps === 'paid';
            });

            if (!validOrder) {
                // Last resort: accept any order at all for this event (admin pressed Issue Ticket, must trust intent)
                const anyOrder = orderQuery.docs[0];
                if (!anyOrder) {
                    console.error(`[tickets/issue] No order found for uid=${uid} eventId=${eventId}`);
                    return NextResponse.json({ error: 'Registration not found and no order exists for this user/event' }, { status: 404 });
                }
                // Use the order but warn
                console.warn(`[tickets/issue] Issuing ticket despite unverified paymentStatus for uid=${uid} eventId=${eventId}`);
                const orderData = anyOrder.data();
                const userData2 = userSnap.data();
                const autoRegData = {
                    uid, orderId: anyOrder.id, eventId,
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

        // ── Pre-compute values needed inside the transaction ─────────────────
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://sedspakistan.org';
        const uniqueTicketUrl = ''; // Will be set to hosted image URL if template rendering is enabled
        const qrCodeDataUrl = await generateQrDataUrl(`${siteUrl}/verify/ticket/PLACEHOLDER`).catch(() => '');

        // ── ATOMIC TICKET ISSUANCE (V15.0 - Deterministic & Transactional) ──
        const deterministicTicketId = `${eventId}_${uid}`;
        const ticketRef = db.collection('eventTickets').doc(deterministicTicketId);
        const registrationDocIdForUpdate = regId || uid;
        const regDocRef = db.collection('events').doc(eventId).collection('registrations').doc(registrationDocIdForUpdate);
        const userRef = db.collection('users').doc(uid);

        const result = await db.runTransaction(async (tx) => {
            const ticketSnap = await tx.get(ticketRef);

            // If ticket already exists, just return it (Prevents Duplication)
            if (ticketSnap.exists) {
                const existingData = ticketSnap.data()!;
                return {
                    ticketId: existingData.ticketId || deterministicTicketId,
                    ticketNumber: existingData.ticketNumber,
                    existing: true
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
                uniqueTicketUrl,
                paymentMethod: finalRegData.paymentMethod || 'manual',
                paymentRef: finalRegData.transactionId || finalRegData.paymentRef || '',
                registrationId: uid
            };

            tx.set(ticketRef, ticketData);
            tx.update(regDocRef, {
                ticketId: readableTicketId,
                ticketIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            const eventsAttended = Array.isArray(userData?.eventsAttended) ? userData.eventsAttended : [];
            const isAlreadyInProfile = eventsAttended.some((e: any) => e.eventId === eventId);
            if (!isAlreadyInProfile) {
                tx.update(userRef, {
                    eventsAttended: admin.firestore.FieldValue.arrayUnion({
                        eventId, eventTitle: eventData.title || 'Event', ticketId: readableTicketId,
                        uniqueTicketUrl,
                        attendedAt: admin.firestore.Timestamp.fromDate(new Date())
                    })
                });
            }

            // Production-Grade Unified Notification (P1: In-App + Push + Email)
            notificationService.send(uid, {
                type: 'ticket_issued',
                title: '🎟️ Your Ticket is Ready!',
                body: `Your ticket for "${eventData.title}" has been issued. Ticket #${nextCount}.`,
                link: uniqueTicketUrl,
                metadata: {
                    ticketId: readableTicketId,
                    eventId
                }
            }, 'P1').catch(err => console.error('[tickets/issue] Notification failed:', err));

            return { ticketId: readableTicketId, ticketNumber: nextCount, existing: false };
        });

        return NextResponse.json({ ok: true, ...result });

    } catch (err: any) {
        console.error('[tickets/issue] Error:', err);
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
}
