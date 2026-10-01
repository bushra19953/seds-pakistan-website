const { getDb } = require('../src/lib/server/firebase-admin');

async function checkUserData() {
  const userId = 'hR0GvZW9t7SM52XsyCSncM5eF4y2';
  
  console.log(`🔍 Checking data for user: ${userId}`);
  
  const db = getDb();
  if (!db) {
    console.error('❌ Database not available');
    return;
  }
  
  try {
    // 1. Check user profile
    console.log('\n📋 User Profile:');
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists) {
      console.log('✅ User profile exists:', JSON.stringify(userDoc.data(), null, 2));
    } else {
      console.log('❌ User profile not found');
    }
    
    // 2. Check projects
    console.log('\n🏗️ Projects:');
    const projectsSnap = await db.collection('projects')
      .where('members', 'array-contains', userId)
      .get();
    console.log(`Found ${projectsSnap.docs.length} projects`);
    projectsSnap.docs.forEach((doc, i) => {
      console.log(`  Project ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // 3. Check certificates
    console.log('\n📜 Certificates:');
    const certificatesSnap = await db.collection('certificates')
      .where('userId', '==', userId)
      .get();
    console.log(`Found ${certificatesSnap.docs.length} certificates`);
    certificatesSnap.docs.forEach((doc, i) => {
      console.log(`  Certificate ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // 4. Check warnings
    console.log('\n⚠️ Warnings:');
    const warningsSnap = await db.collection('users').doc(userId).collection('warnings').get();
    console.log(`Found ${warningsSnap.docs.length} warnings`);
    warningsSnap.docs.forEach((doc, i) => {
      console.log(`  Warning ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // 5. Check tasks with both query patterns
    console.log('\n📋 Tasks (assigneeId):');
    try {
      const tasksAssigneeIdSnap = await db.collection('tasks')
        .where('assigneeId', '==', userId)
        .get();
      console.log(`Found ${tasksAssigneeIdSnap.docs.length} tasks with assigneeId`);
      tasksAssigneeIdSnap.docs.forEach((doc, i) => {
        console.log(`  Task ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
      });
    } catch (error) {
      console.log('Error with assigneeId query:', error.message);
    }
    
    console.log('\n📋 Tasks (assigneeIds):');
    try {
      const tasksAssigneeIdsSnap = await db.collection('tasks')
        .where('assigneeIds', 'array-contains', userId)
        .get();
      console.log(`Found ${tasksAssigneeIdsSnap.docs.length} tasks with assigneeIds`);
      tasksAssigneeIdsSnap.docs.forEach((doc, i) => {
        console.log(`  Task ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
      });
    } catch (error) {
      console.log('Error with assigneeIds query:', error.message);
    }
    
    // 6. Check badges
    console.log('\n🏆 Badges:');
    if (userDoc.exists && userDoc.data()?.badges) {
      console.log('User has badges in profile:', userDoc.data().badges);
      
      if (Array.isArray(userDoc.data().badges) && userDoc.data().badges.length > 0) {
        const badgeSlugs = userDoc.data().badges.slice(0, 10);
        const badgesSnap = await db.collection('badges')
          .where('slug', 'in', badgeSlugs)
          .get();
        console.log(`Found ${badgesSnap.docs.length} badge definitions`);
        badgesSnap.docs.forEach((doc, i) => {
          console.log(`  Badge ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
        });
      }
    } else {
      console.log('No badges found in user profile');
    }
    
    // 7. Check chapters
    console.log('\n🏛️ Chapters:');
    const chaptersSnap = await db.collection('chapters')
      .where('isActive', '==', true)
      .get();
    console.log(`Found ${chaptersSnap.docs.length} active chapters`);
    chaptersSnap.docs.forEach((doc, i) => {
      console.log(`  Chapter ${i + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    console.log('\n✅ Data check completed!');
    
  } catch (error) {
    console.error('❌ Error checking user data:', error);
  }
}

// Run the check
checkUserData();