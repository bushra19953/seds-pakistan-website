# STAGE 3 — PAGE BREAKDOWN: ADMIN DASHBOARD
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 3 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The admin dashboard is the command center for all admin-tier roles. It fetches key metrics via `/api/admin/dashboard/init`, streams real-time audit logs via Firestore WebSocket, and filters quick actions by individual role permissions. It is the first page all admins see after signing in.

---

## 🎛️ Page: Admin Dashboard (`/admin`)

**File:** `src/app/admin/page.tsx` (11.5 KB)  
**Access:** Any role with `hasSiteAdminAccess()` returns `true`  
**Purpose:** Real-time overview + quick action launchpad for all admin-tier users

---

## Dashboard Sections

### 1. Metric Cards (Top Row)
Four stat cards, always visible to all admins:
| Card | Data Source | Firestore Collection |
|---|---|---|
| 👥 Users | Total registered users | `users` count |
| 📁 Projects | Active projects | `projects` count |
| 📰 Blogs | Published articles | `blogs` count |
| 📅 Events | Scheduled events | `events` count |

### 2. Application Metrics (President+ Only)
Three additional stat cards visible only to `president_national` and above:
| Card | Data |
|---|---|
| 📋 Pending Applications | Awaiting review |
| ✅ Shortlisted | Ready to invite |
| ❌ Rejected | Closed cases |

### 3. Quick Actions Grid
Dynamically shows only the actions the current user has permission for:

| Action | Link | Required Permission |
|---|---|---|
| New Blog Post | `/admin/blogs/new` | `manageBlogs` |
| New Event | `/admin/events/new` | `manageEvents` |
| Manage Announcements | `/admin/announcements` | `manageAnnouncements` |
| Manage Projects | `/admin/projects` | `manageProjects` |
| Review Applications | `/admin/applications` | `listApplications` |
| View Audit Logs | `/admin/audit-logs` | `viewAuditLogs` |

### 4. Recent Activity (Real-time)
- **Source:** Firestore `audit_logs` collection via real-time `onSnapshot`
- **Visible to:** Roles with `listAuditLogs` permission
- **Shows:** Action name, target resource (truncated), relative timestamp
- **Updates:** Live — no page refresh needed
- **Deduplication:** Rapid repeated actions are compressed (e.g., "ASSIGN_ROLE (x5)")

---

## Admin Sidebar Navigation Groups

Full nav groups (from `src/config/admin-nav.ts`):

```
📊 Overview
  ├── Dashboard              /admin
  ├── Site Settings          /admin/site-settings
  └── Audit Logs             /admin/audit-logs

👥 User Management
  ├── Users                  /admin/users
  ├── Role Definitions       /admin/roles
  └── Defaulters             /admin/defaulters

📬 Action Center
  └── Universal Inbox        /admin/submissions

📝 Content Management
  ├── Blogs                  /admin/blog
  ├── Events                 /admin/events
  ├── AI Sponsor Match       /admin/events/sponsor-match
  ├── Announcements          /admin/announcements
  ├── Pages                  /admin/pages
  ├── Contact Page           /admin/pages/contact
  ├── Resources & Opps       /admin/resources
  ├── CRM Console            /admin/crm
  └── Gallery                /admin/gallery

🗂️ Projects & Tasks
  ├── Projects               /admin/projects
  └── Tasks                  /admin/tasks

📅 Programs
  └── Timeline               /admin/timeline

🏢 Organization
  ├── Hierarchy              /admin/hierarchy
  ├── Positions              /admin/positions
  ├── Skills                 /admin/skills
  ├── Badges                 /admin/badges
  ├── Certificates           /admin/certificates
  ├── Chapters               /admin/chapters
  └── Organizations          /admin/organizations

⚙️ Operations
  ├── Forms                  /admin/forms
  ├── Backup & Restore       /admin/backup-restore
  └── Analytics              /admin/analytics

👑 Administration (Superadmin+ only)
  ├── Superadmin             /admin/superadmin
  ├── Store Management       /admin/store
  └── Financial Setup        /admin/seed
```

---

## Access by Role

| Role | Sidebar Visible | Sections Available |
|---|---|---|
| `superadmin` | ✅ All 9 groups | Everything |
| `president_national` | ✅ 8 groups | All except Store/Superadmin |
| VP/GM/Directors | ✅ 7–8 groups | Content + org sections |
| `chair_projects` | ✅ Limited | Projects, Events, Blogs (admin nav may not show) |
| `chair_events` | ✅ Limited | Events, Announcements |
| `member`/`guest` | ❌ Hidden | None |

---

## Performance Notes
- Dashboard data cached for 60 seconds (stale-while-revalidate on `/api/admin/dashboard/init`)
- Real-time audit feed uses Firestore's native WebSocket — no polling overhead
- Metric cards show skeleton loading state while data fetches

---

*AGENT 03 sign-off: Admin dashboard fully documented.*
