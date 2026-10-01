const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg",
  authDomain: "seds-pakistan.firebaseapp.com",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.firebasestorage.app",
  messagingSenderId: "884993774057",
  appId: "1:884993774057:web:50eb3cd3917dc61045fb78",
  measurementId: "G-HJ0LZD8K4B"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function testBlogData() {
  try {
    console.log('Fetching blog posts...');
    const blogCollection = collection(db, 'blogs');
    const blogSnapshot = await getDocs(blogCollection);
    
    console.log(`Found ${blogSnapshot.size} blog posts`);
    
    blogSnapshot.forEach((doc) => {
      const data = doc.data();
      console.log(`\nBlog ID: ${doc.id}`);
      console.log(`Title: ${data.title}`);
      console.log(`Status: ${data.status}`);
      console.log(`Published: ${data.published}`);
      console.log(`Created At: ${data.createdAt}`);
    });
  } catch (error) {
    console.error('Error fetching blog data:', error);
  }
}

testBlogData();