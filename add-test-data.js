const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, setDoc, doc } = require('firebase/firestore');

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD0u5sIpKO3lQ2g5P9Y1b8x8s5sIpKO3lQ",
  authDomain: "seds-pakistan.firebaseapp.com",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function addTestData() {
  try {
    // Add a test user
    await setDoc(doc(db, 'users', 'test-user-1'), {
      uid: 'test-user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      photoURL: 'https://example.com/photo.jpg',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Add a role for the test user
    await setDoc(doc(db, 'roles', 'test-user-1'), {
      uid: 'test-user-1',
      role: 'admin',
      assignedAt: new Date(),
      assignedBy: 'system'
    });

    console.log('Test data added successfully!');
  } catch (error) {
    console.error('Error adding test data:', error);
  }
}

addTestData();