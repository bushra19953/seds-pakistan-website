/**
 * 🔍 POISON PILL DATA DETECTION & CLEANUP SCRIPT
 * 
 * This script identifies and fixes "poison pill" documents in the users collection
 * that have invalid 'points' fields causing Firestore queries to hang indefinitely.
 * 
 * SYMPTOMS:
 * - Leaderboard pagination hangs on page 3+
 * - Firestore queries never complete
 * - Users see loading skeletons indefinitely
 * 
 * ROOT CAUSE:
 * - Documents with null, undefined, or object-type 'points' fields
 * - Invalid data types that break Firestore ordering
 * 
 * SOLUTION:
 * - Identify all problematic documents
 * - Fix their 'points' field to valid numbers
 * - Validate data integrity
 */

const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, updateDoc, orderBy, query, limit } = require('firebase/firestore');

// Inline Firebase config for script compatibility
const firebaseConfig = {
  apiKey: "AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg",
  authDomain: "seds-pakistan.firebaseapp.com",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.appspot.com",
  messagingSenderId: "884993774057",
  appId: "1:884993774057:web:50eb3cd3917dc61045fb78",
  measurementId: "G-HJ0LZD8K4B"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

class PoisonPillDetector {
  constructor() {
    this.problematicDocs = [];
    this.fixedDocs = [];
    this.stats = {
      totalUsers: 0,
      validPoints: 0,
      invalidPoints: 0,
      fixedCount: 0,
      errorCount: 0
    };
  }

  // 🔍 Detect all documents with invalid points
  async detectPoisonPills() {
    console.log('🔍 [DETECTOR] Starting comprehensive data validation scan...');
    console.log('⏰ Starting scan at:', new Date().toISOString());
    
    try {
      // First, get total count
      const countQuery = query(collection(db, 'users'), orderBy('points', 'desc'), limit(1000));
      const snapshot = await getDocs(countQuery);
      
      console.log(`📊 [DETECTOR] Scanning ${snapshot.size} user documents...`);
      
      for (let i = 0; i < snapshot.docs.length; i++) {
        const doc = snapshot.docs[i];
        const data = doc.data();
        this.stats.totalUsers++;
        
        // Check for invalid points
        const points = data.points;
        const isValid = this.validatePointsField(points, data);
        
        if (!isValid.valid) {
          this.problematicDocs.push({
            id: doc.id,
            data: data,
            issue: isValid.issue,
            suggestedFix: isValid.suggestedFix
          });
          this.stats.invalidPoints++;
          
          console.log(`🚨 [DETECTOR] POISON PILL FOUND at position ${i + 1}:`, {
            userId: doc.id,
            displayName: data.displayName || data.name || 'Unknown',
            issue: isValid.issue,
            currentValue: points,
            type: typeof points
          });
        } else {
          this.stats.validPoints++;
        }
        
        // Progress indicator
        if ((i + 1) % 50 === 0) {
          console.log(`📈 [DETECTOR] Progress: ${i + 1}/${snapshot.size} documents scanned`);
        }
      }
      
      console.log(`✅ [DETECTOR] Scan completed! Results:`, {
        totalUsers: this.stats.totalUsers,
        validPoints: this.stats.validPoints,
        invalidPoints: this.stats.invalidPoints,
        poisonPillPercentage: ((this.stats.invalidPoints / this.stats.totalUsers) * 100).toFixed(2) + '%'
      });
      
      return this.problematicDocs;
      
    } catch (error) {
      console.error('❌ [DETECTOR] Scan failed:', error);
      throw error;
    }
  }

  // 🔍 Validate a single points field
  validatePointsField(points, userData) {
    // Check for null
    if (points === null) {
      return {
        valid: false,
        issue: 'Points field is null',
        suggestedFix: 0
      };
    }
    
    // Check for undefined
    if (points === undefined) {
      return {
        valid: false,
        issue: 'Points field is undefined',
        suggestedFix: 0
      };
    }
    
    // Check for object type (should not happen)
    if (typeof points === 'object' && points !== null) {
      return {
        valid: false,
        issue: 'Points field is an object',
        suggestedFix: 0
      };
    }
    
    // Check for string that can be converted to number
    if (typeof points === 'string') {
      const numValue = Number(points);
      if (isNaN(numValue)) {
        return {
          valid: false,
          issue: 'Points field is a non-numeric string',
          suggestedFix: 0
        };
      }
      return { valid: true };
    }
    
    // Check for number
    if (typeof points === 'number') {
      if (isNaN(points)) {
        return {
          valid: false,
          issue: 'Points field is NaN',
          suggestedFix: 0
        };
      }
      return { valid: true };
    }
    
    // Any other type is invalid
    return {
      valid: false,
      issue: `Points field has invalid type: ${typeof points}`,
      suggestedFix: 0
    };
  }

  // 🔧 Fix a single problematic document
  async fixPoisonPill(docId, issue, suggestedFix = 0) {
    try {
      console.log(`🔧 [FIXER] Fixing document ${docId}...`);
      
      const docRef = doc(db, 'users', docId);
      await updateDoc(docRef, { points: suggestedFix });
      
      this.fixedDocs.push({
        id: docId,
        fixedTo: suggestedFix,
        previousIssue: issue
      });
      this.stats.fixedCount++;
      
      console.log(`✅ [FIXER] Successfully fixed ${docId}, set points to ${suggestedFix}`);
      return true;
      
    } catch (error) {
      console.error(`❌ [FIXER] Failed to fix ${docId}:`, error);
      this.stats.errorCount++;
      return false;
    }
  }

  // 🔧 Fix all problematic documents
  async fixAllPoisonPills() {
    if (this.problematicDocs.length === 0) {
      console.log('🎉 [FIXER] No poison pills found - all data is clean!');
      return;
    }
    
    console.log(`🔧 [FIXER] Starting to fix ${this.problematicDocs.length} problematic documents...`);
    console.log('⏰ Fix operation started at:', new Date().toISOString());
    
    for (const docInfo of this.problematicDocs) {
      const success = await this.fixPoisonPill(docInfo.id, docInfo.issue, docInfo.suggestedFix);
      
      if (success) {
        // Small delay to avoid overwhelming Firestore
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log('🔧 [FIXER] Fix operation completed! Results:', {
      attempted: this.problematicDocs.length,
      successful: this.fixedDocs.length,
      failed: this.stats.errorCount
    });
  }

  // 🔍 Verify the fix by running a test query
  async verifyFix() {
    console.log('🔍 [VERIFIER] Testing query performance after fixes...');
    console.time('Verification Query');
    
    try {
      const testQuery = query(collection(db, 'users'), orderBy('points', 'desc'), limit(50));
      const snapshot = await getDocs(testQuery);
      
      console.timeEnd('Verification Query');
      console.log(`✅ [VERIFIER] Test query successful! Found ${snapshot.size} documents`);
      console.log('🔍 [VERIFIER] First few documents:');
      
      for (let i = 0; i < Math.min(3, snapshot.docs.length); i++) {
        const doc = snapshot.docs[i];
        const data = doc.data();
        console.log(`   ${i + 1}. ${data.displayName || 'Unknown'}: ${data.points} points`);
      }
      
      return true;
      
    } catch (error) {
      console.timeEnd('Verification Query');
      console.error('❌ [VERIFIER] Verification query failed:', error);
      return false;
    }
  }

  // 📊 Generate comprehensive report
  generateReport() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 POISON PILL DETECTION & CLEANUP REPORT');
    console.log('='.repeat(60));
    
    console.log('\n📈 SCAN STATISTICS:');
    console.log(`  Total Users Scanned: ${this.stats.totalUsers}`);
    console.log(`  Valid Points Fields: ${this.stats.validPoints} (${((this.stats.validPoints/this.stats.totalUsers)*100).toFixed(1)}%)`);
    console.log(`  Invalid Points Fields: ${this.stats.invalidPoints} (${((this.stats.invalidPoints/this.stats.totalUsers)*100).toFixed(1)}%)`);
    console.log(`  Documents Fixed: ${this.stats.fixedCount}`);
    console.log(`  Fix Errors: ${this.stats.errorCount}`);
    
    if (this.problematicDocs.length > 0) {
      console.log('\n🚨 PROBLEMATIC DOCUMENTS:');
      this.problematicDocs.forEach((doc, index) => {
        console.log(`  ${index + 1}. User ID: ${doc.id}`);
        console.log(`     Display Name: ${doc.data.displayName || doc.data.name || 'Unknown'}`);
        console.log(`     Issue: ${doc.issue}`);
        console.log(`     Current Value: ${doc.data.points}`);
        console.log(`     Suggested Fix: ${doc.suggestedFix}`);
        console.log('');
      });
    }
    
    if (this.fixedDocs.length > 0) {
      console.log('✅ FIXED DOCUMENTS:');
      this.fixedDocs.forEach((doc, index) => {
        console.log(`  ${index + 1}. User ID: ${doc.id} → Points: ${doc.fixedTo}`);
      });
    }
    
    console.log('\n🎯 RECOMMENDATIONS:');
    console.log('  1. Review and fix all identified problematic documents');
    console.log('  2. Implement Firestore security rules to prevent future issues');
    console.log('  3. Add data validation in user registration/profile updates');
    console.log('  4. Run this script periodically to maintain data quality');
    
    console.log('\n' + '='.repeat(60));
  }

  // 🔄 Main execution flow
  async run() {
    try {
      console.log('🚀 Starting Poison Pill Detection & Cleanup...');
      
      // Step 1: Detect problematic documents
      await this.detectPoisonPills();
      
      // Step 2: Fix all problems
      await this.fixAllPoisonPills();
      
      // Step 3: Verify the fix
      await this.verifyFix();
      
      // Step 4: Generate report
      this.generateReport();
      
      console.log('\n🎉 Poison Pill Detection & Cleanup completed successfully!');
      
    } catch (error) {
      console.error('💥 Critical error during cleanup:', error);
      throw error;
    }
  }
}

// Execute if run directly
if (require.main === module) {
  const detector = new PoisonPillDetector();
  detector.run().catch(console.error);
}

module.exports = { PoisonPillDetector };