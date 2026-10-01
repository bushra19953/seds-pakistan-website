const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

// Initialize Admin SDK with the correct project ID and credential
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

async function cleanupSuperAdmins() {
  console.log('--- STARTING SUPERADMIN CLEANUP ---');
  
  try {
    // 1. Scan the 'roles' collection
    const rolesSnap = await db.collection('roles').where('role', '==', 'superadmin').get();
    
    console.log(`Found ${rolesSnap.size} accounts with functional 'superadmin' role.`);
    
    for (const doc of rolesSnap.docs) {
      if (doc.id === FOUNDER_UID) {
        console.log(`[SAFE] Skipping Founder: ${doc.id}`);
        continue;
      }
      
      console.log(`[CLEANUP] Demoting unauthorized Superadmin: ${doc.id}`);
      await db.collection('roles').doc(doc.id).update({
        role: 'member',
        demotedAt: admin.firestore.FieldValue.serverTimestamp(),
        reason: 'Nuclear Overhaul: Singular Superadmin Policy'
      });
      
      // Also update displayRole if it exists on the user document
      await db.collection('users').doc(doc.id).update({
        displayRole: 'member'
      }).catch(() => {});
    }

    // 2. Scan the 'roles' collection for 'president_national'
    const presidentSnap = await db.collection('roles').where('role', '==', 'president_national').get();
    console.log(`Found ${presidentSnap.size} accounts with functional 'president_national' role.`);
    
    for (const doc of presidentSnap.docs) {
      if (doc.id === FOUNDER_UID) {
        console.log(`[SAFE] Skipping Founder: ${doc.id}`);
        continue;
      }
      
      console.log(`[CLEANUP] Demoting unauthorized President: ${doc.id}`);
      await db.collection('roles').doc(doc.id).update({
        role: 'member',
        demotedAt: admin.firestore.FieldValue.serverTimestamp(),
        reason: 'Nuclear Overhaul: Singular President Policy'
      });
      
      await db.collection('users').doc(doc.id).update({
        displayRole: 'member'
      }).catch(() => {});
    }

    console.log('--- CLEANUP COMPLETE ---');
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
}

cleanupSuperAdmins();
