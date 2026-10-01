#!/usr/bin/env node

/**
 * SEDS Pakistan - Auth User Creation Script
 * 
 * Usage: node scripts/create-test-auth-user.js <email> <password> <displayName>
 */

const { initializeApp, cert } = require('firebase-admin/app');
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

async function createUser(email, password, displayName) {
  console.log(`👤 Creating user '${displayName}' (${email})...`);
  
  const serviceAccount = loadServiceAccount();
  const app = initializeApp({
    credential: cert(serviceAccount),
  });

  const auth = getAuth(app);

  try {
    const user = await auth.createUser({
      email,
      password,
      displayName,
      emailVerified: true,
    });
    console.log(`\n🎉 SUCCESS! User created: ${user.uid}`);
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    process.exit(1);
  }
  process.exit(0);
}

const [email, password, displayName] = process.argv.slice(2);
if (!email || !password || !displayName) {
  console.error('Usage: node scripts/create-test-auth-user.js <email> <password> <displayName>');
  process.exit(1);
}

createUser(email, password, displayName);
