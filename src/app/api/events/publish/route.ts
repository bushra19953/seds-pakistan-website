import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

export async function POST(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);

        // Use dynamic permission checking
        const userRole = decoded.role || '';
        const canManage = await hasServerPermission(userRole, 'canManageEvents');
        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { eventId } = body;

        if (!eventId) {
            return NextResponse.json({ error: 'Missing eventId' }, { status: 400 });
        }

        const eventRef = db.collection('events').doc(eventId);
        const eventSnap = await eventRef.get();

        if (!eventSnap.exists) {
            return NextResponse.json({ error: 'Event not found' }, { status: 404 });
        }

        const eventData = eventSnap.data();

        if (eventData?.broadcasted) {
            return NextResponse.json({ message: 'Event already broadcasted globally. Skipping duplicate broadcast.' });
        }

        // 1. Ticker Bypass Fix: Create a high-priority EVENT_PROMO announcement
        // This is meant for the "Announcements" tab and the global marquee ticker.
        const annRef = db.collection('announcements').doc(`evt_promo_${eventId}`);
        await annRef.set({
            title: `🚀 New ${eventData?.type === 'workshop' ? 'Workshop' : 'Event'}: ${eventData?.title}`,
            content: eventData?.valueProposition || eventData?.description?.substring(0, 100) || `Registration is now open. Secure your spot!`,
            status: 'published',
            type: 'EVENT_PROMO', // Highlighting this for the global ticker
            priority: 'high',
            targetRoles: ['public'],
            ctaText: 'Register Now',
            ctaLink: `/events/${eventId}`,
            // ENFORCING NOTIFICATION DETAILS & FOMO (STAGE 2)
            deadline: eventData?.registrationDeadline || eventData?.endAt || null,
            capacity: eventData?.capacity || null,
            location: eventData?.location || null,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
            // Safe 30 days fallback if no end date
            expiresAt: eventData?.endAt || admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
            authorId: 'system',
            authorName: 'SEDS Central'
        }, { merge: true }); // Idempotent set

        // 2. Mark the event as globally broadcasted
        await eventRef.update({
            broadcasted: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return NextResponse.json({
            ok: true,
            message: `Global broadcast successful! Displaying on all user announcement feeds.`
        });

    } catch (err: any) {
        console.error('[events publish API] POST error:', err);
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
}
