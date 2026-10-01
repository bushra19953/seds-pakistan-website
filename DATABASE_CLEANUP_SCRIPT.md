# Database Cleanup Script - Fix Invalid Author/Category IDs

## Purpose
This document provides scripts to identify and fix invalid `authorId` and `categoryId` values in your Firestore `blogs` collection.

## Problem
Blog posts with empty, null, or invalid author/category IDs cause the Select components to crash, triggering:
1. The `<SelectItem>` crash (invalid value prop)
2. The React hooks violation (error boundary changes render tree)

## Solution
Run these scripts to clean up your database.

---

## Script 1: Identify Bad Data (Read-Only)

This script scans your database and reports all blog posts with invalid IDs **without making any changes**.

### Create: `scripts/identify-bad-blog-data.js`

```javascript
/**
 * Identify Bad Blog Data Script
 * Run with: node scripts/identify-bad-blog-data.js
 */

const admin = require('firebase-admin');
const serviceAccount = require('../path/to/your/serviceAccountKey.json');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function identifyBadData() {
  console.log('🔍 Scanning blogs collection for invalid data...\n');
  
  const blogsRef = db.collection('blogs');
  const snapshot = await blogsRef.get();
  
  const issues = {
    invalidAuthorId: [],
    invalidCategoryId: [],
    missingAuthorName: [],
    missingCategoryName: []
  };
  
  snapshot.forEach((doc) => {
    const data = doc.data();
    const docId = doc.id;
    
    // Check authorId
    if (!data.authorId || typeof data.authorId !== 'string' || data.authorId.trim() === '') {
      issues.invalidAuthorId.push({
        docId,
        title: data.title || 'Untitled',
        authorId: data.authorId,
        authorName: data.authorName
      });
    }
    
    // Check categoryId
    if (!data.categoryId || typeof data.categoryId !== 'string' || data.categoryId.trim() === '') {
      issues.invalidCategoryId.push({
        docId,
        title: data.title || 'Untitled',
        categoryId: data.categoryId,
        categoryName: data.categoryName
      });
    }
    
    // Check authorName
    if (!data.authorName || data.authorName.trim() === '') {
      issues.missingAuthorName.push({
        docId,
        title: data.title || 'Untitled',
        authorId: data.authorId
      });
    }
    
    // Check categoryName
    if (!data.categoryName || data.categoryName.trim() === '') {
      issues.missingCategoryName.push({
        docId,
        title: data.title || 'Untitled',
        categoryId: data.categoryId
      });
    }
  });
  
  // Report findings
  console.log('📊 SCAN RESULTS\n');
  console.log(`Total blog posts scanned: ${snapshot.size}\n`);
  
  if (issues.invalidAuthorId.length > 0) {
    console.log('🚨 INVALID AUTHOR IDs:', issues.invalidAuthorId.length);
    issues.invalidAuthorId.forEach(issue => {
      console.log(`  - Doc: ${issue.docId}`);
      console.log(`    Title: ${issue.title}`);
      console.log(`    Author ID: ${JSON.stringify(issue.authorId)}`);
      console.log(`    Author Name: ${issue.authorName}\n`);
    });
  } else {
    console.log('✅ All author IDs are valid\n');
  }
  
  if (issues.invalidCategoryId.length > 0) {
    console.log('🚨 INVALID CATEGORY IDs:', issues.invalidCategoryId.length);
    issues.invalidCategoryId.forEach(issue => {
      console.log(`  - Doc: ${issue.docId}`);
      console.log(`    Title: ${issue.title}`);
      console.log(`    Category ID: ${JSON.stringify(issue.categoryId)}`);
      console.log(`    Category Name: ${issue.categoryName}\n`);
    });
  } else {
    console.log('✅ All category IDs are valid\n');
  }
  
  if (issues.missingAuthorName.length > 0) {
    console.log('⚠️  MISSING AUTHOR NAMES:', issues.missingAuthorName.length);
    issues.missingAuthorName.forEach(issue => {
      console.log(`  - Doc: ${issue.docId} (${issue.title})\n`);
    });
  }
  
  if (issues.missingCategoryName.length > 0) {
    console.log('⚠️  MISSING CATEGORY NAMES:', issues.missingCategoryName.length);
    issues.missingCategoryName.forEach(issue => {
      console.log(`  - Doc: ${issue.docId} (${issue.title})\n`);
    });
  }
  
  // Summary
  const totalIssues = 
    issues.invalidAuthorId.length + 
    issues.invalidCategoryId.length + 
    issues.missingAuthorName.length + 
    issues.missingCategoryName.length;
  
  if (totalIssues === 0) {
    console.log('🎉 No issues found! Your database is clean.\n');
  } else {
    console.log(`\n⚠️  Total issues found: ${totalIssues}`);
    console.log('Run the cleanup script to fix these issues.\n');
  }
}

identifyBadData()
  .then(() => {
    console.log('✅ Scan complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error scanning database:', error);
    process.exit(1);
  });
```

---

## Script 2: Fix Bad Data (Write Operation)

This script **modifies your database** to fix invalid IDs. **BACKUP YOUR DATABASE FIRST!**

### Create: `scripts/fix-bad-blog-data.js`

