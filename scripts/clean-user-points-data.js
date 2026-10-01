/**
 * Data Cleanup Script: Fix Invalid Points Data
 * 
 * This script identifies and fixes users with invalid points data that could
 * be causing the leaderboard to stop loading at 29 users.
 * 
 * Usage: node scripts/clean-user-points-data.js
 */

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

async function cleanInvalidPointsData() {
  try {
    console.log('\n🧹 Starting data cleanup: Fixing invalid points data...\n');
    
    // Get all users ordered by points descending
    const usersRef = db.collection('users');
    const snapshot = await usersRef
      .orderBy('points', 'desc')
      .limit(60) // Get more than 50 to be safe
      .get();
    
    console.log(`📊 Found ${snapshot.size} users in database`);
    
    const batch = db.batch();
    let fixedCount = 0;
    let problematicUsers = [];
    let usersAnalyzed = 0;
    
    snapshot.forEach((doc) => {
      const userData = doc.data();
      usersAnalyzed++;
      
      // Check for problematic points data
      const points = userData.points;
      const hasValidPoints = (
        points !== undefined && 
        points !== null && 
        typeof points === 'number' && 
        !isNaN(points) &&
        isFinite(points)
      );
      
      if (!hasValidPoints) {
        const problem = {
          id: doc.id,
          displayName: userData.displayName || userData.name || userData.email || 'Unknown',
          points: points,
          pointsType: typeof points,
          problem: `Invalid points: ${JSON.stringify(points)} (type: ${typeof points})`
        };
        
        problematicUsers.push(problem);
        
        // Fix the invalid points data by setting it to 0
        batch.update(doc.ref, { 
          points: 0,
          updatedAt: new Date()
        });
        fixedCount++;
        
        console.log(`  🔧 FIXING: ${problem.displayName} (${doc.id}) - ${problem.problem}`);
      }
    });
    
    // Also check for users with non-numeric upvotes/downvotes
    console.log('\n📋 Additional checks for upvotes/downvotes...');
    const additionalSnapshot = await usersRef.get();
    additionalSnapshot.forEach((doc) => {
      const userData = doc.data();
      const userId = doc.id;
      const userName = userData.displayName || userData.name || userData.email || 'Unknown';
      
      // Check upvotes
      const upvotes = userData.upvotes;
      if (upvotes !== undefined && (typeof upvotes !== 'number' || isNaN(upvotes) || !isFinite(upvotes))) {
        batch.update(doc.ref, { 
          upvotes: typeof upvotes === 'string' ? Number(upvotes) || 0 : 0,
          updatedAt: new Date()
        });
        console.log(`  🔧 FIXING: ${userName} (${userId}) - Invalid upvotes: ${upvotes} (${typeof upvotes})`);
        fixedCount++;
      }
      
      // Check downvotes
      const downvotes = userData.downvotes;
      if (downvotes !== undefined && (typeof downvotes !== 'number' || isNaN(downvotes) || !isFinite(downvotes))) {
        batch.update(doc.ref, { 
          downvotes: typeof downvotes === 'string' ? Number(downvotes) || 0 : 0,
          updatedAt: new Date()
        });
        console.log(`  🔧 FIXING: ${userName} (${userId}) - Invalid downvotes: ${downvotes} (${typeof downvotes})`);
        fixedCount++;
      }
    });
    
    // Commit all fixes
    if (fixedCount > 0) {
      await batch.commit();
      console.log(`\n✅ Successfully fixed ${fixedCount} users with invalid data`);
    } else {
      console.log('\n✅ No invalid data found - all users have valid numeric fields');
    }
    
    // Report summary
    console.log(`\n📊 Summary:`);
    console.log(`   - Total users analyzed: ${usersAnalyzed}`);
    console.log(`   - Users with invalid points: ${problematicUsers.length}`);
    console.log(`   - Total fixes applied: ${fixedCount}`);
    
    if (problematicUsers.length > 0) {
      console.log(`\n❌ Users with problematic points data:`);
      problematicUsers.forEach(user => {
        console.log(`   - ${user.displayName} (${user.id}): ${user.problem}`);
      });
    } else {
      console.log(`\n✅ No users found with invalid points data!`);
    }
    
    console.log(`\n🎯 Next steps:`);
    console.log(`   1. Reload the leaderboard page in your browser`);
    console.log(`   2. Check if the leaderboard now shows more than 29 users`);
    console.log(`   3. If it still stops at a new number, run this script again`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Data cleanup failed:', error);
    process.exit(1);
  }
}

// Run the cleanup
cleanInvalidPointsData();