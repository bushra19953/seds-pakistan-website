# STAGE 2 — ROLE BREAKDOWN: CHAIR & SPECIALIST ROLES
## v11.0 SWARM DEPLOYED — STAGE 2/15 (ROLE 2 of 5)
**AGENT 02 – ROLE DISSECTOR**

---

> **Thinking (COT):** Chair roles (level 8) are committee leads. They have admin sidebar access only for their domain. Team roles (level 7: rocketry, cubesat, rover) are project team members. Member (level 1) and Guest (level 0) are standard users. Each has specific content permissions but cannot access most admin sections.

---

## 🏗️ Chair Roles (Hierarchy Level 8)

All chair roles share the `hasSiteAdminAccess() = false` status **UNLESS** explicitly listed. Wait — checking `src/lib/roles.ts`... Chairs are **NOT** in `hasSiteAdminAccess()`. They do NOT see the admin sidebar.

However, chairs **DO** appear in specific permissions:
- `chair_projects`: manageProjects, manageBlogs, manageEvents, manageAnnouncements, viewAuditLogs, adjustUserPoints, adjustUserBadges, manageChapters, manageOrganizations, manageBadges
- `chair_marketing`: manageBlogs (**own only** via `manageOwnBlogs`), manageGallery, canManageGallery
- `chair_events`: manageEvents, manageBlogs, manageAnnouncements, viewAuditLogs, adjustUserBadges, listEventRegistrations

### Chair Roles Breakdown

| Role Key | Display Name | Level | Key Permissions |
|---|---|---|---|
| `chair_projects` | Chair Projects Committee | 8 | manageProjects, manageTasks, manageBlogs, manageEvents |
| `chair_marketing` | Chair Marketing & Communications | 8 | manageOwnBlogs, manageGallery |
| `chair_outreach` | Chair Outreach Committee | 8 | Standard member access |
| `chair_design` | Chair Design / Media | 8 | Standard member access |
| `chair_alumni` | Chair Alumni / Legacy Network | 8 | Standard member access |
| `chair_events` | Chair Events Committee | 8 | manageEvents, manageAnnouncements, listEventRegistrations |
| `chair_recruitment` | Chair Recruitment / Membership | 8 | Standard member access |
| `chair_ethics` | Chair Ethics / Sustainability | 8 | Standard member access |
| `chair_sponsorship` | Chair Sponsorship / Finance | 8 | Standard member access |

> ⚠️ **Important:** `chair_outreach`, `chair_design`, `chair_alumni`, `chair_recruitment`, `chair_ethics`, `chair_sponsorship` do NOT appear in any explicit permission grant in `permissions.ts`. They have standard member-level access. Their "level 8" is for hierarchy comparison only.

---

## 🚀 Team Roles (Hierarchy Level 7)

| Role Key | Display Name | Level | Access |
|---|---|---|---|
| `rocketry_team` | Rocketry Team | 7 | Member-level access |
| `cubesat_team` | CubeSat/CanSat Team | 7 | Member-level access |
| `rover_team` | Rover Team | 7 | Member-level access |

Team roles are organizational labels for project team members. They do not grant elevated admin permissions. They appear in the org hierarchy and leaderboard.

---

## 👤 Role: Member (`member`)

**Hierarchy Level:** 1  
**Display Name:** "Member"  
**This is the standard role for all inducted SEDS members.**

### What Members Can Do
| Feature | Access |
|---|---|
| View all public pages | ✅ |
| View member-visibility events | ✅ |
| Register for events | ✅ |
| View and buy from Store | ✅ |
| Edit own profile | ✅ |
| Submit leave requests | ✅ |
| View own tasks | ✅ |
| Submit task completion requests | ✅ |
| View leaderboard | ✅ |
| Receive notifications | ✅ |
| Submit induction application | ❌ (already a member) |
| Access admin panel | ❌ |
| Manage any content globally | ❌ |

### Member Profile Fields
- `displayName`, `email`, `bio`, `photoURL`
- `githubUrl`, `linkedinUrl`, `whatsappNumber`
- `university`, `fieldOfStudy`, `chapterId`
- `points` (earned from tasks)
- `badges` (awarded by admins)
- `warningCount`, `isBanned`, `banReason`

### Member Lifecycle
```
Guest → Submits induction form → Application reviewed → Invited via /invite → 
Joins via Google OAuth → Role set to 'member' → Active member with full member access
```

---

## 👁️ Role: Guest (`guest`)

**Hierarchy Level:** 0  
**Display Name:** "Guest"  
**Assigned to all new users before induction OR users without a Firestore role document.**

### What Guests Can Do
| Feature | Access |
|---|---|
| View all public pages | ✅ |
| View public events | ✅ |
| Sign in with Google | ✅ |
| Submit induction application | ✅ via `/apply` |
| Buy from Store | ✅ (must be signed in) |
| Register for public events | ✅ (must be signed in) |
| View own profile (basic) | ✅ |
| Edit profile | ✅ (limited fields) |
| Access admin panel | ❌ |
| View member-only events | ❌ |
| Earn task points | ❌ |

### Guest → Member Conversion
1. Guest visits `/apply` and submits induction form
2. HR Director reviews the application in `/admin/submissions`
3. If shortlisted → admin sends invite link via `/admin/applications`
4. Guest receives invite email and joins
5. Admin sets role to `member` in `/admin/users`

---

## 🔒 Banned Users

Banned users are identified by `isBanned: true` in their Firestore `users/{uid}` document.

### What Happens to Banned Users
- On any API call: auth middleware detects ban → returns `redirectTo: '/banned'`
- Front-end: user is redirected to the `/banned` page immediately
- The `/banned` page shows the ban reason (`banReason` field)
- Banned users cannot:
  - Register for events
  - Make purchases
  - Access any authenticated page

### How to Ban a User (Admin)
1. Go to `/admin/users`
2. Find the user
3. Click "Ban User" → enter reason → confirm
4. System sets `isBanned: true` and `banReason` in Firestore

---

## 📊 Role Hierarchy Summary

```
Level 11: superadmin          ← Absolute god-mode
Level 10: president_national  ← National chapter president
Level  9: vice_president, general_secretary, projects_director,
          marketing_head, hr_director, treasurer ← Executive team
Level  8: advisor, chair_* (9 chair roles)       ← Committee leads
Level  7: rocketry_team, cubesat_team, rover_team ← Project teams
Level  1: member                                  ← Standard members
Level  0: guest                                   ← Unverified/new users
```

---

*AGENT 02 sign-off: All non-admin roles documented. Role hierarchy fully established. 24 roles total.*
