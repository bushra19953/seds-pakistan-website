
const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'seds-pakistan-service-account.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'seds-pakistan'
  });
}

const db = admin.firestore();

async function findMaira() {
  console.log('Searching for Maira...');
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();
  
  const maira = snapshot.docs.find(doc => {
    const data = doc.data();
    return (data.displayName && data.displayName.toLowerCase().includes('maira')) || 
           (data.email && data.email.toLowerCase().includes('maira'));
  });

  if (maira) {
    console.log('Found Maira:');
    console.log('ID:', maira.id);
    console.log('Data:', JSON.stringify(maira.data(), null, 2));
    
    // Now count her tasks
    const tasksRef = db.collection('tasks');
    const assignedTasks = await tasksRef.where('assigneeId', '==', maira.id).get();
    const participantTasks = await tasksRef.where('workflowParticipantIds', 'array-contains', maira.id).get();
    
    console.log(`\nTask Counts for Maira (${maira.id}):`);
    console.log(`Assigned tasks: ${assignedTasks.size}`);
    console.log(`Workflow participant tasks: ${participantTasks.size}`);
    
    const allTaskIds = new Set();
    assignedTasks.forEach(doc => allTaskIds.add(doc.id));
    participantTasks.forEach(doc => allTaskIds.add(doc.id));
    console.log(`Total unique tasks: ${allTaskIds.size}`);
  } else {
    console.log('Maira not found.');
  }
}

findMaira().catch(console.error);
