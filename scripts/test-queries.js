
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize with project ID
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'seds-pakistan'
  });
}

const db = getFirestore();

async function testAnnouncementsQuery() {
  console.log('🧪 Testing Announcements Query (Featured)...');
  try {
    const q = db.collection('announcements')
      .where('status', '==', 'published')
      .where('isFeatured', '==', true)
      .orderBy('updated_at', 'desc')
      .limit(8);
    
    const snapshot = await q.get();
    console.log(`✅ Success! Found ${snapshot.size} featured announcements.`);
  } catch (error) {
    console.error('❌ Featured query failed:');
    console.error(error.message);
  }

  console.log('\n🧪 Testing Announcements Query (General)...');
  try {
    const q = db.collection('announcements')
      .where('status', '==', 'published')
      .orderBy('updated_at', 'desc')
      .limit(15);
    
    const snapshot = await q.get();
    console.log(`✅ Success! Found ${snapshot.size} general announcements.`);
  } catch (error) {
    console.error('❌ General query failed:');
    console.error(error.message);
  }
}

async function testNotificationsQuery() {
    console.log('\n🧪 Testing Notifications Query...');
    // We'll test for a dummy user or just the collection structure
    try {
      // Notifications are in users/{uid}/notifications
      // The UI uses: collection(doc(db, 'users', user.uid), 'notifications'), orderBy('timestamp', 'desc'), limit(50)
      const usersSnap = await db.collection('users').limit(1).get();
      if (usersSnap.empty) {
          console.log('⚠️ No users found to test notifications.');
          return;
      }
      const uid = usersSnap.docs[0].id;
      console.log(`Testing notifications for user: ${uid}`);
      
      const q = db.collection('users').doc(uid).collection('notifications')
        .orderBy('timestamp', 'desc')
        .limit(50);
      
      const snapshot = await q.get();
      console.log(`✅ Success! Found ${snapshot.size} notifications.`);
    } catch (error) {
      console.error('❌ Query failed:');
      console.error(error.message);
    }
}

async function run() {
  await testAnnouncementsQuery();
  await testNotificationsQuery();
  process.exit(0);
}

run();
