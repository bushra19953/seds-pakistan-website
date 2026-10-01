const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, '../seds-pakistan-service-account.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function simulateApi() {
  console.log('--- API Simulation Script ---');
  
  // Default params: status=all, limit=100
  const limit = 100;
  const status = 'all';

  let q = db.collection('tasks');
  
  // Simulation of API logic
  if (status !== 'all') {
    q = q.where('status', '==', status);
  }
  
  q = q.orderBy('createdAt', 'desc');
  q = q.limit(limit);

  const snap = await q.get();
  console.log(`Results found: ${snap.size}`);
  
  snap.docs.forEach((doc, i) => {
    if (i < 5) console.log(`Task ${i+1}: ${doc.data().title} (Status: ${doc.data().status})`);
  });

  process.exit(0);
}

simulateApi().catch(err => {
  console.error(err);
  process.exit(1);
});
