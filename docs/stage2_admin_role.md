# STAGE 2 — ROLE BREAKDOWN: ADMIN TIER
## v11.0 SWARM DEPLOYED — STAGE 2/15 (ROLE 1 of 5)
**AGENT 02 – ROLE DISSECTOR**

---

> **Thinking (COT):** The SEDS website has a 24-role hierarchy (hierarchy level 0–11). The "admin tier" encompasses: `superadmin` (level 11), `president_national` (level 10), and the leadership tier (`vice_president`, `general_secretary`, `projects_director`, `marketing_head`, `hr_director`, `treasurer`, `advisor`) all at level 8–9. These roles share access to the admin panel at `/admin`. Their exact access is controlled by `hasPermission()` in `src/config/permissions.ts`. Key principle: `hasSiteAdminAccess()` gates the admin sidebar visibility.

---

## 🔐 Role 1: Superadmin (`superadmin`)

**Hierarchy Level:** 11 (Absolute highest)  
**Display Name:** "Super Admin"  
**Identified By:** Firestore `roles/{uid}` document OR the hardcoded Founder UID (`pLW0PuQCTAQHCNK1SfllVhPZdMz1`)

### Access & Permissions
| Permission | Access |
|---|---|
| All site content | ✅ Full control |
| Assign roles to any user | ✅ (only role that can self-assign) |
| Delete any user | ✅ |
| Store Management | ✅ (superadmin only) |
| Financial Setup / Seed | ✅ (superadmin only) |
| Superadmin panel | ✅ (superadmin only) |
| Audit logs | ✅ |
| Backup & Restore | ✅ |
| Ban/unban users | ✅ |
| Manage all applications | ✅ |
| Set Firebase custom claims | ✅ via `/api/set-superadmin-claim` |

### Exclusive Admin Sections
- `/admin/superadmin` — Direct system control
- `/admin/store` — Store & product management
- `/admin/seed` — Financial product seeding
- `/admin/site-settings` — Global site-wide settings

### How Superadmin Is Set
1. Initial setup via the script `scripts/create-founder-role.js`
2. Subsequent users get superadmin via the `/api/set-superadmin-claim` API (requires existing superadmin token)
3. The Founder UID is hardcoded as a fallback: any user matching `NEXT_PUBLIC_FIREBASE_FOUNDER_UID` is treated as superadmin

### Scenarios
- **Happy Path:** Superadmin logs in → sent to `/admin` → sees all 8 nav groups → can click any section
- **Edge:** If Founder UID not yet set in `.env`, fallback UID is used — ensure `.env.local` has correct `NEXT_PUBLIC_FIREBASE_FOUNDER_UID`
- **Risk:** If Founder UID is leaked, anyone with that account becomes superadmin

---

## 🏛️ Role 2: Pakistan President (`president_national`)

**Hierarchy Level:** 10  
**Display Name:** "Pakistan President"  
**Purpose:** National chapter head; orchestrates all chapters across Pakistan

### Access & Permissions
| Permission | Access |
|---|---|
| Assign roles | ✅ (can assign to others, not self-assign) |
| Delete users | ✅ |
| Manage applications | ✅ |
| Manage all content | ✅ (blogs, events, announcements, etc.) |
| View application metrics | ✅ (pending/shortlisted/rejected stats) |
| Adjust points & badges | ✅ |
| Store Management | ❌ (superadmin only) |
| Superadmin panel | ❌ |

### Key Difference from Superadmin
The President cannot access Store Management or the Superadmin panel. The President can assign roles to others but cannot grant themselves a new role.

---

## 🎖️ Role 3: Vice President (`vice_president`)

**Hierarchy Level:** 9  
**Display Name:** "Vice President"  

### Access & Permissions
| Permission | Access |
|---|---|
| Manage content (blogs, events, announcements) | ✅ |
| Manage applications | ✅ |
| Manage chapters, organizations, teams | ✅ |
| Audit logs | ✅ |
| Adjust user points & badges | ✅ |
| Manage projects & tasks | ✅ |
| Assign roles | ❌ |
| Delete users | ❌ |
| Store Management | ❌ |

---

## 📝 Role 4: General Secretary (`general_secretary`)

**Hierarchy Level:** 9  
**Display Name:** "General Secretary"  

### Access & Permissions
Same as Vice President. Focus area: administration, documentation, compliance.

---

## 📁 Role 5: Projects Director (`projects_director`)

**Hierarchy Level:** 9  
**Display Name:** "Projects Director"  

### Access & Permissions
Same content management access. Additionally:
- Full `manageTasks` permission
- Full `manageProjects` permission with creation/deletion rights

---

## 📣 Role 6: Marketing Head (`marketing_head`)

**Hierarchy Level:** 9  
**Display Name:** "Marketing/Outreach Head"  

### Access & Permissions
Same leadership-level content access. Additionally:
- `manageGallery` access (upload/delete gallery images)
- `manageOwnBlogs` also applies

---

## 👥 Role 7: HR Director (`hr_director`)

**Hierarchy Level:** 9  
**Display Name:** "HR or Membership Director"  

### Access & Permissions
Same leadership-level access. Focus: User management, applications, membership.
- `manageApplications` + `listApplications` ✅
- Direct path to `/admin/submissions` for reviewing induction apps

---

## 💰 Role 8: Treasurer (`treasurer`)

**Hierarchy Level:** 9  
**Display Name:** "Treasurer"  

### Access & Permissions
Same leadership-level content access. Focus: Financial oversight.
- Can view event registrations and orders
- Cannot manage Store (superadmin only)
- Has access to audit logs for financial events

---

## 🎓 Role 9: Advisor (`advisor`)

**Hierarchy Level:** 8  
**Display Name:** "Advisor / Faculty Head"  

### Access & Permissions
Same as leadership tier for `hasSiteAdminAccess()`. Typically a faculty sponsor/advisor.

---

## 🔑 How Admin Access Is Gated (Technical)

```typescript
// In src/lib/roles.ts
export function hasSiteAdminAccess(userRole: UserRole): boolean {
  return (
    userRole === 'superadmin' ||
    userRole === 'president_national' ||
    userRole === 'vice_president' ||
    userRole === 'general_secretary' ||
    userRole === 'projects_director' ||
    userRole === 'marketing_head' ||
    userRole === 'hr_director' ||
    userRole === 'treasurer' ||
    userRole === 'advisor'
  );
}
```

The admin sidebar is only visible to users passing `hasSiteAdminAccess()`. Individual sections are further gated by `hasPermission(role, 'permissionKey')`.

---

## 📊 Admin Role Permissions Matrix

| Permission | superadmin | president | VP | gen_sec | proj_dir | mktg | hr | treasurer | advisor |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| assignRoles | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| deleteUser | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| manageApplications | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| manageEvents | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| manageBlogs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| manageProjects | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| manageTasks | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| manageGallery | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Store Mgmt | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| viewAuditLogs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| adjustUserPoints | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

*AGENT 02 sign-off: All 9 admin-tier roles fully documented with permissions, access scope, and key differences.*
