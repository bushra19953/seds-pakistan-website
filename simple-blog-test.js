// Simple test to check if we can connect to Firestore
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function testConnection() {
  try {
    console.log('Testing Firestore connection...');
    const blogsRef = collection(db, 'blogs');
    const snapshot = await getDocs(blogsRef);
    console.log(`Successfully connected! Found ${snapshot.size} blog documents.`);
    
    // Show first few documents
    let count = 0;
    snapshot.forEach((doc) => {
      if (count < 3) {
        console.log(`Document ${doc.id}:`, doc.data());
        count++;
      }
    });
  } catch (error) {
    console.error('Error connecting to Firestore:', error);
  }
}

testConnection();