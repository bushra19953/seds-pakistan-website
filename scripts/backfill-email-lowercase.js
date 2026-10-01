#!/usr/bin/env node

/**
 * 🔍 SEARCH BACKFILL SCRIPT: Populate email_lowercase field for existing users
 * 
 * This script ensures all existing users have the email_lowercase field populated
 * so the new flexible search functionality works for all users, not just new ones.
 * 
 * Run with: node scripts/backfill-email-lowercase.js
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  // Use service account if available, otherwise use application default
  if (admin.credential) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: 'seds-pakistan'
    });
  } else {
    admin.initializeApp();
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin:', error.message);
  process.exit(1);
}

const db = admin.firestore();

async function backfillEmailLowercase() {
  try {
    console.log('🔄 Starting email_lowercase backfill process...');
    
    // Get all users
    const usersSnapshot = await db.collection('users').get();
    const users = usersSnapshot.docs;
    
    console.log(`📊 Found ${users.length} users to process`);
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // Process users in batches of 500 (Firestore limit)
    const batchSize = 500;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = db.batch();
      const batchUsers = users.slice(i, i + batchSize);
      
      console.log(`\n🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(users.length / batchSize)} (${batchUsers.length} users)`);
      
      for (const userDoc of batchUsers) {
        try {
          const userData = userDoc.data();
          const email = userData.email;
          const emailLowercase = userData.email_lowercase;
          
          // Skip if no email
          if (!email) {
            console.log(`⏭️  Skipping user ${userDoc.id} - no email`);
            skippedCount++;
            continue;
          }
          
          // Check if email_lowercase is missing or different
          const expectedLowercase = email.toLowerCase();
          if (!emailLowercase || emailLowercase !== expectedLowercase) {
            // Update the document
            batch.update(userDoc.ref, {
              email_lowercase: expectedLowercase,
              updatedAt: new Date(),
            });
            
            console.log(`✅ Will update user ${userDoc.id}: "${email}" -> "${expectedLowercase}"`);
            updatedCount++;
          } else {
            console.log(`✅ User ${userDoc.id} already has correct email_lowercase`);
            skippedCount++;
          }
          
        } catch (error) {
          console.error(`❌ Error processing user ${userDoc.id}:`, error.message);
          errorCount++;
        }
      }
      
      // Commit the batch
      await batch.commit();
      console.log(`✅ Committed batch ${Math.floor(i / batchSize) + 1}`);
    }
    
    console.log('\n🎉 Backfill process completed!');
    console.log(`📊 Results:`);
    console.log(`   ✅ Updated: ${updatedCount} users`);
    console.log(`   ⏭️  Skipped: ${skippedCount} users`);
    console.log(`   ❌ Errors: ${errorCount} users`);
    
    if (updatedCount > 0) {
      console.log('\n✅ SUCCESS: All existing users now have email_lowercase field populated!');
      console.log('🔍 The search functionality will now work for all users.');
    } else {
      console.log('\nℹ️  INFO: All users already had email_lowercase field populated.');
    }
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR during backfill:', error);
    process.exit(1);
  } finally {
    await admin.app().delete();
    console.log('\n🧹 Cleaned up Firebase Admin connection');
  }
}

// Run the backfill
if (require.main === module) {
  backfillEmailLowercase().then(() => {
    console.log('\n🎯 Script completed successfully');
    process.exit(0);
  }).catch((error) => {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  });
}

module.exports = { backfillEmailLowercase };