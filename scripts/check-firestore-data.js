const admin = require('firebase-admin');

// Initialize Firebase Admin with service account
const serviceAccount = require('../service-account-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://seds-pakistan.firebaseio.com'
});

const db = admin.firestore();

async function checkUserData() {
  const userId = 'hR0GvZW9t7SM52XsyCSncM5eF4y2';
  
  console.log('🔍 Checking data for user:', userId);
  console.log('=====================================');
  
  try {
    // Check user profile
    console.log('\n1. User Profile:');
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists) {
      console.log('✅ User found:', JSON.stringify(userDoc.data(), null, 2));
    } else {
      console.log('❌ User not found');
    }
    
    // Check projects where user is a member
    console.log('\n2. Projects (where user is member):');
    const projectsSnapshot = await db.collection('projects')
      .where('members', 'array-contains', userId)
      .get();
    
    console.log(`Found ${projectsSnapshot.size} projects`);
    projectsSnapshot.forEach((doc, index) => {
      console.log(`Project ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // Check certificates
    console.log('\n3. Certificates:');
    const certificatesSnapshot = await db.collection('certificates')
      .where('userId', '==', userId)
      .get();
    
    console.log(`Found ${certificatesSnapshot.size} certificates`);
    certificatesSnapshot.forEach((doc, index) => {
      console.log(`Certificate ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // Check warnings (subcollection)
    console.log('\n4. Warnings (subcollection):');
    const warningsSnapshot = await db.collection('users')
      .doc(userId)
      .collection('warnings')
      .get();
    
    console.log(`Found ${warningsSnapshot.size} warnings`);
    warningsSnapshot.forEach((doc, index) => {
      console.log(`Warning ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // Check tasks with assigneeId
    console.log('\n5. Tasks (with assigneeId):');
    const tasksSnapshot1 = await db.collection('tasks')
      .where('assigneeId', '==', userId)
      .get();
    
    console.log(`Found ${tasksSnapshot1.size} tasks (assigneeId)`);
    tasksSnapshot1.forEach((doc, index) => {
      console.log(`Task ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // Check tasks with assigneeIds
    console.log('\n6. Tasks (with assigneeIds array):');
    const tasksSnapshot2 = await db.collection('tasks')
      .where('assigneeIds', 'array-contains', userId)
      .get();
    
    console.log(`Found ${tasksSnapshot2.size} tasks (assigneeIds)`);
    tasksSnapshot2.forEach((doc, index) => {
      console.log(`Task ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // Check badges
    console.log('\n7. Badges:');
    const badgesSnapshot = await db.collection('badges')
      .get();
    
    console.log(`Found ${badgesSnapshot.size} total badges`);
    badgesSnapshot.forEach((doc, index) => {
      console.log(`Badge ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
    // Check chapters
    console.log('\n8. Active Chapters:');
    const chaptersSnapshot = await db.collection('chapters')
      .where('status', '==', 'active')
      .get();
    
    console.log(`Found ${chaptersSnapshot.size} active chapters`);
    chaptersSnapshot.forEach((doc, index) => {
      console.log(`Chapter ${index + 1}:`, JSON.stringify(doc.data(), null, 2));
    });
    
  } catch (error) {
    console.error('Error checking data:', error);
  } finally {
    process.exit(0);
  }
}

checkUserData();