```javascript
/**
 * Fix Bad Blog Data Script
 * ⚠️  WARNING: This script modifies your database!
 * Run with: node scripts/fix-bad-blog-data.js
 */

const admin = require('firebase-admin');
const serviceAccount = require('../path/to/your/serviceAccountKey.json');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Default values for missing data
const DEFAULT_AUTHOR_ID = 'unknown-author';
const DEFAULT_AUTHOR_NAME = 'Unknown Author';
const DEFAULT_CATEGORY_ID = 'general';
const DEFAULT_CATEGORY_NAME = 'General';

async function fixBadData() {
  console.log('🔧 Starting database cleanup...\n');
  console.log('⚠️  This script will modify your database!');
  console.log('⚠️  Make sure you have a backup before proceeding.\n');
  
  // Wait 5 seconds to allow cancellation
  console.log('Starting in 5 seconds... (Press Ctrl+C to cancel)');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const blogsRef = db.collection('blogs');
  const snapshot = await blogsRef.get();
  
  let fixedCount = 0;
  const batch = db.batch();
  
  snapshot.forEach((doc) => {
    const data = doc.data();
    const updates = {};
    let needsUpdate = false;
    
    // Fix invalid authorId
    if (!data.authorId || typeof data.authorId !== 'string' || data.authorId.trim() === '') {
      updates.authorId = DEFAULT_AUTHOR_ID;
      needsUpdate = true;
      console.log(`📝 Fixing authorId for: ${data.title || doc.id}`);
    }
    
    // Fix invalid categoryId
    if (!data.categoryId || typeof data.categoryId !== 'string' || data.categoryId.trim() === '') {
      updates.categoryId = DEFAULT_CATEGORY_ID;
      needsUpdate = true;
      console.log(`📝 Fixing categoryId for: ${data.title || doc.id}`);
    }
    
    // Fix missing authorName
    if (!data.authorName || data.authorName.trim() === '') {
      updates.authorName = DEFAULT_AUTHOR_NAME;
      needsUpdate = true;
      console.log(`📝 Fixing authorName for: ${data.title || doc.id}`);
    }
    
    // Fix missing categoryName
    if (!data.categoryName || data.categoryName.trim() === '') {
      updates.categoryName = DEFAULT_CATEGORY_NAME;
      needsUpdate = true;
      console.log(`📝 Fixing categoryName for: ${data.title || doc.id}`);
    }
    
    if (needsUpdate) {
      batch.update(doc.ref, updates);
      fixedCount++;
    }
  });
  
  if (fixedCount > 0) {
    console.log(`\n💾 Committing ${fixedCount} updates to database...`);
    await batch.commit();
    console.log('✅ Database updated successfully!\n');
  } else {
    console.log('\n✅ No issues found - database is already clean!\n');
  }
  
  console.log(`📊 Summary:`);
  console.log(`   Total documents scanned: ${snapshot.size}`);
  console.log(`   Documents fixed: ${fixedCount}`);
}

fixBadData()
  .then(() => {
    console.log('\n✅ Cleanup complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Error fixing database:', error);
    process.exit(1);
  });
```

---

## How to Use These Scripts

### Step 1: Setup
```bash
# Create scripts directory
mkdir -p scripts

# Copy the scripts above into:
# - scripts/identify-bad-blog-data.js
# - scripts/fix-bad-blog-data.js

# Update the path to your service account key in both files
```

### Step 2: Identify Issues (Safe)
```bash
node scripts/identify-bad-blog-data.js
```

This will show you all the problematic blog posts without making any changes.

### Step 3: Backup Your Database
**CRITICAL:** Before running the fix script, backup your Firestore database:
1. Go to Firebase Console
2. Navigate to Firestore Database
3. Click "Import/Export"
4. Export to Cloud Storage

### Step 4: Fix Issues
```bash
node scripts/fix-bad-blog-data.js
```

This will update all blog posts with invalid data.

### Step 5: Verify
1. Refresh your blog page: http://localhost:9004/blog
2. Check the browser console - the debug messages should now show all valid data
3. The error boundary should no longer trigger
4. The hooks violation should be gone

---

## Alternative: Manual Fix via Firebase Console

If you prefer to fix issues manually:

1. Go to Firebase Console → Firestore Database
2. Navigate to the `blogs` collection
3. For each document with invalid data:
   - Click the document
   - Edit the `authorId` field → Set to a valid user ID
   - Edit the `categoryId` field → Set to a valid category ID
   - Save changes

---

## What the API Validation Does

Even without running these scripts, the API now:
1. **Filters out invalid data** before sending to the client
2. **Logs warnings** when bad data is detected
3. **Prevents crashes** by ensuring only valid IDs reach the UI

However, **you should still fix the database** to:
- Ensure data integrity
- Prevent confusion about missing authors/categories
- Improve performance (no filtering needed)
- Maintain accurate statistics

---

## Expected Console Output After Fix

### Browser Console (Frontend)
```
!!! DEBUG: DATA BEING MAPPED TO AUTHOR SELECT !!!
[
  {
    "id": "user123",
    "name": "John Doe",
    "postCount": 5
  },
  {
    "id": "user456",
    "name": "Jane Smith",
    "postCount": 3
  }
]
✅ All author items are valid for Select rendering
```

### Server Terminal (Backend)
```
[/api/authors] SERVER-SIDE DEBUG: Total authors before validation: 2
[/api/authors] SERVER-SIDE DEBUG: Valid authors after validation: 2
```

No error messages = clean database! 🎉

