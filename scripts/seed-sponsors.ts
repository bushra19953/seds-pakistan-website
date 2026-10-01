import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';

// Initialize Firebase Admin
const serviceAccountPath = path.join(process.cwd(), 'service-account-key.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error('Service account key not found at:', serviceAccountPath);
    process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount),
    });
}

const db = getFirestore();

const SAMPLE_PARTNERS = [
    {
        organizationName: "Galactic Tech Industries",
        relationshipType: "Sponsor",
        status: "Active",
        sponsorshipTier: "Gold",
        primaryContact: {
            name: "Sarah Connor",
            email: "sarah@galactictech.com",
            role: "VP of Partnerships"
        },
        financials: {
            pledgedAmount: 50000,
            amountReceived: 25000,
            agreementDate: "2024-01-15"
        },
        // A real sample PDF hosted online (NASA Space Act Agreement template or similar)
        agreementContractUrl: "https://www.nasa.gov/wp-content/uploads/2015/01/saa_template_-_reimbursable_umbrella_-_domestic_-_non-federal_-_5-19-23.pdf",
        website: "https://galactictech.com",
        logoUrl: "https://via.placeholder.com/150?text=Galactic+Tech"
    },
    {
        organizationName: "Orbital Media Group",
        relationshipType: "Media Partner",
        status: "Active",
        primaryContact: {
            name: "Clark Kent",
            email: "clark@dailyplanet.com",
            role: "Editor"
        },
        financials: {
            pledgedAmount: 0,
            agreementDate: "2024-03-10"
        },
        agreementContractUrl: "https://www.nasa.gov/wp-content/uploads/2015/01/saa_template_-_reimbursable_umbrella_-_domestic_-_non-federal_-_5-19-23.pdf",
        website: "https://orbitalmedia.com",
        logoUrl: "https://via.placeholder.com/150?text=Orbital+Media"
    },
    {
        organizationName: "Lunar Base Corp",
        relationshipType: "Technical Partner",
        status: "Prospect",
        primaryContact: {
            name: "Bruce Wayne",
            email: "bruce@wayneent.com"
        },
        website: "https://lunarbase.com",
        logoUrl: "https://via.placeholder.com/150?text=Lunar+Base"
    }
];

async function seed() {
    console.log('Seeding sponsors...');
    const col = db.collection('sponsors_partners');

    for (const partner of SAMPLE_PARTNERS) {
        // Check if exists to avoid duplicates
        const snapshot = await col.where('organizationName', '==', partner.organizationName).get();
        if (!snapshot.empty) {
            console.log(`Skipping ${partner.organizationName} (already exists)`);
            continue;
        }

        await col.add({
            ...partner,
            createdAt: new Date(),
            updatedAt: new Date()
        });
        console.log(`Added ${partner.organizationName}`);
    }
    console.log('Done!');
}

seed().catch(console.error);
