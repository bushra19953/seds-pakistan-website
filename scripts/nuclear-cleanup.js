const admin = require('firebase-admin');
const serviceAccount = require('../seds-pakistan-service-account.json');

// Initialize Admin SDK
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

async function nuclearCleanup() {
  console.log('☢️ NUCLEAR CLEANUP V2: THE AGGRESSIVE PURGE ☢️');
  
  try {
    // 1. Purge 'roles' collection
    const rolesSnap = await db.collection('roles').get();
    let rolesPurged = 0;
    
    for (const doc of rolesSnap.docs) {
      const data = doc.data();
      const role = String(data.role || '').toLowerCase();
      const uid = doc.id;
      
      if (uid === FOUNDER_UID) {
        if (role !== 'superadmin') {
          console.log(`[RESTORING] Founder ${uid} to 'superadmin' status.`);
          await db.collection('roles').doc(uid).set({
            role: 'superadmin',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            reason: 'Nuclear Lockdown: Restoring absolute authority'
          }, { merge: true });
        }
        continue;
      }
      
      // AGGRESSIVE MATCHING: Catch superadmin, super-admin, president_national, president-national, etc.
      if (role.includes('admin') || role.includes('president')) {
        console.log(`[PURGE] Demoting unauthorized role '${data.role}': ${uid}`);
        await db.collection('roles').doc(uid).update({
          role: 'member',
          demotedAt: admin.firestore.FieldValue.serverTimestamp(),
          reason: 'Nuclear Overhaul V2: Aggressive Purge'
        });
        rolesPurged++;
      }
    }

    // 2. Purge 'users' collection (denormalized roles)
    const usersSnap = await db.collection('users').get();
    let usersPurged = 0;
    
    for (const doc of usersSnap.docs) {
      const data = doc.data();
      const displayRole = String(data.displayRole || '').toLowerCase();
      const uid = doc.id;
      
      if (uid === FOUNDER_UID) {
        if (!displayRole.includes('president')) {
          console.log(`[RESTORING] Founder ${uid} displayRole to 'president_national'.`);
          await db.collection('users').doc(uid).update({
            displayRole: 'president_national'
          });
        }
        continue;
      }
      
      if (displayRole.includes('admin') || displayRole.includes('president')) {
        console.log(`[PURGE] Scrubbing unauthorized displayRole '${data.displayRole}' from: ${uid}`);
        await db.collection('users').doc(uid).update({
          displayRole: 'member'
        });
        usersPurged++;
      }
    }

    console.log('────────────────────────────────────────────────');
    console.log(`✅ Roles collection: ${rolesPurged} unauthorized admins purged.`);
    console.log(`✅ Users collection: ${usersPurged} display roles scrubbed.`);
    console.log('────────────────────────────────────────────────');
    console.log('☢️ NUCLEAR CLEANUP V2 COMPLETE ☢️');
  } catch (error) {
    console.error('❌ CLEANUP FAILED:', error);
  }
}

nuclearCleanup();
