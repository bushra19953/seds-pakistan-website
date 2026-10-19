// Seed script: populates the `galleryAssets` collection with sample 3D spacecraft
// assets (placeholder .glb URLs, status 'published').
// Idempotent: skips seeding if the collection already has any documents.
//
// Usage:  node seed-gallery-assets.js
// Requires: firebase-admin (npm install in this directory) and a service account
// key (service-account-key.json / firebase-service-account.json /
// serviceAccountKey.json), or GOOGLE_APPLICATION_CREDENTIALS set.
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Helper: load service account (reuses pattern from seed-about.js)
function loadServiceAccount() {
  const possiblePaths = [
    path.join(process.cwd(), 'service-account-key.json'),
    path.join(process.cwd(), 'firebase-service-account.json'),
    path.join(process.cwd(), 'serviceAccountKey.json'),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ].filter(Boolean);

  for (const serviceAccountPath of possiblePaths) {
    try {
      if (fs.existsSync(serviceAccountPath)) {
        console.log(`Found service account key at: ${serviceAccountPath}`);
        return require(serviceAccountPath);
      }
    } catch (error) {
      continue;
    }
  }

  throw new Error(`
Service account key not found!

Please download your Firebase service account key from:
1. Go to Firebase Console -> Project Settings -> Service Accounts
2. Click "Generate New Private Key"
3. Save the JSON file as one of these names:
   - service-account-key.json (recommended)
   - firebase-service-account.json
   - serviceAccountKey.json

Or set GOOGLE_APPLICATION_CREDENTIALS environment variable to the file path.
`);
}

// Initialize Firebase Admin (try service account, then applicationDefault)
try {
  try {
    const serviceAccount = loadServiceAccount();
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin initialized with service account');
  } catch (saError) {
    console.warn('Service account not found. Falling back to applicationDefault credentials.');
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log('Firebase Admin initialized with applicationDefault credentials');
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Sample 3D spacecraft assets. assetUrl values are placeholders; replace with
// real hosted .glb files when they become available.
const SAMPLE_ASSETS = [
  {
    id: 'pak-sound-rocket-01',
    title: 'Pak-Sound Rocket',
    assetUrl: 'https://example.com/models/pak-sound-rocket.glb',
    thumbnailUrl: 'https://example.com/thumbnails/pak-sound-rocket.jpg',
    description:
      'Concept two-stage sounding rocket from the SEDS Pakistan propulsion study track. Placeholder model used for gallery layout testing.',
    status: 'published',
    createdBy: 'seed-script',
  },
  {
    id: 'cubesat-1u-bird',
    title: 'BIRD-1U CubeSat',
    assetUrl: 'https://example.com/models/bird-1u-cubesat.glb',
    thumbnailUrl: 'https://example.com/thumbnails/bird-1u-cubesat.jpg',
    description:
      '1U CubeSat bus concept developed by the SEDS Pakistan satellite team. Placeholder model used for gallery layout testing.',
    status: 'published',
    createdBy: 'seed-script',
  },
  {
    id: 'lunar-lander-concept',
    title: 'Chand Tangi Lander Concept',
    assetUrl: 'https://example.com/models/lunar-lander-concept.glb',
    thumbnailUrl: 'https://example.com/thumbnails/lunar-lander-concept.jpg',
    description:
      'Uncrewed lunar lander design study from the SEDS Pakistan deep space working group. Placeholder model used for gallery layout testing.',
    status: 'published',
    createdBy: 'seed-script',
  },
  {
    id: 'rover-marsyard',
    title: 'Marsyard Rover Prototype',
    assetUrl: 'https://example.com/models/marsyard-rover.glb',
    thumbnailUrl: 'https://example.com/thumbnails/marsyard-rover.jpg',
    description:
      'Six-wheel rover prototype for the university rover challenge program. Placeholder model used for gallery layout testing.',
    status: 'published',
    createdBy: 'seed-script',
  },
];

async function seedGalleryAssets() {
  try {
    console.log('\nSeeding galleryAssets...');

    // Idempotency check: skip entirely if any assets already exist
    const existing = await db.collection('galleryAssets').limit(1).get();
    if (!existing.empty) {
      console.log(
        `galleryAssets already contains ${existing.size} document(s). Skipping seed (no changes made).`
      );
      process.exit(0);
    }

    const batch = db.batch();
    const now = FieldValue.serverTimestamp();

    for (const asset of SAMPLE_ASSETS) {
      const ref = db.collection('galleryAssets').doc(asset.id);
      batch.set(ref, {
        title: asset.title,
        assetUrl: asset.assetUrl,
        thumbnailUrl: asset.thumbnailUrl,
        description: asset.description,
        status: asset.status,
        createdBy: asset.createdBy,
        createdAt: now,
        updatedAt: now,
      });
    }

    await batch.commit();
    console.log(`Seeded ${SAMPLE_ASSETS.length} gallery assets into galleryAssets.`);
    console.log('Gallery seed completed');
    process.exit(0);
  } catch (error) {
    console.error('\nGallery seeding failed:', error);
    process.exit(1);
  }
}

seedGalleryAssets();
