/**
 * Complete User Count Script
 * 
 * This script counts ALL users in the database, regardless of points value,
 * to determine the true user base size.
 * 
 * Usage: node scripts/count-all-users.js
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

async function countAllUsers() {
  try {
    console.log('\n📊 Counting ALL users in the database...\n');
    
    // Get all users without any order (to get complete count)
    const usersRef = db.collection('users');
    const allSnapshot = await usersRef.get();
    const totalUsers = allSnapshot.size;
    
    console.log(`📈 Total users in database: ${totalUsers}`);
    
    // Count by points status
    let usersWithPoints = 0;
    let usersWithZeroPoints = 0;
    let usersWithoutPointsField = 0;
    let usersWithNegativePoints = 0;
    
    const pointDistribution = {};
    
    allSnapshot.forEach((doc) => {
      const userData = doc.data();
      const userName = userData.displayName || userData.name || userData.email || 'Unknown';
      const points = userData.points;
      
      if (points === undefined || points === null) {
        usersWithoutPointsField++;
      } else if (typeof points === 'number' && !isNaN(points)) {
        if (points > 0) {
          usersWithPoints++;
        } else if (points === 0) {
          usersWithZeroPoints++;
        } else {
          usersWithNegativePoints++;
        }
        
        // Count by point ranges
        if (points >= 1000) pointDistribution['1000+'] = (pointDistribution['1000+'] || 0) + 1;
        else if (points >= 500) pointDistribution['500-999'] = (pointDistribution['500-999'] || 0) + 1;
        else if (points >= 100) pointDistribution['100-499'] = (pointDistribution['100-499'] || 0) + 1;
        else if (points >= 50) pointDistribution['50-99'] = (pointDistribution['50-99'] || 0) + 1;
        else if (points >= 10) pointDistribution['10-49'] = (pointDistribution['10-49'] || 0) + 1;
        else if (points >= 1) pointDistribution['1-9'] = (pointDistribution['1-9'] || 0) + 1;
        else if (points === 0) pointDistribution['0'] = (pointDistribution['0'] || 0) + 1;
        else pointDistribution['negative'] = (pointDistribution['negative'] || 0) + 1;
      } else {
        usersWithoutPointsField++;
      }
    });
    
    // Get users ordered by points (what leaderboard sees)
    console.log('\n📋 Getting users ordered by points...');
    const orderedSnapshot = await usersRef
      .orderBy('points', 'desc')
      .limit(60)
      .get();
    
    console.log(`📈 Users visible to leaderboard (top 60 by points): ${orderedSnapshot.size}`);
    
    // Check the 30th user specifically
    if (orderedSnapshot.size >= 30) {
      const usersArray = orderedSnapshot.docs;
      const user30 = usersArray[29]; // 0-indexed
      const user30Data = user30.data();
      console.log(`\n🎯 30th User Analysis:`);
      console.log(`   ID: ${user30.id}`);
      console.log(`   Name: ${user30Data.displayName || user30Data.name || user30Data.email || 'Unknown'}`);
      console.log(`   Points: ${user30Data.points} (${typeof user30Data.points})`);
    }
    
    // Summary report
    console.log(`\n📊 COMPLETE USER ANALYSIS:`);
    console.log(`   ===============================`);
    console.log(`   Total registered users: ${totalUsers}`);
    console.log(`   Users with positive points: ${usersWithPoints}`);
    console.log(`   Users with zero points: ${usersWithZeroPoints}`);
    console.log(`   Users with negative points: ${usersWithNegativePoints}`);
    console.log(`   Users without points field: ${usersWithoutPointsField}`);
    
    console.log(`\n📈 Points Distribution:`);
    Object.keys(pointDistribution).sort().forEach(range => {
      console.log(`   ${range.padEnd(10)}: ${pointDistribution[range]} users`);
    });
    
    console.log(`\n🔍 LEADERBOARD INSIGHTS:`);
    console.log(`   - Leaderboard shows ${Math.min(10, orderedSnapshot.size)} users per page`);
    console.log(`   - With ${totalUsers} total users, you need ${Math.ceil(totalUsers / 10)} pages`);
    console.log(`   - User should click "Next" button ${Math.ceil(totalUsers / 10) - 1} times to see all users`);
    
    if (totalUsers > orderedSnapshot.size) {
      console.log(`   ⚠️  Note: ${totalUsers - orderedSnapshot.size} users have no or negative points`);
      console.log(`      They appear at the end of the leaderboard and may not be visible`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ User count failed:', error);
    process.exit(1);
  }
}

// Run the count
countAllUsers();