#!/usr/bin/env node

/**
 * Diagnostic Script: Find the "Poison Pill" User
 * 
 * This script helps identify users with problematic points data that could
 * be causing the leaderboard to stop loading at 29 users.
 * 
 * Usage: node diagnose-user-data.js
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
} catch (error) {
  console.error('Failed to initialize Firebase Admin. Make sure GOOGLE_APPLICATION_CREDENTIALS is set.');
  process.exit(1);
}

const db = admin.firestore();

async function diagnoseUserData() {
  try {
    console.log('🔍 Starting user data diagnosis...');
    
    // Get all users ordered by points descending
    const usersRef = db.collection('users');
    const snapshot = await usersRef
      .orderBy('points', 'desc')
      .limit(50) // Get first 50 to be safe
      .get();
    
    console.log(`📊 Total users fetched: ${snapshot.size}`);
    
    const problematicUsers = [];
    const users = [];
    
    snapshot.forEach((doc, index) => {
      const data = doc.data();
      const user = {
        id: doc.id,
        index: index + 1,
        displayName: data.displayName || data.name || data.email || 'Unknown',
        points: data.points,
        pointsType: typeof data.points,
        hasPoints: data.points !== undefined && data.points !== null
      };
      
      users.push(user);
      
      // Check for problematic points data
      if (data.points === undefined || 
          data.points === null || 
          typeof data.points !== 'number' ||
          isNaN(data.points)) {
        problematicUsers.push({
          ...user,
          problem: `Invalid points: ${JSON.stringify(data.points)} (type: ${typeof data.points})`
        });
      }
    });
    
    console.log('\n📈 First 10 users by points:');
    users.slice(0, 10).forEach(user => {
      console.log(`${user.index.toString().padStart(2)}. ${user.displayName} - Points: ${user.points} (${user.pointsType})`);
    });
    
    if (problematicUsers.length > 0) {
      console.log('\n❌ PROBLEMATIC USERS FOUND:');
      problematicUsers.forEach(user => {
        console.log(`  ${user.index}. ${user.displayName} (${user.id}) - ${user.problem}`);
      });
    } else {
      console.log('\n✅ No obviously problematic user data found in top 50 users.');
    }
    
    // Check around the 30th position specifically
    if (users.length >= 30) {
      const user30 = users[29]; // 0-indexed, so 29 is the 30th user
      console.log(`\n🎯 30th User Analysis:`);
      console.log(`  Name: ${user30.displayName}`);
      console.log(`  Points: ${user30.points} (${user30.pointsType})`);
      console.log(`  Has Points Field: ${user30.hasPoints}`);
      
      if (!user30.hasPoints || typeof user30.points !== 'number' || isNaN(user30.points)) {
        console.log(`  ❌ THIS IS LIKELY THE "POISON PILL" USER!`);
      } else {
        console.log(`  ✅ This user's points data looks valid.`);
      }
    }
    
    // Check for users without any points field
    const noPointsUsers = users.filter(u => !u.hasPoints);
    if (noPointsUsers.length > 0) {
      console.log(`\n⚠️  Users without points field: ${noPointsUsers.length}`);
      noPointsUsers.slice(0, 5).forEach(user => {
        console.log(`  - ${user.displayName} (${user.id})`);
      });
    }
    
    // Summary statistics
    const validPoints = users.filter(u => u.hasPoints && typeof u.points === 'number' && !isNaN(u.points));
    console.log(`\n📊 Summary:`);
    console.log(`  Total users analyzed: ${users.length}`);
    console.log(`  Users with valid points: ${validPoints.length}`);
    console.log(`  Users with invalid/missing points: ${users.length - validPoints.length}`);
    
  } catch (error) {
    console.error('❌ Error during diagnosis:', error);
  } finally {
    await admin.app().delete();
  }
}

// Run the diagnosis
diagnoseUserData().then(() => {
  console.log('\n🏁 Diagnosis complete.');
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});