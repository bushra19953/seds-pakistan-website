const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, query, limit } = require('firebase/firestore');

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyA0tC2D1fJv7GgT1-VbWH7bSJbQ3o5w3J4",
  authDomain: "min-seds.firebaseapp.com",
  projectId: "min-seds",
  storageBucket: "min-seds.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef1234567890abcdef",
  measurementId: "G-ABCDEF1234"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function checkExistingData() {
  try {
    console.log('Checking existing data in Firestore...');
    
    // Try to read from users collection (should be public read)
    try {
      const usersQuery = query(collection(db, 'users'), limit(5));
      const usersSnapshot = await getDocs(usersQuery);
      console.log(`Found ${usersSnapshot.docs.length} users`);
      usersSnapshot.docs.forEach(doc => {
        console.log(`User: ${doc.id} =>`, doc.data());
      });
    } catch (error) {
      console.log('Error reading users:', error.message);
    }
    
    // Try to read from roles collection (should be restricted)
    try {
      const rolesQuery = query(collection(db, 'roles'), limit(5));
      const rolesSnapshot = await getDocs(rolesQuery);
      console.log(`Found ${rolesSnapshot.docs.length} roles`);
      rolesSnapshot.docs.forEach(doc => {
        console.log(`Role: ${doc.id} =>`, doc.data());
      });
    } catch (error) {
      console.log('Error reading roles:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Error checking data:', error);
  }
}

checkExistingData();