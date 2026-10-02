/* eslint-disable @typescript-eslint/no-require-imports -- CJS maintenance script; require is correct here */
/**
 * SEDS TICKET HEALER v16.0
 * Purpose: Retroactively fix "Invalid Date" and "Duplicate Tickets" in user profiles.
 * Features: De-duplication, Date standardization, Idempotency.
 */

const admin = require('firebase-admin');

// Initialize with your service account if running locally
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

async function healTicketsv16() {
    console.log('--- STARTING V16.0 TICKET HEALING SWARM ---');

    const usersSnap = await db.collection('users').get();
    console.log(`Found ${usersSnap.size} users to audit.`);

    let healedCount = 0;
    let dupeRemovedCount = 0;

    for (const doc of usersSnap.docs) {
        const data = doc.data();
        if (!data.eventsAttended || !Array.isArray(data.eventsAttended)) continue;

        const originalCount = data.eventsAttended.length;

        // 1. DEDUPLICATION & DATE STANDARDIZATION
        // Map to keep only one ticket per eventId (keeps the first one found)
        const eventMap = new Map();

        data.eventsAttended.forEach(ticket => {
            if (!ticket.eventId) return;

            // Handle Date/Timestamp mess
            let standardizedDate = null;
            if (ticket.attendedAt) {
                if (ticket.attendedAt._seconds || ticket.attendedAt.seconds) {
                    const secs = ticket.attendedAt._seconds || ticket.attendedAt.seconds;
                    standardizedDate = admin.firestore.Timestamp.fromMillis(secs * 1000);
                } else {
                    // Try parsing as string/date
                    const d = new Date(ticket.attendedAt);
                    standardizedDate = !isNaN(d.getTime()) ? admin.firestore.Timestamp.fromDate(d) : admin.firestore.Timestamp.now();
                }
            } else {
                standardizedDate = admin.firestore.Timestamp.now();
            }

            if (!eventMap.has(ticket.eventId)) {
                eventMap.set(ticket.eventId, {
                    ...ticket,
                    attendedAt: standardizedDate
                });
            } else {
                dupeRemovedCount++;
                console.log(`[DUPE] Removed extra ticket for event ${ticket.eventId} from user ${doc.id}`);
            }
        });

        const healedArray = Array.from(eventMap.values());

        // 2. ONLY UPDATE IF CHANGED
        if (healedArray.length !== originalCount) {
            await doc.ref.update({ eventsAttended: healedArray });
            healedCount++;
            console.log(`[HEALED] User ${doc.id} | ${originalCount} -> ${healedArray.length} entries.`);
        }
    }

    console.log(`--- HEALING COMPLETE ---`);
    console.log(`Users Repaired: ${healedCount}`);
    console.log(`Duplicates Nuked: ${dupeRemovedCount}`);
}

healTicketsv16().catch(console.error);
