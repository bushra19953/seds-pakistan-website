#!/usr/bin/env node

/**
 * SEDS Pakistan - Superadmin Creation Script
 * 
 * This script securely creates a superadmin role for an existing Firebase Auth user.
 * It should only be run from a trusted development/production environment.
 * 
 * Usage: node scripts/create-superadmin.js <email>
 * Example: node scripts/create-superadmin.js admin@example.com
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const fs = require('fs');

// Configuration
const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'service-account-key.json');
const FIREBASE_CONFIG_PATH = path.join(process.cwd(), 'firebase-config.json');

// Helper function to load Firebase configuration
function loadFirebaseConfig() {
  // Try to load from environment variables first
  const config = {
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

  // If any required config is missing, try to load from firebase-config.json
  const requiredFields = ['projectId'];
  const missingFields = requiredFields.filter(field => !config[field]);
  
  if (missingFields.length > 0) {
    try {
      if (fs.existsSync(FIREBASE_CONFIG_PATH)) {
        const fileConfig = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf8'));
        Object.assign(config, fileConfig);
      }
    } catch (error) {
      console.warn('⚠️  Could not load firebase-config.json:', error.message);
    }
  }

  return config;
}

// Helper function to load service account
function loadServiceAccount() {
  // Try multiple paths for service account key
  const possiblePaths = [
    SERVICE_ACCOUNT_PATH,
    path.join(process.cwd(), 'firebase-service-account.json'),
    path.join(process.cwd(), 'serviceAccountKey.json'),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ].filter(Boolean);

  for (const serviceAccountPath of possiblePaths) {
    try {
      if (fs.existsSync(serviceAccountPath)) {
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

// Main function
async function createSuperadmin(email) {
  console.log('🔐 SEDS Pakistan - Superadmin Creation Script');
  console.log('================================================');
  
  try {
    // Validate email
    if (!email || !email.includes('@')) {
      throw new Error('Please provide a valid email address');
    }

    console.log(`📧 Looking for user with email: ${email}`);

    // Load configuration and initialize Firebase Admin
    const config = loadFirebaseConfig();
    const serviceAccount = loadServiceAccount();

    // Initialize Firebase Admin SDK
    const app = initializeApp({
      credential: cert(serviceAccount),
      projectId: config.projectId,
      databaseURL: `https://${config.projectId}.firebaseio.com`,
    });

    const db = getFirestore(app);
    const auth = getAuth(app);

    console.log(`🔍 Searching for Firebase Auth user...`);

    // Find user by email
    let user;
    try {
      user = await auth.getUserByEmail(email);
      console.log(`✅ Found user: ${user.uid} (${user.email})`);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        throw new Error(`
❌ No Firebase Auth user found with email: ${email}

To create a superadmin:
1. First, sign up on the website with this email address
2. Then run this script again with the same email

The user must exist in Firebase Authentication before assigning roles.
`);
      }
      throw error;
    }

    console.log(`📝 Creating superadmin role for user: ${user.uid}`);

    // Create role document
    const roleDoc = {
      role: 'superadmin',
      isSuperAdmin: true,
      isAdmin: true,
      isTeamLeader: true,
      isBlogWriter: true,
      isMember: true,
      isCurator: true,
      isModerator: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'system-script',
    };

    // Create user document (if it doesn't exist)
    const userDoc = {
      uid: user.uid,
      email: user.email,
      email_lowercase: (user.email || '').toLowerCase(),
      displayName: user.displayName || email.split('@')[0],
      role: 'superadmin',
      createdAt: user.metadata.creationTime ? new Date(user.metadata.creationTime) : new Date(),
      updatedAt: new Date(),
    };

    // Use batch write for atomic operation
    const batch = db.batch();
    
    // Set role document
    batch.set(db.collection('roles').doc(user.uid), roleDoc, { merge: true });
    
    // Set user document (merge to preserve existing data)
    batch.set(db.collection('users').doc(user.uid), userDoc, { merge: true });

    // Commit the batch
    await batch.commit();

    console.log('\n🎉 SUCCESS! Superadmin role created!');
    console.log('=====================================');
    console.log(`User UID: ${user.uid}`);
    console.log(`Email: ${user.email}`);
    console.log(`Display Name: ${userDoc.displayName}`);
    console.log(`Role: superadmin`);
    console.log(`Created At: ${roleDoc.createdAt.toISOString()}`);
    console.log('');
    console.log('✅ The user now has full administrative privileges:');
    console.log('   - Access to /admin/superadmin dashboard');
    console.log('   - Can create and manage other admin accounts');
    console.log('   - Full control over all content and users');
    console.log('   - Can review induction applications');
    console.log('   - Can manage projects, events, and blogs');

    // Verify the role was created
    console.log('\n🔍 Verifying role creation...');
    const createdRole = await db.collection('roles').doc(user.uid).get();
    if (createdRole.exists && createdRole.data().role === 'superadmin') {
      console.log('✅ Role verification: PASSED');
    } else {
      console.log('❌ Role verification: FAILED');
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    process.exit(1);
  }

  console.log('\n🚀 The user can now log in and access the admin dashboard!');
  process.exit(0);
}

// Script entry point
if (require.main === module) {
  const email = process.argv[2];
  
  if (!email) {
    console.error(`
❌ Usage: node scripts/create-superadmin.js <email>

Example:
  node scripts/create-superadmin.js admin@example.com

Instructions:
1. First, sign up on the website with your desired admin email
2. Then run this script to elevate that account to superadmin
`);
    process.exit(1);
  }

  createSuperadmin(email);
}

module.exports = { createSuperadmin };