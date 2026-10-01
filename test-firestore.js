const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');

// Firebase configuration (you'll need to get this from your Firebase console)
const firebaseConfig = {
  // Add your actual Firebase config here
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function testFirestoreAccess() {
  try {
    console.log('Testing Firestore access...');
    
    // Test users collection
    const usersSnapshot = await getDocs(collection(db, 'users'));
    console.log('Users collection:', usersSnapshot.size, 'documents');
    
    // Test roles collection
    const rolesSnapshot = await getDocs(collection(db, 'roles'));
    console.log('Roles collection:', rolesSnapshot.size, 'documents');
    
    // List some documents
    usersSnapshot.forEach((doc) => {
      console.log('User document:', doc.id, doc.data());
    });
    
    rolesSnapshot.forEach((doc) => {
      console.log('Role document:', doc.id, doc.data());
    });
    
  } catch (error) {
    console.error('Error accessing Firestore:', error);
  }
}

testFirestoreAccess();