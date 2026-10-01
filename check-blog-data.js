const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: 'https://seds-pakistan-default-rtdb.firebaseio.com/'
  });
}

const db = admin.firestore();

async function checkBlogData() {
  try {
    console.log('Fetching all blog posts...');
    
    const blogsSnapshot = await db.collection('blogs').get();
    console.log(`Found ${blogsSnapshot.size} total blog posts`);
    
    if (blogsSnapshot.empty) {
      console.log('No blog posts found in the database');
      return;
    }
    
    console.log('\n--- ALL BLOG POSTS ---');
    blogsSnapshot.forEach(doc => {
      const data = doc.data();
      console.log(`\nID: ${doc.id}`);
      console.log(`Title: ${data.title || 'No title'}`);
      console.log(`Status: ${data.status || 'No status'}`);
      console.log(`Published: ${data.published || 'Not set'}`);
      console.log(`Created At: ${data.createdAt ? data.createdAt.toDate() : 'Not set'}`);
      console.log(`Author: ${data.authorName || data.authorUid || 'Unknown'}`);
    });
    
    console.log('\n--- PUBLISHED BLOG POSTS ONLY ---');
    const publishedSnapshot = await db.collection('blogs')
      .where('status', '==', 'published')
      .orderBy('createdAt', 'desc')
      .get();
    
    console.log(`Found ${publishedSnapshot.size} published blog posts`);
    
    if (publishedSnapshot.empty) {
      console.log('No published blog posts found');
    } else {
      publishedSnapshot.forEach(doc => {
        const data = doc.data();
        console.log(`\nID: ${doc.id}`);
        console.log(`Title: ${data.title || 'No title'}`);
        console.log(`Created At: ${data.createdAt ? data.createdAt.toDate() : 'Not set'}`);
      });
    }
    
  } catch (error) {
    console.error('Error fetching blog data:', error);
  }
}

checkBlogData();