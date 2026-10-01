const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, collection, getDocs } = require('firebase/firestore');

const firebaseConfig = {
  apiKey: "AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg",
  authDomain: "seds-pakistan.firebaseapp.com",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.firebasestorage.app",
  messagingSenderId: "884993774057",
  appId: "1:884993774057:web:50eb3cd3917dc61045fb78",
  measurementId: "G-HJ0LZD8K4B"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function checkUserRole(uid) {
  try {
    console.log(`Checking role for UID: ${uid}`);
    
    // Check roles collection
    const roleDoc = await getDoc(doc(db, 'roles', uid));
    if (roleDoc.exists()) {
      console.log('Roles document found:', roleDoc.data());
    } else {
      console.log('No roles document found for this UID');
    }
    
    // Check users collection
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
      console.log('Users document found:', userDoc.data());
    } else {
      console.log('No users document found for this UID');
    }
    
    // Check all roles to see what's in the system
    console.log('\nAll roles in system:');
    const rolesSnapshot = await getDocs(collection(db, 'roles'));
    rolesSnapshot.forEach((doc) => {
      console.log(`${doc.id}:`, doc.data());
    });
    
  } catch (error) {
    console.error('Error checking user role:', error);
  }
}

// Get UID from command line argument
const uid = process.argv[2];
if (!uid) {
  console.log('Please provide a UID as argument: node check-user-role.js <your-uid>');
  process.exit(1);
}

checkUserRole(uid);