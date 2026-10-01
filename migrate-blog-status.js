const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: 'https://seds-pakistan-default-rtdb.firebaseio.com/'
  });
}

const db = admin.firestore();

async function migrateBlogStatus() {
  try {
    console.log('Starting blog status migration...');
    
    // Get all blogs that have the old 'published' field but no 'status' field
    const blogsSnapshot = await db.collection('blogs')
      .where('published', '==', true)
      .get();
    
    console.log(`Found ${blogsSnapshot.size} blogs with old published field`);
    
    let updatedCount = 0;
    
    for (const doc of blogsSnapshot.docs) {
      const data = doc.data();
      
      // Only update if there's no status field yet
      if (!data.status) {
        await db.collection('blogs').doc(doc.id).update({
          status: 'published'
        });
        console.log(`Updated blog ${doc.id} to set status = 'published'`);
        updatedCount++;
      }
    }
    
    console.log(`Migration complete. Updated ${updatedCount} blog posts.`);
    
    // Also check for blogs with published = false
    const draftBlogsSnapshot = await db.collection('blogs')
      .where('published', '==', false)
      .get();
    
    console.log(`Found ${draftBlogsSnapshot.size} draft blogs with old published field`);
    
    let draftUpdatedCount = 0;
    
    for (const doc of draftBlogsSnapshot.docs) {
      const data = doc.data();
      
      // Only update if there's no status field yet
      if (!data.status) {
        await db.collection('blogs').doc(doc.id).update({
          status: 'draft'
        });
        console.log(`Updated draft blog ${doc.id} to set status = 'draft'`);
        draftUpdatedCount++;
      }
    }
    
    console.log(`Draft migration complete. Updated ${draftUpdatedCount} draft blog posts.`);
    
  } catch (error) {
    console.error('Error during migration:', error);
  }
}

migrateBlogStatus();