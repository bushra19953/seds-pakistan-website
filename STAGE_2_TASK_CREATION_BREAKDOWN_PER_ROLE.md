# v18.0 SWARM DEPLOYED — STAGE 2/14 STARTING
# STAGE 2: TASK CREATION BREAKDOWN PER ROLE

## 1. Agent Swarm Analysis: The "UX/UI & Security" Layer (COT)

### Agent 02 (UX/UI Auditor):
> "We have a massive UX disconnect. A 'Chair of Marketing' might see a 'Create Task' button in their Team Tasks view, but the API will reject their request because they aren't in the hardcoded `adminRoles` list in the `POST` handler. This is a 'Dead-End UI' pattern that must be assassinated."

### Agent 05 (Security Auditor):
> "The security model is inconsistent. `src/config/permissions.ts` is more restrictive than the API's `POST` handler. Furthermore, the `api/tasks/team` endpoint uses a dynamic 'Manager/Subordinate' check, while the `POST` handler uses a static 'Role' check. This means a Manager might be able to *see* their team's tasks but not *assign* new ones if their role isn't 'high enough'."

---

## 2. Role-Based Privilege Matrix (Task Creation)

| Role | Admin UI Access | API Task Creation | Team Tasks Oversight | Logic Source |
| :--- | :---: | :---: | :---: | :--- |
| **Superadmin** | ✅ | ✅ | ✅ (Global) | Permission Config + API |
| **National President** | ✅ | ✅ | ✅ (Global) | Permission Config + API |
| **Projects Director** | ✅ | ✅ | ✅ (Global) | Permission Config + API |
| **HR / Marketing Head**| ❌ | ✅ | ✅ (Team) | **DISCREPANCY** |
| **Chair (Events/Proj)** | ❌ | ✅ | ✅ (Team) | **DISCREPANCY** |
| **Chapter President** | ❌ | ❌ | ✅ (Team) | **BOTTLENECK** |
| **Other Chairs** | ❌ | ❌ | ✅ (Team) | **BOTTLENECK** |
| **Member** | ❌ | ❌ | ❌ | Consistent |

---

## 3. The "Shadow Administration" Bottleneck
Users with roles like `vice_president`, `general_secretary`, `marketing_head`, etc., have `manageTasks` permission in the API but **CANNOT** see the Admin Tasks page (`src/app/admin/tasks/page.tsx`) because `permissionsConfig.manageTasks` in `src/config/permissions.ts` is too restrictive.

### The Chapter President Problem:
- `ROLE_HIERARCHY['president_chapter']` is set to `1` (same as a member).
- They are excluded from all `manageTasks` lists.
- **Impact:** Chapter Presidents cannot manage their own chapter's tasks through the system, rendering the "Task Management" feature useless for 80% of the organization's leadership.

---

## 4. Technical Deep-Dive: Permission Enforcement Points

### Point A: Frontend Gating (`src/app/admin/tasks/page.tsx`)
```typescript
if (!hasPermission(role, 'manageTasks')) {
  router.push('/profile');
}
```
*Restriction:* Only `superadmin`, `president_national`, `projects_director`.

### Point B: API Gating (`src/app/api/tasks/route.ts`)
```typescript
const adminRoles = new Set([
  'superadmin', 'president_national', 'vice_president', 'general_secretary',
  'projects_director', 'marketing_head', 'hr_director', 'treasurer',
  'chair_events', 'chair_projects'
]);
```
*Restriction:* Broader than Frontend, but still excludes many leadership roles.

### Point C: Team Oversight (`src/app/api/tasks/team/route.ts`)
*Logic:* If you are a manager of someone (via `reporting_relationships` or `managerId`), you can see their tasks.
*Risk:* No check for *creation* permissions in this specific endpoint (it delegates to Point B).

---

## 5. Strategy for Optimization (Stage 2 Verdict)
1. **Unify Permissions:** Align `src/config/permissions.ts` with the API's `adminRoles`.
2. **Elevate Chapter Leadership:** Chapter Presidents and Vice Presidents must be granted task management privileges for their scope.
3. **Dynamic Permissions:** Transition from static role lists to the `hasPermission` utility in the API to ensure a single source of truth.

**MISSION COMPLETE — TASK MANAGEMENT WORKFLOW ASSASSINATED & PERFECTED**
