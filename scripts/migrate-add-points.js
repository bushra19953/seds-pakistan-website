
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Helper function to load service account (same as create-superadmin.js)
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

// Initialize Firebase Admin
try {
  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const db = admin.firestore();

async function addPointsToUsers() {
  try {
    console.log('\n🚀 Starting migration: Adding points field to all users...\n');
    
    const usersSnapshot = await db.collection('users').get();
    console.log(`📊 Found ${usersSnapshot.size} users in database`);
    
    const batch = db.batch();
    let updateCount = 0;
    let alreadyHavePoints = 0;
    
    usersSnapshot.forEach((doc) => {
      const userData = doc.data();
      
      // Only update if points field doesn't exist
      if (userData.points === undefined) {
        batch.update(doc.ref, { points: 0 });
        updateCount++;
        console.log(`  ➕ Adding points field to user: ${userData.displayName || userData.email || doc.id}`);
      } else {
        alreadyHavePoints++;
      }
    });
    
    if (updateCount > 0) {
      await batch.commit();
      console.log(`\n✅ Successfully added points field to ${updateCount} users`);
    } else {
      console.log('\nℹ️  All users already have points field');
    }
    
    console.log(`📈 Summary:`);
    console.log(`   - Total users: ${usersSnapshot.size}`);
    console.log(`   - Updated: ${updateCount}`);
    console.log(`   - Already had points: ${alreadyHavePoints}`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run the migration
addPointsToUsers();
