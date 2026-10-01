/**
 * Complete Leaderboard: Add Points Field to All Users
 * 
 * This script adds points: 0 to users who don't have a points field,
 * ensuring all 56 users are included in the leaderboard.
 * 
 * Usage: node scripts/add-points-to-all-users.js
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

async function addPointsToAllUsers() {
  try {
    console.log('\n🔧 Completing leaderboard: Adding points field to all users...\n');
    
    const usersRef = db.collection('users');
    const snapshot = await usersRef.get();
    const totalUsers = snapshot.size;
    
    console.log(`📊 Found ${totalUsers} total users in database`);
    
    const batch = db.batch();
    let usersWithPoints = 0;
    let usersAddedPoints = 0;
    let usersUpdatedPoints = 0;
    
    // Also get a reference for the leaderboard analysis
    const leaderboardRef = db.collection('users');
    const leaderboardSnapshot = await leaderboardRef
      .orderBy('points', 'desc')
      .limit(60)
      .get();
    const currentLeaderboardUsers = leaderboardSnapshot.size;
    
    snapshot.forEach((doc) => {
      const userData = doc.data();
      const userName = userData.displayName || userData.name || userData.email || 'Unknown';
      const currentPoints = userData.points;
      
      if (currentPoints === undefined || currentPoints === null) {
        // Add points field to users who don't have it
        batch.update(doc.ref, { 
          points: 0,
          updatedAt: new Date()
        });
        usersAddedPoints++;
        console.log(`  ➕ Adding points field to: ${userName} (${doc.id})`);
      } else {
        usersWithPoints++;
        
        // For users with existing points, ensure it's a valid number
        if (typeof currentPoints !== 'number' || isNaN(currentPoints) || !isFinite(currentPoints)) {
          batch.update(doc.ref, { 
            points: typeof currentPoints === 'string' ? Number(currentPoints) || 0 : 0,
            updatedAt: new Date()
          });
          usersUpdatedPoints++;
          console.log(`  🔧 Fixing invalid points for: ${userName} (${doc.id}) - was: ${currentPoints} (${typeof currentPoints})`);
        }
      }
    });
    
    // Commit all updates
    const totalUpdates = usersAddedPoints + usersUpdatedPoints;
    if (totalUpdates > 0) {
      await batch.commit();
      console.log(`\n✅ Successfully updated ${totalUpdates} users`);
    } else {
      console.log('\n✅ All users already have valid points data');
    }
    
    // Verify the results
    const newLeaderboardSnapshot = await leaderboardRef
      .orderBy('points', 'desc')
      .limit(60)
      .get();
    const newLeaderboardUsers = newLeaderboardSnapshot.size;
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Total users in database: ${totalUsers}`);
    console.log(`   Users with valid points (before): ${usersWithPoints}`);
    console.log(`   Users added points field: ${usersAddedPoints}`);
    console.log(`   Users with fixed invalid points: ${usersUpdatedPoints}`);
    console.log(`   Total updates applied: ${totalUpdates}`);
    
    console.log(`\n🎯 LEADERBOARD IMPACT:`);
    console.log(`   Users visible to leaderboard (before): ${currentLeaderboardUsers}`);
    console.log(`   Users visible to leaderboard (after): ${newLeaderboardUsers}`);
    console.log(`   Expected all users: ${totalUsers}`);
    
    if (newLeaderboardUsers === totalUsers) {
      console.log(`\n🎉 SUCCESS: All ${totalUsers} users are now visible in the leaderboard!`);
    } else {
      console.log(`\n⚠️  Note: ${totalUsers - newLeaderboardUsers} users may still not appear in leaderboard`);
      console.log(`   This could be due to Firestore query limitations or other filtering`);
    }
    
    console.log(`\n🚀 NEXT STEPS:`);
    console.log(`   1. Reload the leaderboard page in your browser`);
    console.log(`   2. The leaderboard should now show all ${newLeaderboardUsers} users`);
    console.log(`   3. Use pagination buttons to navigate through all users`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Failed to add points to users:', error);
    process.exit(1);
  }
}

// Run the script
addPointsToAllUsers();