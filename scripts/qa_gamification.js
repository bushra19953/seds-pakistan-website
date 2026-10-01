const admin = require('firebase-admin');

async function runQaGauntlet() {
    // 1. Initialize Admin
    if (!admin.apps.length) {
        require('dotenv').config({ path: '.env.local' });
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
    }

    const db = admin.firestore();
    const PORT = 9004;

    console.log("===============================================");
    console.log("🔥 INITIATING EXECUTION GAUNTLET (QA PROTOCOL)");
    console.log("===============================================");

    // Utility: Clear User
    async function clearUser(uid) {
        await db.collection("users").doc(uid).set({
            total_points: 0,
            points: 0,
            tasksCompletedCount: 0
        });
        const ledgerSnaps = await db.collection("points_ledger").where("user_id", "==", uid).get();
        const deleteBatch = db.batch();
        ledgerSnaps.docs.forEach(doc => deleteBatch.delete(doc.ref));
        await deleteBatch.commit();
    }

    // Utility: Patch API Call
    async function approveTask(taskId) {
        return fetch(`http://localhost:${PORT}/api/tasks`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-stress-test': 'thermonuclear'
            },
            body: JSON.stringify({
                taskId: taskId,
                updates: { status: 'approved' }
            })
        }).then(res => res.json());
    }

    try {
        // ==========================================
        // TEST A: THE PARENT-CHILD ROLLUP
        // ==========================================
        console.log("\n[TEST A]: THE PARENT-CHILD ROLLUP (Testing the Separation)");
        const userAlpha = "user_alpha_test";
        await clearUser(userAlpha);

        // Setup
        const p1Ref = db.collection("tasks").doc();
        const s1Ref = db.collection("tasks").doc();
        const s2Ref = db.collection("tasks").doc();

        const batchA = db.batch();
        batchA.set(p1Ref, { title: "P1", assignee_id: userAlpha, assigneeIds: [userAlpha], status: "pending", completion_bonus_points: 50, assignment_type: "individual" });
        batchA.set(s1Ref, { title: "S1", assignee_id: userAlpha, assigneeIds: [userAlpha], status: "pending", base_points: 10, parent_task_id: p1Ref.id, assignment_type: "individual" });
        batchA.set(s2Ref, { title: "S2", assignee_id: userAlpha, assigneeIds: [userAlpha], status: "pending", base_points: 15, parent_task_id: p1Ref.id, assignment_type: "individual" });
        await batchA.commit();

        // Execution Step 1
        console.log("  -> Approving S1...");
        await approveTask(s1Ref.id);

        let uAlphaDoc = await db.collection("users").doc(userAlpha).get();
        let p1Doc = await p1Ref.get();

        console.log(`  -> User Alpha Points: ${uAlphaDoc.data()?.total_points} (Expected: 10)`);
        console.log(`  -> P1 Status: ${p1Doc.data()?.status} (Expected: pending)`);

        if (uAlphaDoc.data()?.total_points !== 10 || p1Doc.data()?.status !== "pending") {
            throw new Error("TEST A FAILED ON STEP 1");
        }

        // Execution Step 2
        console.log("  -> Approving S2...");
        await approveTask(s2Ref.id);

        uAlphaDoc = await db.collection("users").doc(userAlpha).get();
        p1Doc = await p1Ref.get();

        console.log(`  -> User Alpha Points: ${uAlphaDoc.data()?.total_points} (Expected: 75)`);
        console.log(`  -> P1 Status: ${p1Doc.data()?.status} (Expected: completed | approved)`);

        if (uAlphaDoc.data()?.total_points !== 75 || !['completed', 'approved'].includes(p1Doc.data()?.status)) {
            throw new Error("TEST A FAILED ON STEP 2 (Rollup Logic Flawed)");
        }
        console.log("✅ TEST A PASSED.");

        // ==========================================
        // TEST B: THE SPLIT MATH INFLATION DEFENSE
        // ==========================================
        console.log("\n[TEST B]: THE SPLIT MATH INFLATION DEFENSE");
        const squad = ["user_b1", "user_b2", "user_b3", "user_b4"];
        for (let u of squad) await clearUser(u);

        const tX1Ref = db.collection("tasks").doc();
        await tX1Ref.set({
            title: "Task X1",
            assignment_type: "individual",
            assigneeIds: squad,
            base_points: 50,
            point_distribution_mode: "split",
            status: "pending"
        });

        console.log("  -> Approving Task X1 (50 points split among 4 users)...");
        await approveTask(tX1Ref.id);

        let testBPassed = true;
        for (let u of squad) {
            const uDoc = await db.collection("users").doc(u).get();
            const pts = uDoc.data()?.total_points;
            console.log(`  -> ${u} Points: ${pts} (Expected: 12)`); // Math.floor(50/4)
            if (pts !== 12) testBPassed = false;
        }

        if (!testBPassed) throw new Error("TEST B FAILED (Split Math Flawed)");
        console.log("✅ TEST B PASSED.");

        // ==========================================
        // TEST C: THE SIMULTANEOUS DOUBLE-DIP (The Concurrency Lock)
        // ==========================================
        console.log("\n[TEST C]: THE SIMULTANEOUS DOUBLE-DIP (Concurrency Lock)");
        const userOmega = "user_omega_test";
        await clearUser(userOmega);

        const tZ1Ref = db.collection("tasks").doc();
        await tZ1Ref.set({
            title: "Task Z1",
            assignment_type: "individual",
            assigneeIds: [userOmega],
            base_points: 100,
            status: "pending"
        });

        console.log("  -> Firing 2 simultaneous approval requests for the same task...");
        const [res1, res2] = await Promise.all([
            approveTask(tZ1Ref.id),
            approveTask(tZ1Ref.id)
        ]);

        const uOmegaDoc = await db.collection("users").doc(userOmega).get();
        const omegaPts = uOmegaDoc.data()?.total_points;
        const omegaLedger = await db.collection("points_ledger").where("user_id", "==", userOmega).get();

        console.log(`  -> User Omega Points: ${omegaPts} (Expected: 100)`);
        console.log(`  -> Ledger Entries Count: ${omegaLedger.size} (Expected: 1)`);

        if (omegaPts !== 100 || omegaLedger.size !== 1) {
            throw new Error(`TEST C FAILED. Concurrency breach detected. Pts: ${omegaPts}, LedgerSize: ${omegaLedger.size}`);
        }
        console.log("✅ TEST C PASSED.");

        console.log("\n===============================================");
        console.log("🏁 ALL GAUNTLET TESTS PASSED. SCHEMA IS BULLETPROOF.");
        console.log("===============================================");

    } catch (e) {
        console.error("\n❌ GAUNTLET EXECUTION HALTED DUE TO FAILURE:");
        console.error(e);
    }

    process.exit(0);
}

runQaGauntlet().catch(console.error);
