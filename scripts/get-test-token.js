const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');

const firebaseConfig = {
  apiKey: "AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg",
  authDomain: "v0-seds-pakistan.vercel.app",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.appspot.com",
  messagingSenderId: "884993774057",
  appId: "1:884993774057:web:50eb3cd3917dc61045fb78",
};

async function getToken(email, password) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const token = await userCredential.user.getIdToken();
    console.log(token);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

const [email, password] = process.argv.slice(2);
getToken(email, password);
