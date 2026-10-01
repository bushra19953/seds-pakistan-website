# Task Page Crash & Global Blueprint Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the task page crash/redirect caused by role normalization mapping failure and hardcoded role checks, and remove hardcoded permissions to make RBAC fully dynamic.

**Architecture:** Update `normalizeRoleSlug` to correctly map `presidential_national` to `president_national`. Strip out all hardcoded roles from `permissions.config.ts` and `roles.ts` except for `superadmin` to rely entirely on dynamic Firestore `roleDefinitions`. The `Global Blueprint` (docs/blueprint.md) is simply a static styling/theming spec and architecture outline; it is necessary for maintaining UI consistency but not actively executed code.

**Tech Stack:** TypeScript, Next.js, Firebase Auth

---

### Task 1: Fix Role Normalization

**Files:**
- Modify: `src/lib/unified-roles.ts`

- [ ] **Step 1: Add missing role mapping**
Update `REDIRECTS` in `normalizeRoleSlug` to include `'presidential_national': 'president_national'`.

```typescript
  const REDIRECTS: Record<string, string> = {
    'pakistan_president': 'president_national',
    'pakistan_national_president': 'president_national',
    'presidential_national': 'president_national',
    'president': 'president_chapter',
    // ...
```

### Task 2: Make Permissions Fully Dynamic

**Files:**
- Modify: `src/config/permissions.config.ts`

- [ ] **Step 1: Strip hardcoded role arrays**
Remove `LEADERSHIP` and `ALL_ADMIN_ROLES` arrays. Update `permissionsConfig` so every permission array ONLY contains `['superadmin']`.

```typescript
export const permissionsConfig: Record<PermissionKey, UserRole[]> = {
  // ── System ──
  canAccessAdmin: ['superadmin'],
  canManagePermissions: ['superadmin'],
  canManageUsers: ['superadmin'],
  canManageRoles: ['superadmin'],
  // Apply to all other keys...
};
```

### Task 3: Simplify Role Definitions

**Files:**
- Modify: `src/lib/roles.ts`

- [ ] **Step 1: Clean up USER_ROLES and ROLE_HIERARCHY**
Remove all hardcoded roles except `superadmin` and `president_national`. 

```typescript
export const USER_ROLES: Record<string, string> = {
  superadmin: 'Super Admin',
  president_national: 'Pakistan President',
};

export const ROLES = {
  SUPERADMIN: 'superadmin',
  PRESIDENT_NATIONAL: 'president_national',
};

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  superadmin: 11,
  president_national: 10,
};
```

- [ ] **Step 2: Update hasSiteAdminAccess**
Remove hardcoded arrays inside `hasSiteAdminAccess`.

```typescript
export function hasSiteAdminAccess(userRole: UserRole): boolean {
  if (userRole === 'superadmin' || userRole === 'president_national') return true;
  
  const level = ROLE_HIERARCHY[userRole as keyof typeof ROLE_HIERARCHY];
  if (level !== undefined && level >= 7) return true;
  return false;
}
```

### Task 4: Fix Default Redirect Logic

**Files:**
- Modify: `src/hooks/use-contextual-redirect.tsx`

- [ ] **Step 1: Simplify getDefaultRedirectUrl**
Replace the large switch statement with a simple check for `superadmin` and `president_national`.

```typescript
  const getDefaultRedirectUrl = useCallback((userRole?: UserRole): string => {
    if (!userRole) return '/profile';
    
    if (userRole === 'superadmin' || userRole === 'president_national') {
      return '/admin';
    }
    
    return '/profile';
  }, []);
```
