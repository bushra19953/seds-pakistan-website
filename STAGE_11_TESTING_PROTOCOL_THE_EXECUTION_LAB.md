# v18.0 SWARM DEPLOYED — STAGE 11/14 STARTING
# STAGE 11: TESTING PROTOCOL (THE "EXECUTION LAB")

## 1. Agent Swarm Analysis: The "QA & Validation" Layer (COT)

### Agent 04 (QA / Edge-Case Assassin):
> "My mission is 'Negative Verification'. I will attempt to bypass the new Zod schema by injecting forbidden fields like `isBanned` or `points` into the task update payload. If the system accepts them, the surgery has failed. We will also test the 'Poisoned Status' recovery by manually setting a task to 'overdue' and ensuring the API 'heals' it correctly."

### Agent 11 (Final Validator):
> "I will oversee the 'Zero-Knowledge AI' test. By purging all API keys from the browser environment, we will verify that the `TaskForm` can still perform complex orchestration using only the server-side proxy. This confirms the removal of the client-side security risk identified in Stage 8."

---

## 2. Automated Verification Script (Zod Test)
We will run a standalone Node script to verify the new `TaskUpdateSchema` integrity.

```typescript
// Test Snippet: Verify Strict Schema
const payload = {
  taskId: "test-id",
  updates: {
    status: "in-progress",
    points: 99999 // 🚨 FORBIDDEN FIELD
  }
};

try {
  TaskUpdateSchema.parse(payload);
  console.log("FAIL: Schema is still permissive.");
} catch (e) {
  console.log("PASS: Schema successfully blocked mass assignment.");
}
```

---

## 3. Manual QA Protocols (The "Human Forensics")

### Protocol A: The Rejection Handshake
1. **Role:** Manager.
2. **Action:** Navigate to Unified Profile -> Team Tasks -> Open Task -> Request Changes.
3. **Input:** "Please add a GitHub link to your report."
4. **Verification:**
   - Check Firestore: `status` must be `changes-requested`.
   - Check Firestore: `feedback_history` must contain the message.
   - Check Notification: Assignee must receive `task_feedback` notification.

### Protocol B: Mission Control Stress Test
1. **Role:** User with 20+ tasks across 5 projects.
2. **Action:** Apply "Project Alpha" filter.
3. **Verification:**
   - UI must instantly hide non-Alpha tasks.
   - Layout must remain stable (no layout shift).
   - "Showing X tasks" badge must update correctly.

---

## 4. Regression Checklist (The "Do No Harm" Policy)
- [ ] **Auth:** Does the Admin Dashboard still gate access correctly?
- [ ] **Gamification:** Does task completion still award points? (Verify `executeGamificationTransaction`).
- [ ] **Workflows:** Does completing a step still release the next step?
- [ ] **Performance:** Does the `TaskCard` still render without lag?

---

## 5. Strategy for Optimization (Stage 11 Verdict)
1. **Dry-Run:** Execute all "Negative" tests on a staging/development branch.
2. **Observation:** Use `console.log` tracers in the API to verify that the `updatesToApply` object is strictly filtered before reaching the `batch.update()` call.
3. **Final Sign-off:** Only when all 5 Test Cases (TC-01 to TC-05) pass 100%, we proceed to Rollout.

**MISSION COMPLETE — TASK MANAGEMENT WORKFLOW ASSASSINATED & PERFECTED**
