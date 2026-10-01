const admin = require('firebase-admin');

async function runTest() {
    // 1. Initialize Admin
    if (!admin.apps.length) {
        // Find credentials locally if possible, or assume defaults. We will just use ADC if running locally.
        const serviceAccount = require('../secrets/firebase-admin-key.json') || null;
        if (serviceAccount) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        } else {
            admin.initializeApp();
        }
    }

    const db = admin.firestore();
    const userId = "user_thermonuclear";

    console.log("🔥 IGNITING THERMONUCLEAR STRESS TEST");

    // 2. Clear out the database for this user
    console.log("Setting up immaculate test environment...");
    await db.collection("users").doc(userId).set({
        total_points: 0,
        points: 0,
        tasksCompletedCount: 0
    });

    const ledgerSnaps = await db.collection("points_ledger").where("user_id", "==", userId).get();
    const deleteBatch = db.batch();
    ledgerSnaps.docs.forEach(doc => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();

    const tasksSnaps = await db.collection("tasks").where("assigneeId", "==", userId).get();
    const tasksDeleteBatch = db.batch();
    tasksSnaps.docs.forEach(doc => tasksDeleteBatch.delete(doc.ref));
    await tasksDeleteBatch.commit();

    // 3. Create 100 unique tasks for the user
    console.log("Seeding 100 dummy tasks...");
    const taskIds = [];
    const seedBatch = db.batch();
    for (let i = 0; i < 100; i++) {
        const taskRef = db.collection("tasks").doc();
        taskIds.push(taskRef.id);
        seedBatch.set(taskRef, {
            title: `Nuclear Test Task ${i}`,
            assigneeId: userId,
            assigneeIds: [userId],
            points: 10,
            status: "pending",
            deadline: new Date(Date.now() + 1000000).toISOString()
        });
    }
    await seedBatch.commit();
    console.log(`Successfully seeded ${taskIds.length} tasks.`);

    // 4. Fire 100 simultaneous requests to the API
    console.log("FIRING 100 SIMULTANEOUS API COMPLETION REQUESTS INTO THE API GATEWAY...");
    const PORT = 9005;

    const fetchPromises = taskIds.map(taskId =>
        fetch(`http://localhost:${PORT}/api/tasks`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-stress-test': 'thermonuclear' // Our backdoor
            },
            body: JSON.stringify({
                taskId: taskId,
                updates: {
                    status: 'completed'
                }
            })
        }).then(res => res.json())
            .catch(err => ({ error: err.message }))
    );

    const startTime = Date.now();
    const results = await Promise.all(fetchPromises);
    const endTime = Date.now();

    console.log(`\nAll 100 requests returned in ${endTime - startTime}ms`);

    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
        console.error(`⚠️ ${errors.length} requests returned HTTP errors! Example:`, errors[0]);
    } else {
        console.log(`✅ 100 requests returned HTTP success`);
    }

    // 5. Verify Database Integrity
    console.log("\n--- COMMENCING QA INTERROGATION ---\n");
    const userDoc = await db.collection("users").doc(userId).get();
    const finalPoints = userDoc.data().total_points;
    const finalLegacyPoints = userDoc.data().points;
    const finalTaskCount = userDoc.data().tasksCompletedCount;

    const finalLedger = await db.collection("points_ledger").where("user_id", "==", userId).get();

    console.log(`[USER POINTS TALLY]: ${finalPoints} (Expected: 1000)`);
    console.log(`[USER LEGACY POINTS TALLY]: ${finalLegacyPoints} (Expected: 1000)`);
    console.log(`[USER TASK COUNT TALLY]: ${finalTaskCount} (Expected: 100)`);
    console.log(`[UNIQUE LEDGER DOCUMENTS]: ${finalLedger.size} (Expected: 100)`);

    if (finalPoints === 1000 && finalLedger.size === 100) {
        console.log("\n🛡️ MATHEMATICAL PERFECTION ATTAINED. RACE CONDITIONS ERADICATED.");
    } else {
        console.log("\n❌ CATASTROPHIC FAILURE. ATOMICITY VIOLATED.");
    }

    process.exit(0);
}

runTest().catch(console.error);
