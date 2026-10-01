#!/usr/bin/env node

/**
 * SEDS Pakistan - Role Assignment Script
 * 
 * Usage: node scripts/assign-test-role.js <email> <role> <reason>
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const fs = require('fs');

function loadServiceAccount() {
  const possiblePaths = [
    path.join(process.cwd(), 'service-account-key.json'),
    path.join(process.cwd(), 'firebase-service-account.json'),
    path.join(process.cwd(), 'serviceAccountKey.json'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('Service account key not found');
}

async function assignRole(email, role, reason) {
  console.log(`🔐 Assigning role '${role}' to ${email}...`);
  
  const serviceAccount = loadServiceAccount();
  const app = initializeApp({
    credential: cert(serviceAccount),
  });

  const db = getFirestore(app);
  const auth = getAuth(app);

  try {
    const user = await auth.getUserByEmail(email);
    console.log(`✅ Found user: ${user.uid}`);

    // Update roles collection
    await db.collection('roles').doc(user.uid).set({
      role,
      grantedBy: 'system-script',
      grantedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Update users collection
    await db.collection('users').doc(user.uid).set({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      displayRole: role,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Set custom claim
    await auth.setCustomUserClaims(user.uid, { role });

    console.log(`\n🎉 SUCCESS! Role '${role}' assigned to ${email}`);
    
    // Log audit entry
    await db.collection('audit_logs').add({
      action: 'assign_role',
      performedBy: 'system-script',
      targetUid: user.uid,
      details: {
        newRole: role,
        reason: reason || 'Manual assignment via script',
      },
      timestamp: FieldValue.serverTimestamp(),
    });

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    process.exit(1);
  }
  process.exit(0);
}

const [email, role, reason] = process.argv.slice(2);
if (!email || !role) {
  console.error('Usage: node scripts/assign-test-role.js <email> <role> [reason]');
  process.exit(1);
}

assignRole(email, role, reason);
