# STAGE 8-10 — GUIDE STRUCTURE, ROLLOUT OPTIMIZATION & PERFORMANCE
## v11.0 SWARM DEPLOYED — STAGES 8-10/15
**AGENT 09 – GUIDE COMPILER | AGENT 10 – ROLLOUT OPTIMIZER | AGENT 11 – PERFORMANCE AUDITOR**

---

## STAGE 8 — GUIDE STRUCTURE DRAFT

> **Thinking (COT):** The guide must be usable without reading top to bottom. Structure by role (who are you?), then by intent (what do you want to do?). Each section is self-contained.

### Recommended Guide Structure

```
SEDS Pakistan Website — Full Usage Guide
├── PART 1: QUICK START (2 pages)
│   ├── What is SEDS Pakistan?
│   ├── How to log in (Google OAuth, 30 seconds)
│   ├── "I am a [Guest / Member / Admin]" quick-start paths
│   └── Critical first steps per role
│
├── PART 2: ROLES & PERMISSIONS
│   ├── 1-page visual role hierarchy
│   ├── Per-role access tables
│   └── How roles are assigned
│
├── PART 3: PAGE-BY-PAGE GUIDE
│   ├── Public pages (Home, Events, Blog, About, Apply)
│   ├── Member pages (Profile, Tasks, Notifications, Community)
│   └── Admin pages (Dashboard + all 40 sub-sections)
│
├── PART 4: SCENARIO WALKTHROUGHS
│   ├── "I want to register for an event"
│   ├── "I want to create an event"
│   ├── "I want to approve a payment"
│   ├── "I want to induct a new member"
│   ├── "I want to assign tasks and track progress"
│   ├── "I want to broadcast an announcement"
│   └── "Something went wrong — troubleshooting"
│
├── PART 5: DATA & INTEGRATION REFERENCE
│   ├── Firestore collections map
│   ├── API routes reference
│   ├── Notification channels
│   └── File storage structure
│
└── PART 6: OPERATIONS MANUAL
    ├── First-time setup checklist
    ├── Monthly admin routines
    ├── Emergency procedures
    └── Contacts / escalation paths
```

---

## STAGE 9 — ROLLOUT OPTIMIZATION

> **Thinking (COT):** The guide needs to be immediately usable by: (1) new admins who have never seen the site, (2) members who only use their profile and events, (3) external reviewers who need to understand the system. Make it printable, searchable, and indexed.

### PDF Export Instructions
1. Open the full guide (`stage11_full_guide.md`) in any markdown renderer (Typora, VS Code Preview, GitHub)
2. Use browser Print → Save as PDF
3. Or: Use `pandoc stage11_full_guide.md -o seds_usage_guide.pdf --pdf-engine=wkhtmltopdf`
4. Bookmarks auto-generated from heading structure (H1/H2/H3)

### Search Keywords Index

| Keyword | Find In Section |
|---|---|
| "sign in" / "login" | Part 1: Quick Start |
| "register for event" | Part 4: Scenarios |
| "payment" / "receipt" | Part 4: Scenarios, Store |
| "ticket" / "QR code" | Events Page, Ticket Studio |
| "ban" / "unban" | Admin — User Management |
| "role" / "permission" | Part 2: Roles |
| "task" / "points" | Member Pages, Tasks |
| "notification" / "push" | Notifications |
| "apply" / "induction" | Apply Page, Applications |
| "announcement" / "ticker" | Announcements, Home Page |
| "store" / "product" | Store Pages, Checkout |
| "certificate" | Admin Certificates |
| "blog" / "article" | Blog Pages |
| "project" | Projects Pages |
| "chapter" | Chapter Management |
| "audit log" | Admin Dashboard |
| "error" / "broken" | Edge Case Audit |

### Rollout Package Checklist
- [ ] `stage11_full_guide.md` — Master guide
- [ ] `stage14_final_guide_index.md` — Searchable index
- [ ] `stage2_admin_role.md` — For admin onboarding
- [ ] `stage2_member_guest_role.md` — For member onboarding
- [ ] `stage4_login_scenarios.md` — First-day guide
- [ ] `stage6_user_journey_flows.md` — Visual flows
- [ ] PDF export of `stage11_full_guide.md`

---

## STAGE 10 — PERFORMANCE REFLECTION

> **Thinking (COT):** Guide users toward efficient site usage. Document known slow operations and best practices to avoid degrading the platform.

### ⚡ Performance Notes for Guide Users

#### Admin Operations That Are Slow

| Operation | Why Slow | Best Practice |
|---|---|---|
| Dashboard initial load | Fetches counts from multiple Firestore collections | Normal; wait 2–3 seconds on first load |
| First admin page visit | Firebase Function cold start | First request after inactivity is slow; refresh if >10s |
| AI task generation | Gemini API round-trip | Allow 3–8 seconds; don't double-click |
| Leaderboard aggregate | Multi-user aggregation | Cached; refresh manually if stale |
| Backup & Restore | Large Firestore export | Don't run during peak hours; expect 30–60 seconds |
| Event registration bulk | Many simultaneous registrations | Firestore handles concurrency; don't manually intervene |

#### Firestore Usage Tips
- Search in admin UIs uses client-side filtering — it loads the full collection first
- For very large sets (1000+ users), use server-side filters via URL params
- Avoid opening the same page in multiple tabs simultaneously when editing content

#### Storage Tips
- Event banner images: optimize to < 500KB before uploading (reduces load time)
- Receipt images: JPG format preferred (smaller than PNG for photos)
- Ticket template images: PNG recommended (transparency support, ~200KB ideal)

#### Recommended Admin Routine
```
DAILY (5 min):
  ✓ Check /admin/submissions for pending items
  ✓ Check /admin/orders for unverified payments
  ✓ Check /admin/defaulters for overdue tasks

WEEKLY (30 min):
  ✓ Review new applications in Universal Inbox
  ✓ Publish any drafted blog posts or events
  ✓ Clear expired announcements (past broadcastUntil)
  ✓ Review audit logs for any anomalies

MONTHLY (1 hr):
  ✓ Update leadership hierarchy (/admin/hierarchy)
  ✓ Award badges/certificates to deserving members
  ✓ Review and adjust role assignments
  ✓ Run backup from /admin/backup-restore
  ✓ Check Firebase console for quota warnings
```

---

*AGENT 09, 10, 11 sign-off: Guide structure, rollout optimization, and performance notes complete.*
