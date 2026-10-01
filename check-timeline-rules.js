const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');

// Firebase configuration (matches src/firebase/config.ts)
const firebaseConfig = {
  apiKey: "AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg",
  authDomain: "seds-pakistan.firebaseapp.com",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.firebasestorage.app",
  messagingSenderId: "884993774057",
  appId: "1:884993774057:web:50eb3cd3917dc61045fb78",
  measurementId: "G-HJ0LZD8K4B",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  console.log('Testing unauthenticated read from "timeline" collection...');
  try {
    const snapshot = await getDocs(collection(db, 'timeline'));
    console.log(`✅ Read succeeded. Documents found: ${snapshot.size}`);
    snapshot.docs.slice(0, 5).forEach((doc) => {
      console.log(`- ${doc.id}:`, doc.data());
    });
    process.exit(0);
  } catch (error) {
    console.error('❌ Read failed:', error.code || error.message);
    console.error('Details:', error);
    process.exit(1);
  }
}

run();