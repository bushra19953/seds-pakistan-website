const admin = require('firebase-admin');
const serviceAccount = require('../seds-pakistan-service-account.json');

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const targetEmails = ['maheeraf610@gmail.com', 'bushrarahman7766@gmail.com', '199.bushrarahman@gmail.com'];

async function diagnose() {
  console.log('=== SYSTEMATIC DEBUGGING: DATA STATE INVESTIGATION ===');
  
  for (const email of targetEmails) {
    console.log(`\nChecking user: ${email}`);
    
    // Check 'users' collection
    const userSnap = await db.collection('users').where('email', '==', email).get();
    if (userSnap.empty) {
      console.log(`- [!] No document in 'users' collection for ${email}`);
    } else {
      const userDoc = userSnap.docs[0];
      const userData = userDoc.data();
      const uid = userDoc.id;
      console.log(`- UID: ${uid}`);
      console.log(`- users/${uid} displayRole: "${userData.displayRole}"`);
      
      // Check 'roles' collection
      const roleSnap = await db.collection('roles').doc(uid).get();
      if (roleSnap.exists) {
        console.log(`- roles/${uid} role: "${roleSnap.data().role}"`);
      } else {
        console.log(`- [!] No document in 'roles' collection for ${uid}`);
      }
    }
  }
}

diagnose();
