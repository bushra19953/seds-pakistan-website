/*
  Counts how many users currently have recruitment access based on role documents.
  Access group mirrors Firestore isRecruitmentAdmin():
  - superadmin, president, vice_president, general_secretary, hr_director
  Additionally, the founder UID has access via isPresident() even without a role doc.

  Usage:
  1) Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON with Firestore read access
     setx GOOGLE_APPLICATION_CREDENTIALS "C:\\path\\to\\service-account.json"  (Windows PowerShell)
  2) Run: npm run count:recruitment-admins
*/

const admin = require('firebase-admin');

function init() {
  if (!admin.apps.length) {
    try {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    } catch (e) {
      console.error('Failed to initialize Firebase Admin SDK. Ensure credentials are set.', e);
      process.exit(1);
    }
  }
}

async function main() {
  init();
  const db = admin.firestore();

  // Keep this list in sync with firestore.rules isRecruitmentAdmin()
  const ALLOWED_ROLES = [
    'superadmin',
    'president',
    'vice_president',
    'general_secretary',
    'hr_director',
  ];

  // Founder UID has access via isPresident() even without a role doc
  const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

  try {
    // Single-field IN query (≤10 items allowed)
    const snap = await db
      .collection('roles')
      .where('role', 'in', ALLOWED_ROLES)
      .get();

    const users = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      users.push({ uid: doc.id, role: data.role || 'unknown' });
    });

    const founderInResults = users.some((u) => u.uid === FOUNDER_UID);
    const totalWithFounder = founderInResults ? users.length : users.length + 1;

    console.log('— Recruitment Access Summary —');
    console.log(`Matched by role: ${users.length}`);
    if (!founderInResults) {
      console.log('Founder has access via isPresident() and is included in total.');
    }
    console.log(`Total with founder: ${totalWithFounder}`);
    console.log('\nDetails (by uid):');
    console.table(users);
  } catch (err) {
    console.error('Error counting recruitment admins:', err);
    process.exitCode = 1;
  }
}

main();