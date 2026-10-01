/**
 * Comprehensive Leaderboard Analysis Script
 * 
 * Analyzes all aspects of the leaderboard system:
 * - Data retrieval patterns
 * - Role distribution and display logic
 * - Upvotes/downvotes functionality
 * - Edge cases and failure points
 * - Performance considerations
 * - User data integrity
 * 
 * Usage: node scripts/analyze-leaderboard-comprehensive.js
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Helper function to load service account
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

// Define role hierarchy from the code
const ROLE_HIERARCHY = {
  superadmin: 11,
  president: 10,
  vice_president: 9,
  general_secretary: 9,
  projects_director: 9,
  marketing_head: 9,
  hr_director: 9,
  treasurer: 9,
  advisor: 8,
  chair_projects: 8,
  chair_marketing: 8,
  chair_outreach: 8,
  chair_design: 8,
  chair_alumni: 8,
  chair_events: 8,
  chair_recruitment: 8,
  chair_ethics: 8,
  chair_sponsorship: 8,
  rocketry_team: 7,
  cubesat_team: 7,
  rover_team: 7,
  member: 1,
  guest: 0,
};

async function analyzeLeaderboard() {
  try {
    console.log('\n🔍 COMPREHENSIVE LEADERBOARD ANALYSIS\n');
    
    // 1. Get all users
    console.log('📊 1. ANALYZING USER DATA RETRIEVAL PATTERNS...');
    const usersRef = db.collection('users');
    const usersSnap = await usersRef.get();
    const allUsers = [];
    
    usersSnap.forEach((doc) => {
      const userData = doc.data();
      allUsers.push({
        id: doc.id,
        ...userData,
        // Normalize data types
        points: typeof userData.points === 'number' ? userData.points : 
                (typeof userData.points === 'string' ? Number(userData.points) || 0 : 0),
        upvotes: typeof userData.upvotes === 'number' ? userData.upvotes : 
                 (typeof userData.upvotes === 'string' ? Number(userData.upvotes) || 0 : 0),
        downvotes: typeof userData.downvotes === 'number' ? userData.downvotes : 
                   (typeof userData.downvotes === 'string' ? Number(userData.downvotes) || 0 : 0),
        tasksAssignedCount: typeof userData.tasksAssignedCount === 'number' ? userData.tasksAssignedCount : 
                           (typeof userData.tasksAssignedCount === 'string' ? Number(userData.tasksAssignedCount) || 0 : 0),
        tasksCompletedOnTimeCount: typeof userData.tasksCompletedOnTimeCount === 'number' ? userData.tasksCompletedOnTimeCount : 
                                  (typeof userData.tasksCompletedOnTimeCount === 'string' ? Number(userData.tasksCompletedOnTimeCount) || 0 : 0),
      });
    });
    
    console.log(`   Total users in database: ${allUsers.length}`);
    
    // 2. Get all roles
    console.log('\n📊 2. ANALYZING ROLE DISTRIBUTION...');
    const rolesSnap = await db.collection('roles').get();
    const userRoles = new Map();
    
    rolesSnap.forEach((doc) => {
      const roleData = doc.data();
      userRoles.set(doc.id, roleData.role || null);
    });
    
    console.log(`   Total role assignments: ${userRoles.size}`);
    
    // 3. Analyze data integrity
    console.log('\n📊 3. ANALYZING DATA INTEGRITY & EDGE CASES...');
    const dataIntegrity = {
      missingPoints: 0,
      missingUpvotes: 0,
      missingDownvotes: 0,
      missingTasksData: 0,
      invalidPoints: 0,
      invalidUpvotes: 0,
      invalidDownvotes: 0,
      nullUndefined: 0,
      emptyString: 0,
      negativeValues: 0,
      veryLargeValues: 0,
    };
    
    // 4. Analyze role distribution
    console.log('\n📊 4. ANALYZING ROLE TYPES & DISPLAY LOGIC...');
    const roleDistribution = new Map();
    const problematicUsers = [];
    
    allUsers.forEach((user) => {
      const role = userRoles.get(user.id);
      
      // Track role distribution
      const roleKey = role || 'none';
      if (!roleDistribution.has(roleKey)) {
        roleDistribution.set(roleKey, {
          count: 0,
          totalPoints: 0,
          totalUpvotes: 0,
          totalDownvotes: 0,
          users: []
        });
      }
      
      const roleData = roleDistribution.get(roleKey);
      roleData.count++;
      roleData.totalPoints += user.points;
      roleData.totalUpvotes += user.upvotes;
      roleData.totalDownvotes += user.downvotes;
      roleData.users.push({
        id: user.id,
        name: user.displayName || user.name || user.email || 'Unknown',
        points: user.points,
        upvotes: user.upvotes,
        downvotes: user.downvotes
      });
      
      // Check data integrity issues
      const issues = [];
      
      if (user.points === undefined || user.points === null) {
        dataIntegrity.missingPoints++;
        issues.push('Missing points');
      }
      
      if (user.upvotes === undefined || user.upvotes === null) {
        dataIntegrity.missingUpvotes++;
        issues.push('Missing upvotes');
      }
      
      if (user.downvotes === undefined || user.downvotes === null) {
        dataIntegrity.missingDownvotes++;
        issues.push('Missing downvotes');
      }
      
      if (user.tasksAssignedCount === undefined || user.tasksAssignedCount === null || 
          user.tasksCompletedOnTimeCount === undefined || user.tasksCompletedOnTimeCount === null) {
        dataIntegrity.missingTasksData++;
        issues.push('Missing tasks data');
      }
      
      if (typeof user.points !== 'number' || isNaN(user.points)) {
        dataIntegrity.invalidPoints++;
        issues.push('Invalid points type');
      }
      
      if (typeof user.upvotes !== 'number' || isNaN(user.upvotes)) {
        dataIntegrity.invalidUpvotes++;
        issues.push('Invalid upvotes type');
      }
      
      if (typeof user.downvotes !== 'number' || isNaN(user.downvotes)) {
        dataIntegrity.invalidDownvotes++;
        issues.push('Invalid downvotes type');
      }
      
      if (user.points < 0 || user.upvotes < 0 || user.downvotes < 0) {
        dataIntegrity.negativeValues++;
        issues.push('Negative values');
      }
      
      if (user.points > 10000 || user.upvotes > 1000 || user.downvotes > 1000) {
        dataIntegrity.veryLargeValues++;
        issues.push('Very large values');
      }
      
      if (issues.length > 0) {
        problematicUsers.push({
          id: user.id,
          name: user.displayName || user.name || user.email || 'Unknown',
          role: role,
          issues: issues,
          data: {
            points: user.points,
            upvotes: user.upvotes,
            downvotes: user.downvotes,
            tasksAssignedCount: user.tasksAssignedCount,
            tasksCompletedOnTimeCount: user.tasksCompletedOnTimeCount
          }
        });
      }
    });
    
    // 5. Analyze leaderboard query results
    console.log('\n📊 5. ANALYZING LEADERBOARD QUERY SIMULATION...');
    
    // Simulate the exact query from leaderboard.tsx
    const leaderboardQuery = usersRef.orderBy('points', 'desc').limit(60);
    const leaderboardSnap = await leaderboardQuery.get();
    
    const leaderboardUsers = [];
    leaderboardSnap.forEach((doc) => {
      const userData = doc.data();
      const role = userRoles.get(doc.id);
      leaderboardUsers.push({
        id: doc.id,
        name: userData.displayName || userData.name || userData.email || 'Unknown',
        points: typeof userData.points === 'number' ? userData.points : 
                (typeof userData.points === 'string' ? Number(userData.points) || 0 : 0),
        role: role,
        isPresident: role === 'president' || doc.id === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1',
        isPinnedPresident: false, // Would need additional logic
        upvotes: typeof userData.upvotes === 'number' ? userData.upvotes : 
                 (typeof userData.upvotes === 'string' ? Number(userData.upvotes) || 0 : 0),
        downvotes: typeof userData.downvotes === 'number' ? userData.downvotes : 
                   (typeof userData.downvotes === 'string' ? Number(userData.downvotes) || 0 : 0),
      });
    });
    
    console.log(`   Users visible to leaderboard: ${leaderboardUsers.length}`);
    console.log(`   Users with points > 0: ${leaderboardUsers.filter(u => u.points > 0).length}`);
    console.log(`   Presidents in leaderboard: ${leaderboardUsers.filter(u => u.isPresident).length}`);
    
    // 6. Analyze filtering logic
    console.log('\n📊 6. ANALYZING FILTERING LOGIC...');
    
    // Simulate the filtering logic from leaderboard.tsx
    let visibleUsers = [...leaderboardUsers];
    
    // Remove pinned president
    const pinnedPresident = null; // Would need to fetch from settings
    if (pinnedPresident) {
      visibleUsers = visibleUsers.filter(u => u.id !== pinnedPresident.id);
    }
    
    // Remove other presidents
    visibleUsers = visibleUsers.filter(u => {
      const role = userRoles.get(u.id) || null;
      const isRegularPresident = role === 'president' && (!pinnedPresident || u.id !== pinnedPresident.id);
      return !isRegularPresident;
    });
    
    console.log(`   Users after filtering: ${visibleUsers.length}`);
    console.log(`   Presidents removed: ${leaderboardUsers.length - visibleUsers.length}`);
    
    // 7. Performance Analysis
    console.log('\n📊 7. PERFORMANCE ANALYSIS...');
    console.log(`   Total Firestore reads: ${usersSnap.size + rolesSnap.size + leaderboardSnap.size}`);
    console.log(`   Memory usage: ~${JSON.stringify(allUsers).length / 1024}KB for user data`);
    console.log(`   Pagination would need: ${Math.ceil(visibleUsers.length / 10)} pages`);
    
    // 8. Output comprehensive results
    console.log('\n📊 COMPREHENSIVE ANALYSIS RESULTS:');
    console.log('=====================================');
    
    console.log('\n🔍 DATA INTEGRITY ISSUES:');
    Object.entries(dataIntegrity).forEach(([key, value]) => {
      if (value > 0) {
        console.log(`   ❌ ${key}: ${value} users`);
      }
    });
    
    console.log('\n👥 ROLE DISTRIBUTION:');
    const sortedRoles = Array.from(roleDistribution.entries())
      .sort((a, b) => b[1].count - a[1].count);
    
    sortedRoles.forEach(([role, data]) => {
      const avgPoints = data.count > 0 ? (data.totalPoints / data.count).toFixed(1) : '0';
      const avgUpvotes = data.count > 0 ? (data.totalUpvotes / data.count).toFixed(1) : '0';
      const avgDownvotes = data.count > 0 ? (data.totalDownvotes / data.count).toFixed(1) : '0';
      console.log(`   ${role}: ${data.count} users (avg: ${avgPoints} points, ${avgUpvotes} upvotes, ${avgDownvotes} downvotes)`);
    });
    
    console.log('\n⚠️ PROBLEMATIC USERS:');
    if (problematicUsers.length > 0) {
      problematicUsers.slice(0, 10).forEach((user) => {
        console.log(`   ID: ${user.id}`);
        console.log(`   Name: ${user.name}`);
        console.log(`   Role: ${user.role || 'none'}`);
        console.log(`   Issues: ${user.issues.join(', ')}`);
        console.log(`   Data: points=${user.data.points}, upvotes=${user.data.upvotes}, downvotes=${user.data.downvotes}`);
        console.log('');
      });
      if (problematicUsers.length > 10) {
        console.log(`   ... and ${problematicUsers.length - 10} more users with issues`);
      }
    } else {
      console.log('   ✅ No problematic users found');
    }
    
    console.log('\n🎯 LEADERBOARD VISIBILITY ANALYSIS:');
    console.log(`   Total users in DB: ${allUsers.length}`);
    console.log(`   Users with points: ${allUsers.filter(u => (u.points || 0) > 0).length}`);
    console.log(`   Users with points = 0: ${allUsers.filter(u => (u.points || 0) === 0).length}`);
    console.log(`   Users missing points field: ${allUsers.filter(u => u.points === undefined || u.points === null).length}`);
    console.log(`   Leaders visible after filtering: ${visibleUsers.length}`);
    
    console.log('\n📈 UPVOTES/DOWNVOTES ANALYSIS:');
    const usersWithUpvotes = allUsers.filter(u => (u.upvotes || 0) > 0).length;
    const usersWithDownvotes = allUsers.filter(u => (u.downvotes || 0) > 0).length;
    console.log(`   Users with upvotes > 0: ${usersWithUpvotes} (${((usersWithUpvotes/allUsers.length)*100).toFixed(1)}%)`);
    console.log(`   Users with downvotes > 0: ${usersWithDownvotes} (${((usersWithDownvotes/allUsers.length)*100).toFixed(1)}%)`);
    
    const avgUpvotes = allUsers.reduce((sum, u) => sum + (u.upvotes || 0), 0) / allUsers.length;
    const avgDownvotes = allUsers.reduce((sum, u) => sum + (u.downvotes || 0), 0) / allUsers.length;
    console.log(`   Average upvotes per user: ${avgUpvotes.toFixed(2)}`);
    console.log(`   Average downvotes per user: ${avgDownvotes.toFixed(2)}`);
    
    console.log('\n🔧 POTENTIAL FAILURE POINTS IDENTIFIED:');
    console.log('=====================================');
    
    if (dataIntegrity.missingPoints > 0) {
      console.log('❌ Missing points field - users not visible in leaderboard');
    }
    
    if (dataIntegrity.invalidPoints > 0) {
      console.log('❌ Invalid points data type - sorting issues');
    }
    
    if (usersWithUpvotes === 0 || usersWithDownvotes === 0) {
      console.log('❌ No voting activity - upvotes/downvotes not working');
    }
    
    if (problematicUsers.length > allUsers.length * 0.1) {
      console.log('❌ High percentage of problematic users - data integrity issues');
    }
    
    const presidentsVisible = visibleUsers.filter(u => userRoles.get(u.id) === 'president').length;
    if (presidentsVisible > 0) {
      console.log('❌ Presidents visible in regular leaderboard - filtering logic issue');
    }
    
    console.log('\n✅ LEADERBOARD FUNCTIONALITY STATUS:');
    console.log('=====================================');
    console.log(`   📊 Data retrieval: ${allUsers.length} users processed`);
    console.log(`   👥 Role display: ${sortedRoles.length} different roles found`);
    console.log(`   🗳️  Voting system: ${usersWithUpvotes} users with upvotes, ${usersWithDownvotes} with downvotes`);
    console.log(`   🔍 Filtering: ${visibleUsers.length} users visible after filtering`);
    console.log(`   📄 Pagination: ${Math.ceil(visibleUsers.length / 10)} pages needed`);
    console.log(`   🛡️  Data integrity: ${problematicUsers.length} users with issues`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Leaderboard analysis failed:', error);
    process.exit(1);
  }
}

// Run the analysis
analyzeLeaderboard();