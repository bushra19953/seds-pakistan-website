# Role Standardization & Registry Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a singular source of truth for roles, fix the "Pakistan President" filter, and unify the Role Registry with hardcoded and dynamic roles.

**Architecture:** 
1.  **API Aliasing**: Update the user search API to handle role aliases (e.g., `president_national` alias to Founder UID).
2.  **Unified Discovery**: Fix `getUnifiedRoleOptions` to prevent duplicates and ensure the UI only shows one canonical option per role.
3.  **Registry Unification**: Update the Role Registry UI to display both hardcoded and dynamic roles, ensuring full visibility and control.

**Tech Stack:** Next.js, Firebase Firestore, TypeScript

---

### Task 1: Fix API Filter Aliasing

**Files:**
- Modify: `src/app/api/admin/users/route.ts`

- [ ] **Step 1: Update API filter logic**
Update both Path A and Path B in the API to treat `president_national` as an alias for the Founder UID.

```typescript
// Example update for Path A
users = users.filter(u => {
  if (role === 'president_national') return u.uid === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
  if (role === 'superadmin') return u.uid === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
  return u.role === role;
});
```

### Task 2: Standardize Unified Role Discovery

**Files:**
- Modify: `src/lib/unified-roles.ts`

- [ ] **Step 1: Fix duplication in discovery engine**
Refactor `getUnifiedRoleOptions` to ensure that when reserved roles are added for the Founder, they use the canonical slugs and are de-duplicated against the database results.

- [ ] **Step 2: Harden normalization**
Ensure `normalizeRoleSlug` is used consistently for all keys before they enter the final Map.

### Task 3: Unify Role Registry UI

**Files:**
- Modify: `src/app/admin/roles/page.tsx`

- [ ] **Step 1: Merge Hardcoded Roles into Registry view**
Currently, "Role Registry" only shows `roleDefinitions`. Update it to display all `roleOptions` so the user can see hardcoded permissions too.

- [ ] **Step 2: Add Badge for Hardcoded vs Dynamic**
Add a small badge in the Registry table: `[SYSTEM]` for hardcoded, `[CUSTOM]` for database-defined.

### Task 4: Final Database Scrub

**Files:**
- Run: `scripts/nuclear-dedupe.js`

- [ ] **Step 1: Execute final dedupe**
Run the updated migration script to ensure the database has zero hyphenated or alias roles remaining.

---

## Verification
- [ ] Filter by "Pakistan President" and verify the Founder appears.
- [ ] Filter by "Super Admin" and verify the Founder appears.
- [ ] Open Role Registry and verify "Vice President" (hardcoded) and "Ambassador" (custom) both appear.
- [ ] Try creating "Advisor Faculty Head" and verify it is blocked as a duplicate of "Advisor".
