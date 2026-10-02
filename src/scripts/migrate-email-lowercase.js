#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CJS maintenance script; require is correct here */
/**
 * MIGRATION SCRIPT: Populate email_lowercase field for existing users
 * 
 * This script adds the email_lowercase field to all existing users in Firestore
 * to enable flexible, case-insensitive search functionality.
 * 
 * Usage: node src/scripts/migrate-email-lowercase.js
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'seds-pakistan',
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

async function migrateEmailLowercase() {
  console.log('🔄 Starting email_lowercase migration...');
  
  try {
    // Get all users collection
    const usersSnapshot = await db.collection('users').get();
    
    if (usersSnapshot.empty) {
      console.log('ℹ️ No users found in the database.');
      return;
    }
    
    console.log(`📊 Found ${usersSnapshot.size} users to process.`);
    
    let processed = 0;
    let updated = 0;
    let errors = 0;
    
    // Process users in batches
    const batch = db.batch();
    const batchSize = 400; // Firestore batch limit
    
    for (const doc of usersSnapshot.docs) {
      try {
        const userData = doc.data();
        const email = userData.email;
        
        // Skip if no email or email_lowercase already exists and is correct
        if (!email) {
          processed++;
          continue;
        }
        
        const expectedEmailLowercase = email.toLowerCase();
        const currentEmailLowercase = userData.email_lowercase;
        
        // Only update if email_lowercase is missing or incorrect
        if (!currentEmailLowercase || currentEmailLowercase !== expectedEmailLowercase) {
          const userRef = db.collection('users').doc(doc.id);
          batch.update(userRef, {
            email_lowercase: expectedEmailLowercase,
            updatedAt: new Date(),
          });
          updated++;
        }
        
        processed++;
        
        // Commit batch when we reach the limit
        if (batch._ops && batch._ops.length >= batchSize) {
          console.log(`🔄 Committing batch (${processed}/${usersSnapshot.size} processed)...`);
          await batch.commit();
          batch._ops = []; // Reset batch operations
        }
        
      } catch (error) {
        console.error(`❌ Error processing user ${doc.id}:`, error);
        errors++;
      }
    }
    
    // Commit any remaining operations
    if (batch._ops && batch._ops.length > 0) {
      console.log('🔄 Committing final batch...');
      await batch.commit();
    }
    
    console.log('\n✅ Migration completed!');
    console.log(`📈 Statistics:`);
    console.log(`   • Total users processed: ${processed}`);
    console.log(`   • Users updated: ${updated}`);
    console.log(`   • Users skipped: ${processed - updated}`);
    console.log(`   • Errors: ${errors}`);
    console.log(`   • Success rate: ${((processed - errors) / processed * 100).toFixed(1)}%`);
    
    // Verify the migration
    console.log('\n🔍 Verifying migration...');
    const verificationSnapshot = await db.collection('users')
      .where('email_lowercase', '==', null)
      .limit(10)
      .get();
    
    if (verificationSnapshot.empty) {
      console.log('✅ Verification passed: All users have email_lowercase field');
    } else {
      console.log(`⚠️ Verification found ${verificationSnapshot.size} users without email_lowercase`);
      verificationSnapshot.forEach(doc => {
        const data = doc.data();
        console.log(`   • User ${doc.id}: email="${data.email}", email_lowercase="${data.email_lowercase}"`);
      });
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run the migration
if (require.main === module) {
  migrateEmailLowercase()
    .then(() => {
      console.log('\n🎉 Migration script completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateEmailLowercase };