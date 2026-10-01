const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, '../seds-pakistan-service-account.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkOverdue() {
  const snap = await db.collection('tasks').get();
  console.log('Total tasks:', snap.size);
  
  const overdueTasks = snap.docs.filter(d => d.data().status === 'overdue');
  console.log('Overdue tasks count:', overdueTasks.length);
  
  overdueTasks.forEach(d => {
    const data = d.data();
    console.log(`Task ${d.id}: status=${data.status}, createdAt type=${typeof data.createdAt}, has toDate=${data.createdAt && typeof data.createdAt.toDate === 'function'}`);
  });
  
  process.exit(0);
}

checkOverdue();
