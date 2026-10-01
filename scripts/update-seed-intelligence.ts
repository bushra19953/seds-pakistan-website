import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccountPath = path.join(process.cwd(), 'service-account-key.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error('Service account key not found');
    process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount),
    });
}

const db = getFirestore();

async function updateSeedData() {
    console.log('Updating seed data with mock intelligence...');
    const col = db.collection('sponsors_partners');

    // Galactic Tech - Mock Intelligence
    const galactic = await col.where('organizationName', '==', 'Galactic Tech Industries').get();
    if (!galactic.empty) {
        const doc = galactic.docs[0];
        await doc.ref.update({
            agreementIntelligence: {
                summary: "Standard sponsorship agreement focusing on youth education and rocketry.",
                key_clauses: ["Exclusivity in aerospace sector", "Logo placement on all rockets", "First right of refusal for hiring"],
                deliverables_promised: ["$50k funding", "Technical mentorship", "Judge provision"],
                support_offered: ["Mentorship", "Funding", "Judges"],
                risk_factors: ["Requires 6 month notice for renewal"],
                analyzedAt: new Date().toISOString()
            }
        });
        console.log('Updated Galactic Tech');
    }

    // Orbital Media - Mock Intelligence
    const orbital = await col.where('organizationName', '==', 'Orbital Media Group').get();
    if (!orbital.empty) {
        const doc = orbital.docs[0];
        await doc.ref.update({
            agreementIntelligence: {
                summary: "Media partnership for event coverage.",
                key_clauses: ["Exclusive interview rights", "Press pass access", "Social media cross-promotion"],
                deliverables_promised: ["2 featured articles", "Live stream support"],
                support_offered: ["Media coverage", "Live streaming"],
                risk_factors: ["None"],
                analyzedAt: new Date().toISOString()
            }
        });
        console.log('Updated Orbital Media');
    }

    console.log('Done!');
}

updateSeedData().catch(console.error);
