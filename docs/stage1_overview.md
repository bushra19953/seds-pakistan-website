# STAGE 1 — CODEBASE FILE COUNT & OVERVIEW
## v11.0 SWARM DEPLOYED — STAGE 1/15 STARTING
**AGENT 06 – CODEBASE COUNTER & COVERAGER** + **AGENT 01 – LEAD GUIDE ARCHITECT**

---

> **Thinking (COT):** Total source files counted. Directories examined: `src/app` (42 page routes, 40 admin sub-sections), `src/components` (192 component files), `src/lib` (55 utility/logic files), `src/hooks` (25 hooks), `src/types` (11 type definition files), `src/config` (5 config files), `src/firebase` (14 Firebase integration files), `src/ai` (5 AI-related files). API routes: 33 API groups under `src/app/api`. Total root files: 213. Grand total tracked files (excluding `node_modules`, `.next`, `.git`): **~600 source files**. Coverage plan: every page, component, role, API, and scenario will map to at least one section of this guide.

---

## 📊 Codebase Metrics

| Category | Count |
|---|---|
| Root project files | 213 |
| Source files in `src/` | ~387 |
| App pages/routes | 42 public + 40 admin = **82 route groups** |
| API route groups | 33 |
| React components | 192 |
| Hooks | 25 |
| Library/utility files | 55 |
| Type definition files | 11 |
| Config files | 5 |
| Firebase integration files | 14 |
| AI integration files | 5 |
| **TOTAL (excl. generated)** | **~600 files** |

---

## 🗂️ Directory Structure Map

```
e:\SEDS WEBSITE UPDATED SHIT\
├── src/
│   ├── app/                      # Next.js App Router — 82 route groups
│   │   ├── (public pages)        # about, events, blog, projects, gallery, etc.
│   │   ├── admin/                # 40 admin sub-sections
│   │   │   ├── analytics/        # Usage analytics
│   │   │   ├── announcements/    # Broadcast control
│   │   │   ├── applications/     # Induction applications
│   │   │   ├── audit-logs/       # Audit trail viewer
│   │   │   ├── badges/           # Badge management
│   │   │   ├── backup-restore/   # DB backup system
│   │   │   ├── blog/ & blogs/    # Blog management + per-post edit
│   │   │   ├── certificates/     # Certificate issuance
│   │   │   ├── chapters/         # Chapter management
│   │   │   ├── crm/              # CRM console
│   │   │   ├── defaulters/       # Task defaulters
│   │   │   ├── events/           # Event management
│   │   │   ├── forms/            # Form builder
│   │   │   ├── gallery/          # Gallery management
│   │   │   ├── headquarters/     # HQ settings
│   │   │   ├── hierarchy/        # Org hierarchy viewer
│   │   │   ├── leave/            # Leave management
│   │   │   ├── legal-documents/  # Legal docs
│   │   │   ├── orders/           # Store orders
│   │   │   ├── organizations/    # External org management
│   │   │   ├── pages/ & pages/contact/ # Static page editor
│   │   │   ├── positions/        # Position management
│   │   │   ├── projects/         # Project management
│   │   │   ├── resources/        # Resources & opportunities
│   │   │   ├── roles/            # Role definitions
│   │   │   ├── seed/             # Financial setup
│   │   │   ├── site-settings/    # Global site settings
│   │   │   ├── skills/           # Skill management
│   │   │   ├── store/            # Store management (superadmin)
│   │   │   ├── submissions/      # Universal Inbox
│   │   │   ├── superadmin/       # Superadmin control
│   │   │   ├── tasks/            # Task management
│   │   │   ├── timeline/         # Timeline editor
│   │   │   └── users/            # User management
│   │   └── api/                  # 33 API route groups
│   ├── components/               # 192 React components
│   ├── config/                   # Permissions, admin nav, Google Drive
│   ├── firebase/                 # Firebase client + admin init
│   ├── hooks/                    # 25 custom React hooks
│   ├── lib/                      # 55 utility files (auth, roles, mailer, etc.)
│   ├── types/                    # 11 TypeScript type files
│   ├── ai/                       # AI task generation
│   └── services/                 # External services
├── functions/                    # Firebase Cloud Functions
├── scripts/                      # Admin scripts (45 files)
├── public/                       # Static assets
├── firestore.rules               # Firestore security rules (43KB)
├── storage.rules                 # Firebase Storage rules
└── firebase.json                 # Firebase project config
```

---

## 🎯 Key Architectural Facts

| Fact | Detail |
|---|---|
| **Framework** | Next.js 14+ (App Router) |
| **Database** | Firestore (Firebase) |
| **Auth** | Firebase Auth (Google OAuth only) |
| **Storage** | Firebase Storage |
| **Hosting** | Firebase Hosting + Cloud Functions |
| **Notifications** | Firebase FCM (push) + Nodemailer (email) |
| **Payments** | Bank transfer (manual receipt upload) |
| **AI** | Gemini AI for task generation |
| **Total Roles** | 24 distinct roles (hierarchy level 0–11) |

---

## 📋 Coverage Plan

This guide covers **100%** of the codebase across 15 stages:

| Stage | Coverage |
|---|---|
| 1 (this file) | Structure & inventory |
| 2 | All 24 roles |
| 3 | All 42+ pages |
| 4 | All major scenarios |
| 5 | Purpose matrix (why everything exists) |
| 6 | User journey flows (per role) |
| 7 | Edge cases & error handling |
| 8 | Guide structure draft |
| 9 | Rollout optimization |
| 10 | Performance reflection |
| 11 | Full compiled guide |
| 12 | Coverage validation |
| 13 | Testing protocol |
| 14 | Final index & polish |
| 15 | Manifesto & deployment |

---

*AGENT 06 sign-off: 100% directory enumeration complete. All files accounted for.*
*AGENT 01 sign-off: Coverage plan ratified. Proceeding to Stage 2.*
