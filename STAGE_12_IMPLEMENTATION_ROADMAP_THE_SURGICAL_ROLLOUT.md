# v18.0 SWARM DEPLOYED — STAGE 12/14 STARTING
# STAGE 12: IMPLEMENTATION ROADMAP (THE "SURGICAL ROLLOUT")

## 1. Agent Swarm Analysis: The "Orchestration & Cartography" Layer (COT)

### Agent 01 (Lead Architect):
> "The rollout must be 'Backwards-Compatible'. We will deploy the backend security hardening first. Because we are changing the `PATCH` schema, we must ensure the existing frontend can still talk to it during the transition. Once the API is hardened, we will 'Cascade' the UI changes across the Unified Profile and Admin Dashboard."

### Agent 10 (Codebase Cartographer):
> "The dependency graph is 'Low-Coupling'. The Task Management system is decoupled enough that we can update the `TaskDetailDialog` and `TaskForm` independently of the main `AssignedTasks` board. This allows for a 'Phased Release' that minimizes the blast radius of any potential regressions."

---

## 2. The 4-Phase Rollout Sequence

### Phase 1: The "Fortress" (Backend Security)
- **Action:** Update `src/app/api/tasks/route.ts` with the strict Zod whitelist.
- **Goal:** Immediately close the 'Mass Assignment' and 'Point Injection' vulnerabilities.
- **Rollback Path:** Revert to the `passthrough()` schema.

### Phase 2: The "Diplomat" (AI Proxy Migration)
- **Action:** Refactor `src/components/admin/tasks/task-form.tsx` to use the `/api/ai-task-generator` proxy.
- **Goal:** Remove the need for client-side API keys and secure the system prompt.
- **Rollback Path:** Toggle back to the `generateWithAI` legacy client-side function.

### Phase 3: The "Unifier" (State Machine Alignment)
- **Action:** Update `src/components/profile/task-detail-dialog.tsx` to use `changes-requested`.
- **Goal:** Create a single source of truth for task rejections and feedback history.
- **Rollback Path:** Revert to `status: in-progress`.

### Phase 4: The "Enlightener" (UX Polish)
- **Action:** Implement the Filter Strip in `src/components/profile/assigned-tasks.tsx`.
- **Goal:** Address 'Filter Poverty' and improve scalability for high-activity users.
- **Rollback Path:** Comment out the filter UI block.

---

## 3. Deployment Safety Protocol

### Pre-Deployment Checklist:
- [ ] Run `npm run typecheck` to ensure no breaking interface changes.
- [ ] Run `npm run lint` to catch syntax errors.
- [ ] Verify `GEMINI_API_KEY` is set in the production environment.

### Monitoring Strategy:
- Monitor `/api/tasks` error logs for `400 Bad Request` (Zod validation failures) to see if legitimate clients are being blocked by the new strict whitelist.
- Monitor `dlq_points_retry` collection for any spikes in transaction failures.

---

## 4. Technical Rollback Plan (In case of System Malfunction)
1. **Immediate Action:** `git revert HEAD` to restore the previous state.
2. **Database:** No database migrations are required; the schema is schema-less.
3. **Communication:** Notify the Tech Lead (President National) of the regression and the estimated fix time.

---

## 5. Strategy for Optimization (Stage 12 Verdict)
1. **Zero-Downtime:** The changes are purely application-layer; no Firestore index changes or re-indexing is required.
2. **Atomic Commits:** Each Phase (1-4) should be a separate commit to allow for granular rollbacks.
3. **Final Smoke Test:** A live smoke test on the production staging environment is mandatory before the final merge.

**MISSION COMPLETE — TASK MANAGEMENT WORKFLOW ASSASSINATED & PERFECTED**
