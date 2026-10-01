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

async function checkTasks() {
  console.log('--- Comprehensive Task Diagnostic ---');
  
  const tasksRef = db.collection('tasks');
  const allTasksSnap = await tasksRef.get();
  const total = allTasksSnap.size;
  console.log(`Total tasks in collection: ${total}`);

  const assigneeCounts = {};
  const assigneeIdsCounts = {};
  const projectCounts = {};
  const statusCounts = {};
  const userBreakdown = {};
  const titleWorkflowCounts = {};
  const missingAssignee = [];
  const invalidCreatedAt = [];

  allTasksSnap.forEach(doc => {
    const data = doc.data();
    const id = doc.id;

    // Check Assignee
    const aId = data.assigneeId;
    if (aId) {
      assigneeCounts[aId] = (assigneeCounts[aId] || 0) + 1;
      if (!userBreakdown[aId]) {
        userBreakdown[aId] = { total: 0, statuses: {} };
      }
      userBreakdown[aId].total++;
      const status = data.status || 'no-status';
      userBreakdown[aId].statuses[status] = (userBreakdown[aId].statuses[status] || 0) + 1;
    }

    const aIds = data.assigneeIds;
    if (Array.isArray(aIds)) {
      aIds.forEach(uid => {
        assigneeIdsCounts[uid] = (assigneeIdsCounts[uid] || 0) + 1;
        if (!userBreakdown[uid]) {
          userBreakdown[uid] = { total: 0, statuses: {} };
        }
        userBreakdown[uid].total++;
        const status = data.status || 'no-status';
        userBreakdown[uid].statuses[status] = (userBreakdown[uid].statuses[status] || 0) + 1;
      });
    }

    // Check Deduplication (Title + Workflow)
    const title = data.title || 'no-title';
    const wfId = data.workflowId || 'no-wf';
    const key = `${title}-${wfId}`;
    titleWorkflowCounts[key] = (titleWorkflowCounts[key] || 0) + 1;

    if (!aId && (!aIds || aIds.length === 0)) {
      missingAssignee.push(id);
    }

    // Check Project
    const pId = data.projectId || 'none';
    projectCounts[pId] = (projectCounts[pId] || 0) + 1;

    // Check Status
    const status = data.status || 'no-status';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    // Check CreatedAt
    if (!data.createdAt || typeof data.createdAt.toDate !== 'function') {
      invalidCreatedAt.push(id);
    }
  });

  console.log('\nAssigneeId Distribution:');
  console.table(assigneeCounts);

  console.log('\nAssigneeIds (Array) Distribution:');
  console.table(assigneeIdsCounts);

  console.log('\nProject Distribution:');
  console.table(projectCounts);

  console.log('\nStatus Distribution:');
  console.table(statusCounts);

  console.log('\nUser Breakdown (Total & Statuses):');
  for (const uid in userBreakdown) {
    console.log(`\nUser: ${uid}`);
    console.log(`Total: ${userBreakdown[uid].total}`);
    console.table(userBreakdown[uid].statuses);
  }

  console.log('\nTitle-Workflow Combination Counts (Potential Deduplication):');
  const duplicates = Object.entries(titleWorkflowCounts).filter(([k, v]) => v > 1);
  if (duplicates.length > 0) {
    console.table(duplicates.map(([key, count]) => ({ 'Title-WF': key, count })));
  } else {
    console.log('No duplicate Title-Workflow combinations found.');
  }

  if (missingAssignee.length > 0) {
    console.log(`\nTasks missing any assignee (${missingAssignee.length}):`, missingAssignee);
  } else {
    console.log('\nNo tasks missing assignees.');
  }

  if (invalidCreatedAt.length > 0) {
    console.log(`\nTasks with invalid createdAt (${invalidCreatedAt.length}):`, invalidCreatedAt);
  }

  // Check the specific user the user mentioned (likely themselves or the one they are looking at)
  // Let's find who has 41 tasks or if anyone is close.
  console.log('\nSearching for a user with ~41 tasks...');
  for (const uid in assigneeCounts) {
    if (assigneeCounts[uid] === 41 || assigneeCounts[uid] > 30) {
      console.log(`User ${uid} has ${assigneeCounts[uid]} tasks (assigneeId)`);
    }
  }

  process.exit(0);
}

checkTasks().catch(err => {
  console.error(err);
  process.exit(1);
});
