import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { permissionsConfig } from '@/config/permissions.config';

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

        const body = await request.json();
        const { eventId, transactionId, screenshotLink, paymentMethod, amount, currency, buyer } = body;

        if (!eventId || !transactionId) {
            return NextResponse.json({ error: 'Missing required fields: eventId or transactionId' }, { status: 400 });
        }

        const eventRef = db.collection('events').doc(eventId);
        const eventSnap = await eventRef.get();
        if (!eventSnap.exists) {
            return NextResponse.json({ error: 'Event not found' }, { status: 404 });
        }
        const eventData = eventSnap.data() as Record<string, any>;

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

        // Create the registration doc under the event with UNDER_REVIEW / PENDING status
        const registrationRef = eventRef.collection('registrations').doc(uid);
        const regSnap = await registrationRef.get();
        if (regSnap.exists && regSnap.data()?.status === 'confirmed') {
            return NextResponse.json({ error: 'You are already registered and confirmed for this event.' }, { status: 400 });
        }

        await registrationRef.set({
            uid,
            eventId,
            transactionId,
            screenshotLink: screenshotLink || '',
            displayName: buyer?.fullName || '',
            email: buyer?.email || '',
            status: 'under_review', // Used for registrationStatus
            paymentStatus: 'pending', // Awaiting manual verification
            paymentMethod: paymentMethod || 'manual',
            amount: amount || 0,
            currency: currency || 'PKR',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

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
                title: `Event Registration: ${eventSnap.data()?.title || eventId}`,
                eventId: eventId,
                type: 'event_ticket'
            }],
            originatingModule: 'Events',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection('orders').add(orderData);

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
