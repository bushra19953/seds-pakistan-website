const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Helper: load service account (reuses pattern from migrate-add-points.js)
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
        console.log(`✅ Found service account key at: ${serviceAccountPath}`);
        return require(serviceAccountPath);
      }
    } catch (error) {
      continue;
    }
  }

  throw new Error(`
❌ Service account key not found!

Please download your Firebase service account key from:
1. Go to Firebase Console → Project Settings → Service Accounts
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
    console.log('✅ Firebase Admin initialized with service account');
  } catch (saError) {
    console.warn('⚠️ Service account not found. Falling back to applicationDefault credentials.');
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log('✅ Firebase Admin initialized with applicationDefault credentials');
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function seedAbout() {
  try {
    console.log('\n🚀 Seeding "About Us" page data...');

    // 1) pages/about document
    const aboutDoc = {
      slug: 'about',
      title: 'About Us',
      sections: [
        {
          key: 'mission',
          heading: 'Our Mission',
          content:
            'To inspire and empower students across Pakistan to explore space science and engineering through hands-on projects, outreach, and collaboration.',
          imageUrl: 'https://example.com/images/mission.jpg',
          order: 1,
        },
        {
          key: 'vision',
          heading: 'Our Vision',
          content:
            'A vibrant student community advancing space education, research, and innovation, building the next generation of space professionals.',
          order: 2,
        },
        {
          key: 'values',
          heading: 'Our Values',
          content:
            'Curiosity, collaboration, leadership, inclusivity, and a relentless pursuit of excellence in STEM.',
          order: 3,
        },
      ],
      updatedAt: FieldValue.serverTimestamp(),
    };
    await db.collection('pages').doc('about').set(aboutDoc, { merge: true });
    console.log('✅ Seeded pages/about');

    // 2) teamMembers (basic leadership team)
    const teamMembers = [
      {
        id: 'john-doe',
        name: 'John Doe',
        role: 'President',
        bio: 'Leads SEDS Pakistan; focuses on strategy and outreach.',
        photoUrl: 'https://example.com/photos/john.jpg',
        socialLinks: {
          linkedin: 'https://www.linkedin.com/in/john-doe',
          github: 'https://github.com/johndoe',
        },
        isActive: true,
        order: 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {
        id: 'jane-smith',
        name: 'Jane Smith',
        role: 'Vice President',
        bio: 'Coordinates projects and teams; drives operational excellence.',
        photoUrl: 'https://example.com/photos/jane.jpg',
        socialLinks: {
          twitter: 'https://twitter.com/jane_smith',
        },
        isActive: true,
        order: 2,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {
        id: 'ali-khan',
        name: 'Ali Khan',
        role: 'Projects Director',
        bio: 'Oversees project portfolio and technical mentorship.',
        socialLinks: {},
        isActive: true,
        order: 3,
        updatedAt: FieldValue.serverTimestamp(),
      },
    ];

    const batch = db.batch();
    for (const m of teamMembers) {
      const ref = db.collection('teamMembers').doc(m.id);
      batch.set(ref, m, { merge: true });
    }

    // 3) roleHistory (sample timeline entries)
    const roleHistory = [
      {
        id: 'president-2024-john-doe',
        role: 'President',
        person: 'John Doe',
        startDate: new Date('2024-01-01'),
        notes: 'Elected 2024',
      },
      {
        id: 'vice-president-2024-jane-smith',
        role: 'Vice President',
        person: 'Jane Smith',
        startDate: new Date('2024-01-01'),
        notes: 'Elected 2024',
      },
      {
        id: 'president-2023-maryam-ali',
        role: 'President',
        person: 'Maryam Ali',
        startDate: new Date('2023-01-01'),
        endDate: new Date('2023-12-31'),
        notes: 'Served 2023',
      },
    ];
    for (const h of roleHistory) {
      const ref = db.collection('roleHistory').doc(h.id);
      batch.set(ref, h, { merge: true });
    }

    await batch.commit();
    console.log('✅ Seeded teamMembers and roleHistory');

    console.log('\n🎉 About page data seeding completed');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Seeding failed:', error);
    process.exit(1);
  }
}

seedAbout();