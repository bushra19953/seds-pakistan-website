import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
    getEventByIdFromSupa,
    mirrorDocUpdate,
    mirrorDocWrite,
} from '@/lib/supa-events/server-events';

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
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageEvents');
        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { eventId } = body;

        if (!eventId) {
            return NextResponse.json({ error: 'Missing eventId' }, { status: 400 });
        }

        const eventRef = db.collection('events').doc(eventId);

        // Supabase seam (flag-gated, default OFF): when the events surface is
        // switched on and Supabase answers, the event is read from fs_events
        // with timestamps normalized by the seam. Any "unavailable" result
        // (flag off, unconfigured, adapter error) runs the Firestore read
        // below exactly as before.
        const supaEvent = await getEventByIdFromSupa(eventId);
        let eventData: Record<string, any> | undefined;
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

            eventData = eventSnap.data();
        }

        if (eventData?.broadcasted) {
            return NextResponse.json({ message: 'Event already broadcasted globally. Skipping duplicate broadcast.' });
        }

        // 1. Ticker Bypass Fix: Create a high-priority EVENT_PROMO announcement
        // This is meant for the "Announcements" tab and the global marquee ticker.
        const annRef = db.collection('announcements').doc(`evt_promo_${eventId}`);
        const announcementData = {
            title: `🚀 New ${eventData?.type === 'workshop' ? 'Workshop' : 'Event'}: ${eventData?.title}`,
            content: eventData?.valueProposition || eventData?.description?.substring(0, 100) || `Registration is now open. Secure your spot!`,
            status: 'published',
            // Item 10: both announcement writers must stamp audience
            // and publish_date explicitly. Without them this doc
            // matches no consumer split query (missing audience, and
            // publish_date neither <= now nor == null) and event
            // promos would silently vanish from every feed.
            audience: 'public',
            publish_date: admin.firestore.FieldValue.serverTimestamp(),
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
        };
        await annRef.set(announcementData, { merge: true }); // Idempotent set
        // Dual-write mirror (no-op when the events flag is OFF): Firestore is
        // primary; the seam serializes the serverTimestamp sentinels to ISO.
        await mirrorDocWrite('announcements', `evt_promo_${eventId}`, announcementData, { merge: true });

        // 2. Mark the event as globally broadcasted
        const broadcastUpdate = {
            broadcasted: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await eventRef.update(broadcastUpdate);
        await mirrorDocUpdate('events', eventId, broadcastUpdate);

        return NextResponse.json({
            ok: true,
            message: `Global broadcast successful! Displaying on all user announcement feeds.`
        });

    } catch (err: any) {
        console.error('[events publish API] POST error:', err);
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
}
