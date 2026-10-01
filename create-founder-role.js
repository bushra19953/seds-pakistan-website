const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

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

async function createFounderRole() {
  const founderUid = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
  
  try {
    // Create the founder's role document
    const roleDoc = {
      role: 'superadmin',
      isSuperAdmin: true,
      isAdmin: true,
      isTeamLeader: true,
      isBlogWriter: true,
      isMember: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    await setDoc(doc(db, 'roles', founderUid), roleDoc);
    console.log('✅ Successfully created founder role document');
    console.log('Role document:', roleDoc);
    
    // Also create a user document for the founder
    const userDoc = {
      uid: founderUid,
      email: 'founder@minseds.com', // You can update this with the actual email
      displayName: 'Founder',
      role: 'superadmin',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    await setDoc(doc(db, 'users', founderUid), userDoc);
    console.log('✅ Successfully created founder user document');
    console.log('User document:', userDoc);
    
  } catch (error) {
    console.error('❌ Error creating founder documents:', error);
  }
}

createFounderRole();