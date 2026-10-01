import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

try {
    const serviceAccount = JSON.parse(fs.readFileSync('./firebase-adminsdk.json', 'utf8'));
    if (getApps().length === 0) {
        initializeApp({ credential: cert(serviceAccount) });
    }
    const db = getFirestore();

    console.log('--- FETCHING ALL EVENTS (Limit 20) ---');
    db.collection('events').limit(20).get()
        .then(snap => {
            console.log(`Total events found: ${snap.size}`);
            snap.forEach(doc => {
                const d = doc.data();
                console.log(`[${doc.id}] title: "${d.title}" | status: "${d.status}" | type: "${d.type}"`);
            });
            process.exit(0);
        })
        .catch(err => {
            console.error('Firestore error:', err);
            process.exit(1);
        });

} catch (err) {
    console.error('Init error:', err);
    process.exit(1);
}
