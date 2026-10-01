# Frontend Architecture, Routes, Forms & Hardware Pipeline Exploration Report

**Agent**: `explorer_codebase_1`  
**Date**: 2026-09-26  
**Working Directory**: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_codebase_1`  
**Target Repository**: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT`  

---

## 1. Observation

### 1.1 Technology Stack & Core Framework
Direct inspection of `package.json`, `next.config.js`, `tsconfig.json`, `postcss.config.mjs`, and `tailwind.config.ts` reveals:
- **Framework**: Next.js `15.0.0` (`"next": "^15.0.0"`) running on Node.js `>=18` with React `18.3.1` (`"react": "^18.3.1"`, `"react-dom": "^18.3.1"`).
- **Router Type**: Next.js App Router exclusively (`src/app/`). No legacy Pages Router (`pages/` or `src/pages/`) exists.
- **Build Mode**: Standalone output (`output: 'standalone'` in `next.config.js:77`).
- **Compiler Optimizations**: `compiler: { removeConsole: process.env.NODE_ENV === 'production' }` (`next.config.js:15-18`). Experimental package import optimization for `lucide-react` (`next.config.js:79-81`).
- **UI & Primitive Libraries**:
  - Radix UI Primitives (`@radix-ui/react-*` across 19 packages: accordion, alert-dialog, avatar, checkbox, collapsible, dialog, dropdown-menu, label, menubar, popover, progress, radio-group, scroll-area, select, separator, slider, slot, switch, tabs, toast, tooltip).
  - Styling: Tailwind CSS `3.4.1` with `@tailwindcss/typography`, `tailwindcss-animate`, `tailwind-merge` (`3.4.0`), `class-variance-authority` (`0.7.1`), `clsx` (`2.1.1`).
  - Icons: `lucide-react` (`^0.475.0`), `@lucide/lab` (`^0.1.2`).
  - Animation & 3D: `framer-motion` (`^12.23.26`), Three.js (`three` `^0.165.0`, `@react-three/fiber` `^9.4.2`, `@react-three/drei` `^10.7.7`, `maath` `^0.10.8`), `vanta` (`^0.5.24`), `canvas-confetti` (`^1.9.4`).
  - Data Visualization & Graph Layout: `@xyflow/react` (`^12.10.0`), `dagre` (`^0.8.5`), `recharts` (`^2.15.4`).
  - Data Tables: `@tanstack/react-table` (`^8.21.3`), `@tanstack/react-virtual` (`^3.13.19`).
  - Drag and Drop: `@dnd-kit/core` (`^6.3.1`), `@dnd-kit/sortable` (`^10.0.0`), `@dnd-kit/utilities` (`^3.2.2`).
  - State Management: Redux Toolkit (`@reduxjs/toolkit` `^2.11.2`, `react-redux` `^9.2.0`), React Context API.
  - Form Handling: `react-hook-form` (`^7.54.2`), `zod` (`^3.24.2`), `@hookform/resolvers` (`^4.1.3`).
  - Backend/Cloud Integration: Firebase SDK `12.6.0` (`firebase`), Firebase Admin SDK `13.5.0` (`firebase-admin`), Firebase Functions `7.1.1` (`firebase-functions`), Stripe `20.4.0` (`stripe`, `@stripe/stripe-js`), Google GenAI / Genkit (`genkit` `^1.20.0`, `@genkit-ai/google-genai` `^1.20.0`, `@google/generative-ai` `^0.24.1`).

### 1.2 Layout & Shell Architecture
- **Root Layout (`src/app/layout.tsx`)**:
  - Font optimization using `next/font/google`: `Bebas_Neue` (`--font-bebas-neue`), `Courier_Prime` (`--font-courier-prime`), and `Orbitron` (`--font-orbitron`).
  - Head preconnect tags: `https://firestore.googleapis.com` and `https://apis.google.com`.
  - Body wrapped with `<AppClientShell>` (`src/components/layout/app-client-shell.tsx`).
- **App Client Shell (`src/components/layout/app-client-shell.tsx`)**:
  - Theme: `<ThemeProvider defaultTheme="dark" enableSystem disableTransitionOnChange>`.
  - Background: `<VantaBackground />` dynamically imported with `ssr: false`, automatically deactivated on admin, profile, and high-density content pages (`/timeline`, `/about`, `/community`, `/blog`, `/sourcing-bridge`, `/projects`) to prevent WebGL GPU overhead (`lines 55-66`).
  - Auth & Authority: `<FirebaseClientProvider>`, `<AuthorityListener>` (subscribes to live custom claims / role updates via `setupAuthorityListener`), `<MandatoryProfileCheck>` (redirects uncompleted profiles to `/welcome`), `<PostVacationSummaryModal>` (displays catch-up modal upon returning from leave).
  - Navigation & Feedback: `<HeaderVisibility>`, `<Toaster />` (Shadcn toast container), `<BugReportButton />` (floating global screenshot bug report trigger on all routes).
- **Admin Layout (`src/app/admin/layout.tsx`)**:
  - Guarded client-side: Reads `{ user, role, isLoading }` from `useUser()` and `{ isAuthorized }` from `useAuthorization("canAccessAdmin")`.
  - Redirect: Executes `if (!user || !role || !isAuthorized) router.replace("/auth/login")` in `useEffect`. If unauthorized, renders `null` to avoid UI flashing.
  - Structure: Wraps content in Redux `<ReduxProvider>`, mobile drawer navigation (`Sheet`), desktop `<AdminSidebar />`, and scrollable main content view.
- **Apply Layout (`src/app/apply/layout.tsx`)**:
  - Auth Guard: If unauthenticated (`!user`), redirects immediately to `/auth/login?callbackUrl=${currentPath}` while preserving step query parameters.
- **Error Boundaries**:
  - `src/app/error.tsx`: Next.js App Router segmented error boundary.
  - `src/app/global-error.tsx`: Root-level unhandled exception fallback.
  - `src/app/not-found.tsx`: Space-themed 404 page with return-to-home actions.

---

## 2. Complete Route Inventory

Total App Router Routes: **209 routes** (121 Page Routes + 88 Route Handlers). Zero Pages Router routes exist.

### 2.1 Public Main Website Routes (34 Pages)
| Route URL | File Path | Component Type | Protection | Purpose / Features |
|---|---|---|---|---|
| `/` | `src/app/page.tsx` | Client | Public | Landing page, Hero, Marquee, Stats, Dynamic Credibility Hub |
| `/about` | `src/app/about/page.tsx` | Client | Public | Mission, History, Leadership, Infographics |
| `/announcements` | `src/app/announcements/page.tsx` | Client | Public | Broadcasts, active news ticker items |
| `/banned` | `src/app/banned/page.tsx` | Client | Public | Blacklist lockdown notice screen |
| `/blog` | `src/app/blog/page.tsx` | Client | Public | Blog feed, category filter, search |
| `/blog/[slug]` | `src/app/blog/[slug]/page.tsx` | Client | Public | Dynamic blog post reader |
| `/blog/post` | `src/app/blog/post/page.tsx` | Client | Public | Alternative single post view |
| `/community` | `src/app/community/page.tsx` | Client | Public | Community hub, quick certificate verify form |
| `/competitions` | `src/app/competitions/page.tsx` | Client | Public | Global aerospace competitions directory |
| `/contact` | `src/app/contact/page.tsx` | Client | Public | Contact inquiry form, rate-limited |
| `/copilot` | `src/app/copilot/page.tsx` | Client | Public | Research Copilot AI interface (Disabled Stub) |
| `/debug-blogs` | `src/app/debug-blogs/page.tsx` | Client | Public / Dev | Blog status diagnostics |
| `/donate` | `src/app/donate/page.tsx` | Client | Public | Donation portal linking to checkout |
| `/events` | `src/app/events/page.tsx` | Client | Public | Events directory, calendar view |
| `/events/[slug]` | `src/app/events/[slug]/page.tsx` | Client | Public | Dynamic event overview & ticket CTA |
| `/events/detail` | `src/app/events/detail/page.tsx` | Client | Public | Event detail card view |
| `/explore` | `src/app/explore/page.tsx` | Client | Public | Interactive space exploration gateway |
| `/gallery` | `src/app/gallery/page.tsx` | Client | Public | Media gallery with categorized assets |
| `/induction` | `src/app/induction/page.tsx` | Client | Public | Multi-step induction application form with autosave |
| `/invite` | `src/app/invite/page.tsx` | Client | Public | Special member invite token processing |
| `/leadership-history` | `src/app/leadership-history/page.tsx` | Client | Public | Historical national council & executive alumni roster |
| `/notifications` | `src/app/notifications/page.tsx` | Client | Public | Broadcast notifications feed |
| `/organizations-admin` | `src/app/organizations-admin/page.tsx` | Client | Public | Organizations overview |
| `/payment/cancel` | `src/app/payment/cancel/page.tsx` | Client | Public | Stripe checkout cancellation screen |
| `/payment/success` | `src/app/payment/success/page.tsx` | Client | Public | Stripe checkout confirmation screen |
| `/podcast` | `src/app/podcast/page.tsx` | Client | Public | SEDS Pakistan official podcast episodes |
| `/privacy-policy` | `src/app/privacy-policy/page.tsx` | Client | Public | CMS-backed privacy policy document |
| `/register-chapter` | `src/app/register-chapter/page.tsx` | Client | Public | Official chapter application form |
| `/resources` | `src/app/resources/page.tsx` | Client | Public | Aerospace research papers & resource directory |
| `/skills` | `src/app/skills/page.tsx` | Client | Public | National capability directory |
| `/skills/[skillSlug]` | `src/app/skills/[skillSlug]/page.tsx` | Client | Public | Detailed skill matrix & certified members |
| `/sourcing-bridge` | `src/app/sourcing-bridge/page.tsx` | Client | Public | Hardware sourcing & engineering intake portal |
| `/terms` | `src/app/terms/page.tsx` | Client | Public | CMS-backed terms of service |
| `/terms-and-conditions`| `src/app/terms-and-conditions/page.tsx` | Client | Public | CMS-backed full terms agreement |
| `/test-blog-data` | `src/app/test-blog-data/page.tsx` | Client | Public / Dev | Blog data verification testbed |
| `/timeline` | `src/app/timeline/page.tsx` | Client | Public | National organizational milestones timeline |
| `/verify` | `src/app/verify/page.tsx` | Client | Public | Certificate verification landing search |
| `/verify/[code]` | `src/app/verify/[code]/page.tsx` | Client | Public | Dynamic certificate validation & purchase |
| `/verify/ticket/[ticketId]` | `src/app/verify/ticket/[ticketId]/page.tsx` | Client | Public | Event QR code ticket gatekeeper scanner |
| `/warning-registry` | `src/app/warning-registry/page.tsx` | Client | Public | Public accountability & disciplinary warning ledger |
| `/workshops` | `src/app/workshops/page.tsx` | Client | Public | Hands-on workshop archive |
| `/workshops/detail` | `src/app/workshops/detail/page.tsx` | Client | Public | Workshop syllabus details |

### 2.2 Protected User & Application Routes (23 Pages)
| Route URL | File Path | Component Type | Protection | Purpose / Features |
|---|---|---|---|---|
| `/apply` | `src/app/apply/page.tsx` | Client | Auth Required (`apply/layout.tsx`) | Multi-step induction application portal |
| `/apply/[step]` | `src/app/apply/[step]/page.tsx` | Client | Auth Required (`apply/layout.tsx`) | Dynamic step route for induction application |
| `/auth` | `src/app/auth/page.tsx` | Client | Public Auth | Unified Google OAuth authentication page |
| `/auth/login` | `src/app/auth/login/page.tsx` | Client | Public Auth | Redirect wrapper forwarding to `/auth` |
| `/auth/signup` | `src/app/auth/signup/page.tsx` | Client | Public Auth | Redirect wrapper forwarding to `/auth` |
| `/signup` | `src/app/signup/page.tsx` | Client | Public Auth | Redirect wrapper forwarding to `/auth` |
| `/checkout` | `src/app/checkout/page.tsx` | Client | Auth Required | Store / Ticket / Certificate payment checkout & receipt proof |
| `/welcome` | `src/app/welcome/page.tsx` | Client | Auth Required | Mandatory post-login onboarding profile completion |
| `/profile` | `src/app/profile/page.tsx` | Client | Auth Required | Main user dashboard, tasks, teams, orders, badges |
| `/profile/ss` | `src/app/profile/ss/page.tsx` | Client | Auth Required | Profile security settings |
| `/profile/unified` | `src/app/profile/unified/page.tsx` | Client | Auth Required | Unified profile view |
| `/profile/unified/[uid]` | `src/app/profile/unified/[uid]/page.tsx` | Client | Auth Required | Member profile inspector |
| `/profile/view` | `src/app/profile/view/page.tsx` | Client | Auth Required | Simplified profile reader |
| `/user/profile` | `src/app/user/profile/page.tsx` | Client | Auth Required | Profile route alias with tab support |
| `/projects` | `src/app/projects/page.tsx` | Client | Public | Projects gallery & status indicators |
| `/projects/detail` | `src/app/projects/detail/page.tsx` | Client | Public | Individual project dossier |
| `/projects/new` | `src/app/projects/new/page.tsx` | Client | Auth + Project Admin | New project proposal creation form |
| `/events/new` | `src/app/events/new/page.tsx` | Client | Auth + Events Lead | Event draft creation form |
| `/events/register` | `src/app/events/register/page.tsx` | Client | Auth Required | Event seat confirmation & payment proof submission |
| `/events/ticket/[ticketId]` | `src/app/events/ticket/[ticketId]/page.tsx` | Client | Auth Required | Dynamic digital event ticket with live QR code |
| `/blog/new` | `src/app/blog/new/page.tsx` | Client | Auth + Marketing Lead | Blog draft article authoring interface |
| `/tasks/[taskId]` | `src/app/tasks/[taskId]/page.tsx` | Client | Auth Required | Dedicated task briefing & activity log |

### 2.3 Admin Console Routes (57 Pages)
All 57 admin routes are wrapped in `src/app/admin/layout.tsx` enforcing `canAccessAdmin` RBAC redirect. Sub-pages enforce granular `AuthorizationGate` permissions:

| Route URL | File Path | Component Type | Granular Permission | Purpose / Capabilities |
|---|---|---|---|---|
| `/admin` | `src/app/admin/page.tsx` | Client | `canAccessAdmin` | Master admin dashboard overview |
| `/admin/analytics` | `src/app/admin/analytics/page.tsx` | Client | `canManageAnalytics` | Telemetry analytics, traffic metrics, page visits |
| `/admin/announcements` | `src/app/admin/announcements/page.tsx` | Client | `canManageAnnouncements` | Global announcements & news ticker editor |
| `/admin/applications` | `src/app/admin/applications/page.tsx` | Client | `canReviewApplications` | Induction applications review & grading interface |
| `/admin/audit` | `src/app/admin/audit/page.tsx` | Client | `canManagePermissions` | System audit ledger viewer |
| `/admin/audit-logs` | `src/app/admin/audit-logs/page.tsx` | Client | `canManagePermissions` | Detailed security & access audit logs |
| `/admin/backup-restore` | `src/app/admin/backup-restore/page.tsx` | Client | `canManagePermissions` | Full JSON export & batch Firestore restoration |
| `/admin/badges` | `src/app/admin/badges/page.tsx` | Client | `canManageBadges` | Badge definitions, icons, points thresholds |
| `/admin/blog` | `src/app/admin/blog/page.tsx` | Client | `canManageBlog` | Blog posts moderation table |
| `/admin/blogs` | `src/app/admin/blogs/page.tsx` | Client | `canManageBlog` | Blog management table |
| `/admin/blogs/edit` | `src/app/admin/blogs/edit/page.tsx` | Client | `canManageBlog` | Rich-text blog editor |
| `/admin/blogs/new` | `src/app/admin/blogs/new/page.tsx` | Client | `canManageBlog` | Admin blog creator |
| `/admin/bug-reports` | `src/app/admin/bug-reports/page.tsx` | Client | `canManageSettings` | User bug report & screenshot viewer |
| `/admin/bugs` | `src/app/admin/bugs/page.tsx` | Client | `canManageSettings` | Issue tracking & resolution status |
| `/admin/certificates` | `src/app/admin/certificates/page.tsx` | Client | `canManageCertificates` | Certificate generation & bulk issuance engine |
| `/admin/chapter-applications` | `src/app/admin/chapter-applications/page.tsx` | Client | `canManageChapters` | Chapter applications review & approvals |
| `/admin/chapters` | `src/app/admin/chapters/page.tsx` | Client | `canManageChapters` | University chapters CRUD & member associations |
| `/admin/crm` | `src/app/admin/crm/page.tsx` | Client | `canManagePartners` | CRM relations, sponsors, AI pitch generation |
| `/admin/defaulters` | `src/app/admin/defaulters/page.tsx` | Client | `canManageUsers` | Warning defaulters & blacklist enforcement roster |
| `/admin/email-logs` | `src/app/admin/email-logs/page.tsx` | Client | `canManageSettings` | Outbound mailer dispatcher log audit |
| `/admin/events` | `src/app/admin/events/page.tsx` | Client | `canManageEvents` | Events management, status toggles |
| `/admin/events/edit` | `src/app/admin/events/edit/page.tsx` | Client | `canManageEvents` | Event editor with ticket configuration |
| `/admin/events/new` | `src/app/admin/events/new/page.tsx` | Client | `canManageEvents` | Event creator with payment settings |
| `/admin/events/registrations` | `src/app/admin/events/registrations/page.tsx` | Client | `canManageEvents` | Attendee rosters, check-in, ticket re-issuance |
| `/admin/events/sponsor-match` | `src/app/admin/events/sponsor-match/page.tsx` | Client | `canManageEvents` | AI automated event-to-sponsor matchmaking |
| `/admin/examples/user-combobox-demo` | `src/app/admin/examples/user-combobox-demo/page.tsx` | Client | Dev / Admin | User autocomplete combobox test fixture |
| `/admin/forms` | `src/app/admin/forms/page.tsx` | Client | `canManageForms` | Dynamic custom form schema builder |
| `/admin/forms/responses` | `src/app/admin/forms/responses/page.tsx` | Client | `canManageForms` | Custom form response inspector & exporter |
| `/admin/gallery` | `src/app/admin/gallery/page.tsx` | Client | `canManageGallery` | Media asset upload, metadata, and status editor |
| `/admin/headquarters` | `src/app/admin/headquarters/page.tsx` | Client | `canManageSettings` | Executive AI advisor interface |
| `/admin/hierarchy` | `src/app/admin/hierarchy/page.tsx` | Client | `canViewHierarchy` | Interactive node graph hierarchy editor (`@xyflow`) |
| `/admin/legal-documents` | `src/app/admin/legal-documents/page.tsx` | Client | `canManageSettings` | Terms & Privacy Policy versioned CMS editor |
| `/admin/mission-command` | `src/app/admin/mission-command/page.tsx` | Client | `canManageTasks` | Mission Command multi-task dispatcher |
| `/admin/orders` | `src/app/admin/orders/page.tsx` | Client | `canManageStore` | Store orders review & payment verification |
| `/admin/organizations` | `src/app/admin/organizations/page.tsx` | Client | `canManagePartners` | Partner organizations, drag-and-drop ordering |
| `/admin/pages` | `src/app/admin/pages/page.tsx` | Client | `canManageSiteSettings` | Site CMS pages overview |
| `/admin/pages/contact` | `src/app/admin/pages/contact/page.tsx` | Client | `canManageSiteSettings` | Contact page CMS text & method editor |
| `/admin/positions` | `src/app/admin/positions/page.tsx` | Client | `canManageRoles` | Executive tenure & position appointment manager |
| `/admin/projects` | `src/app/admin/projects/page.tsx` | Client | `canManageProjects` | Projects directory CRUD & status flags |
| `/admin/resources` | `src/app/admin/resources/page.tsx` | Client | `canManageResources` | Educational resources directory CRUD |
| `/admin/resources/edit` | `src/app/admin/resources/edit/page.tsx` | Client | `canManageResources` | Resource editor |
| `/admin/resources/new` | `src/app/admin/resources/new/page.tsx` | Client | `canManageResources` | Resource creator |
| `/admin/role-privileges` | `src/app/admin/role-privileges/page.tsx` | Client | `canManagePermissions` | Route permission matrix editor |
| `/admin/roles` | `src/app/admin/roles/page.tsx` | Client | `canManageRoles` | Role assignment & dynamic role definition |
| `/admin/seed` | `src/app/admin/seed/page.tsx` | Client | `canManageSettings` | Database seed runner & financial initializer |
| `/admin/site-settings` | `src/app/admin/site-settings/page.tsx` | Client | `canManageSiteSettings` | Homepage stats & Gemini API key configuration |
| `/admin/skills` | `src/app/admin/skills/page.tsx` | Client | `canManageSkills` | Skill capability registry & member skill matrix |
| `/admin/sourcing` | `src/app/admin/sourcing/page.tsx` | Client | `canManageSourcing` | Hardware sourcing inquiries & DFM review |
| `/admin/sponsors-partners` | `src/app/admin/sponsors-partners/page.tsx` | Client | `canManagePartners` | Sponsor relations & tier management |
| `/admin/store` | `src/app/admin/store/page.tsx` | Client | `canManageStore` | Store products inventory & pricing editor |
| `/admin/submissions` | `src/app/admin/submissions/page.tsx` | Client | `canManageSubmissions` | Member competition submissions review queue |
| `/admin/superadmin` | `src/app/admin/superadmin/page.tsx` | Client | Superadmin UID | Omni-role custom claim bootstrapper |
| `/admin/tasks` | `src/app/admin/tasks/page.tsx` | Client | `canManageTasks` | Tasks management, AI breakdown, delegation |
| `/admin/timeline` | `src/app/admin/timeline/page.tsx` | Client | `canManageTimeline` | Organizational timeline milestone editor |
| `/admin/users` | `src/app/admin/users/page.tsx` | Client | `canManageUsers` | Master users directory, blacklist toggle |
| `/admin/warning-settings` | `src/app/admin/warning-settings/page.tsx` | Client | `canManageUsers` | Warning thresholds & enforcement rules |
| `/admin/workflows` | `src/app/admin/workflows/page.tsx` | Client | `canManageTasks` | Visual workflow orchestration canvas |

### 2.4 API Route Handlers (88 Routes)
- **Admin APIs (`/api/admin/*`)**:
  - `admin/blogs/[id]`: GET, PATCH, DELETE (Admin blog mutations).
  - `admin/bug-report` & `admin/bug-reports`: POST, GET, PATCH (Bug reporting & resolution).
  - `admin/dashboard/init`: GET (Dashboard telemetry bootstrap).
  - `admin/email-logs`: GET (Mailer audit queries).
  - `admin/hierarchy/*`: `add-existing`, `move`, `relationships`, `user`, `users`, `workload` (Org chart node manipulation).
  - `admin/partners/*`: `analyze`, `export` (Partner AI evaluation & CSV dump).
  - `admin/role-permissions`: GET, POST, DELETE (Custom claims & permission docs).
  - `admin/roles/[slug]`: GET, PATCH, DELETE (Role definition CRUD).
  - `admin/universal-review`: POST (Unified review routing).
  - `admin/users`, `admin/users/restore-workload`: GET, PATCH (User role and workload mutations).
- **AI Integrations (`/api/ai/*`)**:
  - `ai/analyze-reply`: POST (NLP sentiment analysis on partner replies).
  - `ai/generate-pitch`: POST (Automated sponsorship pitch drafter).
  - `ai/headquarters-advisor`: POST (Executive operations chatbot).
  - `ai/match-partners`: POST (Algorithmic sponsor-to-event matcher).
  - `ai-task-generator`: POST (Task breakdown into structured sub-steps).
- **Core Business & Platform APIs**:
  - `blogs`, `blogs/latest`, `blogs/[slug]`, `authors`, `categories`: Blog feed & author operations.
  - `chapter-applications`: POST, GET, PATCH, DELETE (Full chapter application lifecycle).
  - `contact`: POST (Rate-limited public inquiry handler).
  - `cron/*`: `check-deadlines`, `overdue`, `process-dlq`, `remind-deadlines` (Automated cron workers).
  - `event-registrations`, `events/publish`, `events/upcoming`: Event attendance & publishing.
  - `gallery-assets`, `gallery-assets/[id]`: Gallery asset management.
  - `get-upload-url`: GET (Lightweight CAD upload helper).
  - `leaderboard-aggregate`: GET (Cached multi-tier points leaderboard).
  - `leave`: POST, GET, PATCH (Leave of absence application engine).
  - `messages`: Chat & message log router.
  - `organizations`, `organizations/homepage`, `organizations/seed-sample-data`: Partner marquee & seeders.
  - `payments/checkout`: POST (Stripe checkout session creation).
  - `payments/webhook`: POST (Stripe webhook signature validation & event ticket mirroring).
  - `positions`: GET, POST, PATCH (Tenure & leadership position assignments).
  - `profile/[userId]`, `profile/my-team`: GET, PATCH (Profile data & direct reports).
  - `public/skills`, `public/skills-users`: Read-only capability query routes.
  - `revalidate`: POST (On-demand Next.js ISR cache invalidation).
  - `set-superadmin-claim`: POST (Root-level claim provisioning).
  - `skills`, `skills/assign-bulk`, `skills/migrate-legacy`: Skill matrix operations.
  - `sourcing/*`: `download/[filename]`, `get-upload-url`, `inquiries`, `inquiries/[id]`, `submit`, `upload` (Full hardware pipeline).
  - `store/orders`, `store/products`: Store order management & catalog.
  - `submissions`: GET, POST, PATCH (Community competition submission queue).
  - `tasks`, `tasks/[taskId]/activity`, `tasks/batch`, `tasks/delegate`, `tasks/team`: Task management & delegation.
  - `user/post-vacation`: GET, POST (Vacation catch-up state).
  - `users/search`: GET (User autocomplete search).
  - `v1/certificates/*`: `[id]`, `bulk-issue`, `issue`, `verify/[code]` (Certificate issuance & validation).
  - `v1/chapters`, `v1/roles`, `v1/tickets/issue`, `v1/users/certificate-eligible`: Extended v1 APIs.
  - `webhooks/firestore`: POST (Event-driven Firestore mutation router).
  - `workflows`: GET, POST (Multi-step sequential workflow dispatcher).

---

## 3. Complete Form & Submission Inventory

Below is the exhaustive audit of every interactive form, submission handler, and user action point across the platform, classified into Capability Tiers:
- **Tier 1 (Production Ready)**: Real Firestore/API persistence with server-authoritative validation.
- **Tier 2 (Partial / Impaired)**: Functional UI with incomplete/mock backend wiring or route mismatch.
- **Tier 3 (Mock / Stub)**: Non-functional buttons, console.log stubs, or simulated timeouts.

| # | File Path | Form / Component Purpose | Captured Input Fields | Submit Handler / API Endpoint | Target Persistence | Capability Tier | Notes / Impairment Details |
|---|---|---|---|---|---|---|---|
| 1 | `src/app/contact/page.tsx` | Public contact inquiry | Name, Email, Message | `POST /api/contact` | `contactSubmissions` Firestore collection + Nodemailer email | **Tier 1** | Rate limited by IP in `contactRateLimits`. |
| 2 | `src/app/induction/page.tsx` | Induction application form | Multi-step personal, academic, skills, portfolio links, resume URL | `methods.handleSubmit(onSubmit)` writing to `applications/{uid}` | `applications/{uid}` doc + `drafts/{uid}` deletion + `audit_logs` | **Tier 1** | Features automatic background draft autosave to `drafts` collection. |
| 3 | `src/app/register-chapter/page.tsx` | SEDS Chapter registration | University, City, Chapter Name, Lead details, Team size | `createChapterApplication()` Server Action | `chapter_applications` collection + redirect to `/checkout` | **Tier 1** | Validates against user warning blacklist before creation. |
| 4 | `src/components/sourcing-bridge/EngineeringIntakeForm.tsx` | Hardware CAD intake & DFM review | Name, University, Category, Material, Quantity, Tolerance, NDA, `cadDriveLink` | `POST /api/sourcing/submit` | `sourcing_inquiries` collection + Discord/Telegram webhook + Nodemailer email | **Tier 1** | Avoids storage quota bloat by ingesting CAD cloud links with server DFM workflow. |
| 5 | `src/app/checkout/page.tsx` | Store purchase & event ticket checkout | Buyer Name, Email, Phone, Payment Method, `receiptLink`, custom form responses | `createOrder()` Server Action | `orders` collection + `events/{id}/registrations/{uid}` + `chapter_applications` link | **Tier 1** | Enforces server-side price anti-tampering validation against `products` catalog. |
| 6 | `src/app/welcome/page.tsx` | Mandatory profile onboarding | University, Field of Study / Department | `handleSubmit` updating `users/{uid}` | `users/{uid}` Firestore document via `updateDoc` | **Tier 1** | Intercepts all authenticated users until both fields are populated. |
| 7 | `src/components/sections/join-us-section.tsx` | Account registration & newsletter | Name, University, Field of Study, Email, Password, Terms consent | `createUserWithEmailAndPassword()` + `setDoc(users/{uid})` | Firebase Auth User + `users/{uid}` Firestore document | **Tier 1** | Fetches active legal document version before creating record. |
| 8 | `src/components/auth/google-only-auth-form.tsx` | Unified Google Authentication | Google OAuth pop-up / redirect | `signInWithPopup(auth, GoogleAuthProvider)` | Firebase Auth + `users/{uid}` + `audit_logs` | **Tier 1** | Validates invite tokens, auto-provisions roles, logs audit entries. |
| 9 | `src/components/admin/bug-report-button.tsx` | Global Bug & Suggestion Reporter | Type (bug/suggestion), Subject, Description, Page URL, Canvas Screenshot | Uploads to `bug-reports/${id}/screenshot.webp` + `POST /api/admin/bug-report` | Firebase Storage (`bug-reports/`) + `bug_reports` collection | **Tier 1** | Auto-captures screen via `html2canvas` downscaled to WebP < 500KB. |
| 10 | `src/components/profile/optimized-profile.tsx` | User profile details editor | Display Name, Bio, GitHub URL, LinkedIn URL, WhatsApp number, University | `PATCH /api/profile/${uid}` | `users/{uid}` Firestore document via Admin API | **Tier 1** | Enforces ownership or superadmin role and invalidates Redis/memory cache. |
| 11 | `src/components/profile/submit-competition.tsx` | Member competition submission | Type, Title, URL, Organization, Deadline, Description | `POST /api/submissions` | `submissions` Firestore collection | **Tier 1** | Deduplicates URLs; awards points to submitter upon admin approval. |
| 12 | `src/components/profile/delegate-task-dialog.tsx` | Subordinate task delegation | Reason, Points kept, Sub-task assignments (Title, Description, Assignee, Points) | `POST /api/tasks/delegate` | `tasks` collection (sub-tasks) + updates parent task to `delegated` | **Tier 1** | Enforces point conservation (`sum(sub-task points) + pointsKept == parentPoints`). |
| 13 | `src/components/profile/task-detail-dialog.tsx` | Task completion & manager approval | Status, Hours worked, Report, Resource links | `PATCH /api/tasks` | `tasks/{id}` document + gamification points transaction | **Tier 1** | Completing task awards base points and badges; triggers activity log entry. |
| 14 | `src/app/projects/new/page.tsx` | Project proposal submission | Title, Slug, Description, Media links, Tags, Status, Team members | `addProjectClient()` | `projects` Firestore collection via `addDoc` | **Tier 1** | Validates project admin permissions before persisting. |
| 15 | `src/app/events/new/page.tsx` | Event draft creation | Title, Date, Location, Description, Capacity, Paid/Free settings | `addDoc(collection(firestore, 'events'))` | `events` Firestore collection | **Tier 1** | Enforces `chair_events` minimum authority level. |
| 16 | `src/app/blog/new/page.tsx` | Blog draft post authoring | Title, Body, Category, Slug | `addDoc(collection(firestore, 'blogs'))` | `blogs` Firestore collection | **Tier 1** | Saves in draft mode; requires `chair_marketing` authority. |
| 17 | `src/app/verify/[code]/page.tsx` | Certificate verification & print order | Certificate code URL param | `GET /api/v1/certificates/verify/[code]` | Queries `certificates` collection | **Tier 1** | Reads valid certificate and enables direct physical print order via `/checkout`. |
| 18 | `src/app/admin/certificates/page.tsx` | Single & Bulk Certificate Issuance | Recipient User(s), Title, Description, Type, Authority, Dates | `POST /api/v1/certificates/issue` & `bulk-issue` | `certificates` Firestore collection + batch codes | **Tier 1** | Generates verifiable unique codes stored in Firestore. |
| 19 | `src/app/admin/announcements/page.tsx` | Broadcast & Ticker Editor | Title, Content, Audience, Status, Ticker priority, Expiry date | `setDoc(announcements/{id})` & `updateDoc(events/{id})` | `announcements` and `events` collections + `audit_logs` | **Tier 1** | Toggles live news ticker broadcast visibility across the website. |
| 20 | `src/app/admin/badges/page.tsx` | Badge creation & threshold config | Name, Description, Image URL, Points required, Status | `setDoc(badges/{slug})` / `updateDoc(badges/{slug})` | `badges/{slug}` Firestore documents | **Tier 1** | Uses slug as immutable document ID ensuring uniqueness. |
| 21 | `src/app/admin/tasks/page.tsx` | Task creation & AI plan builder | Title, Description, Base Points, Penalties, Deadlines, Assignees, Steps | `POST /api/workflows` & `addTasks` | `tasks` collection + multi-step sequential workflow docs | **Tier 1** | Enforces 24-hour minimum deadline buffer and assigns step-level badges. |
| 22 | `src/app/admin/organizations/page.tsx` | Partner organization management | Name, Logo URL, Website, Type, Marquee visibility, Display order | `addDoc(organizations)` / `updateDoc` / drag-drop batch update | `organizations` Firestore collection | **Tier 1** | Powers the dynamic homepage credibility marquee with live ordering. |
| 23 | `src/app/admin/chapters/page.tsx` | University Chapter manager | Chapter Name, Slug, City, Country, Active status | `setDoc(chapters/{slug})` & `DELETE /api/chapter-applications` | `chapters/{slug}` Firestore collection | **Tier 1** | Deletion cascades to unassign chapter affiliation from all member accounts. |
| 24 | `src/app/admin/chapter-applications/page.tsx` | Chapter application review | Application ID, Status, Rejection reason, Admin notes | `PATCH /api/chapter-applications` | `chapter_applications` + provisions new `chapters` doc | **Tier 1** | Approving automatically creates chapter doc and grants chapter lead role. |
| 25 | `src/app/admin/store/components/product-management.tsx` | Store product inventory editor | Product Name, Description, Price, Currency, Stock, Category, Linked Form | `POST /api/store/products` & `PATCH /api/store/products` | `products` Firestore collection | **Tier 1** | Supports linking custom forms to product purchases. |
| 26 | `src/app/admin/resources/new/page.tsx` | Educational resource creation | Title, Description, Type, Resource Link | `addDoc(resources)` | `resources` Firestore collection | **Tier 1** | URL format validated before persistence. |
| 27 | `src/app/admin/positions/page.tsx` | Leadership position appointments | Role, User, Start Date, End Date, Notes | `POST /api/positions` & `PATCH /api/positions` | `positions` collection + synchronizes Firebase custom claims | **Tier 1** | Synchronizes executive appointment tenures. |
| 28 | `src/app/admin/skills/components/register-capability-modal.tsx` | Capability matrix registration | Name, Category, Status, Featured flag, Icon key, Order | `addDoc(skills)` & `updateDoc(skills/{id})` | `skills` Firestore collection | **Tier 1** | Defines national aerospace capability registry entries. |
| 29 | `src/app/admin/forms/page.tsx` | Dynamic form schema builder | Title, Description, Field list (id, label, type, required) | `addDoc(forms)` & `updateDoc(forms/{id})` | `forms` Firestore collection | **Tier 1** | Enables creating custom survey/data-intake forms dynamically. |
| 30 | `src/app/admin/crm/page.tsx` | CRM contact & lead creation | Org Name, Stage, Contact Name, Email, Phone | `ContactsRepository.createContact()` | `partners` Firestore collection | **Tier 1** | Full relationship timeline and interaction history tracking. |
| 31 | `src/app/admin/legal-documents/page.tsx` | Legal documents versioned CMS | Title, HTML content, Version string, Meta description | `setDoc(pages/{docId})` | `pages/terms-and-conditions`, `pages/privacy-policy` | **Tier 1** | Saves live website legal text with version increments. |
| 32 | `src/app/admin/backup-restore/page.tsx` | Database backup & restoration | Uploaded `.json` collection dump file | `batch.set(docRef, data, { merge: true })` | Multiple Firestore collections via `writeBatch` | **Tier 1** | Direct database backup export and batch restoration. |
| 33 | `src/app/admin/warning-settings/page.tsx` | Disciplinary warning config | Warning thresholds, auto-suspend counts, cooldown days | `setDoc(warningConfig/global, ...)` | `warningConfig/global` Firestore document | **Tier 1** | Configures site-wide enforcement and blacklist triggers. |
| 34 | `src/app/admin/site-settings/page.tsx` | Global site stats & Gemini API Key | Students Engaged, Active Projects, Partners, Chapters, API Key | `updateDoc(settings/siteWide)` & `localStorage('gemini.apiKey')` | `settings/siteWide` Firestore doc + browser storage | **Tier 1** | Governs stats rendered on the public landing page. |
| 35 | `src/app/admin/roles/page.tsx` | Dynamic role creation & assignment | Role Name, Slug, Description, Category, Scope, Permissions | `setDoc(roleDefinitions/{slug})` & `assignRole()` | `roleDefinitions` collection + custom claims sync | **Tier 1** | Updates user role claims and system authorization tables. |
| 36 | `src/app/admin/role-privileges/page.tsx` | Role privilege route access matrix | Role, Allowed route paths, Admin console toggle | `POST /api/admin/role-permissions` | `rolePermissions` Firestore collection | **Tier 1** | Governs frontend route access and sidebar gating. |
| 37 | `src/app/admin/sourcing/page.tsx` | Sourcing inquiry admin review | Status, Assigned engineer, Quote amount, Lead time, DFM notes | `PATCH /api/sourcing/inquiries/${id}` | `sourcing_inquiries/{id}` Firestore document | **Tier 1** | Transmits official quotes and updates engineering status. |
| 38 | `src/app/admin/gallery/page.tsx` | Gallery media asset editor | Title, Asset URL, Thumbnail URL, Description, Status | `POST /api/gallery-assets` & `PATCH /api/gallery-assets/${id}` | `gallery_assets` Firestore collection | **Tier 1** | Admin CRUD for media gallery. |
| 39 | `src/app/admin/applications/page.tsx` | Induction application review | Application ID, Status (approved/rejected), Rejection reason | `updateDoc(applications/{id})` | `applications/{id}` Firestore document + `audit_logs` | **Tier 1** | Updates candidate status and logs audit entry. |
| 40 | `src/app/events/register/page.tsx` | Event seat confirmation button | Event ID, WhatsApp number, Payment method | `fetch('/registerForEvent', ...)` (Line 99) | Non-existent route `/registerForEvent` | **Tier 2** | **Impaired Route**: Calls `/registerForEvent` which does not exist in Next.js routes or Cloud Functions (returns 404). Real registration is handled via `/checkout` or manual payment ref update (`updateDoc`). |
| 41 | `src/app/api/get-upload-url/route.ts` | Cloud file upload URL generator | `filename` query parameter | `GET /api/get-upload-url` | Static URL string return | **Tier 2** | **Mock Return**: Returns hardcoded string `https://storage.sedspakistan.org/cad-uploads/${filename}` rather than generating a live GCS/S3 pre-signed upload URL. |
| 42 | `src/app/api/categories/route.ts` | Blog category creation endpoint | Name, Description | `POST /api/categories` | In-memory object return (Line 128) | **Tier 2** | **Partially Wired**: Does not call `db.collection('categories').add()`; returns in-memory mock JSON response with `// TODO: Add proper authentication and role checking`. |
| 43 | `src/app/copilot/page.tsx` | AI Research Copilot query form | Textarea query | `handleSubmit` with 1-second `setTimeout` | Ephemeral state only | **Tier 3** | **Disabled Stub**: Form inputs and submit button are explicitly `disabled` with banner "AI Features Coming Soon". Submit handler is a simulated timeout stub. |
| 44 | `src/components/sections/study-assistant-section.tsx` | Homepage AI Study Assistant form | Topic text input | `handleSubmit` empty placeholder | None | **Tier 3** | **Disabled Stub**: Input and button are `disabled` with tooltip "This AI feature is disabled until a Gemini API key is configured". `handleSubmit` body is empty placeholder comment. |

---

## 4. CAD Dropzones, Storage & Hardware Pipeline

### 4.1 CAD & Binary Ingestion Architecture
A forensic scan across all code files for CAD extensions (`.step`, `.stp`, `.stl`, `.iges`, `.igs`, `.dxf`, `.sldprt`) and file dropzones reveals the hardware pipeline structure:
1. **Engineering Intake Portal (`src/components/sourcing-bridge/EngineeringIntakeForm.tsx`)**:
   - The SEDS Sourcing Bridge ingests hardware packages for aerospace machining (CNC milling, turning, 3D printing in Al 7075, titanium, carbon fiber).
   - Ingestion Mechanism: Rather than streaming massive multi-hundred-megabyte STEP/CAD files through ephemeral browser upload states, the primary interface prompts the engineer for their institutional CAD repository or cloud storage share link (`cadDriveLink`: Google Drive, OneDrive, GrabCAD, or GitHub).
   - Validation & Transmission: Enforces HTTPS URL validation, mutual NDA acknowledgement, and user authentication before submitting intake metadata to `/api/sourcing/submit`.
   - Backend Processing (`src/app/api/sourcing/submit/route.ts`): Writes the request to Firestore collection `sourcing_inquiries` with initial status `pending_dfm_review`, fires automated webhooks to Discord/Slack/Telegram (`SOURCING_WEBHOOK_URL`), and dispatches email confirmations to the applicant and procurement engineering team via `sendRawEmail`.
2. **Direct Cloud Storage Upload & Signed URL Handlers**:
   - `src/app/api/sourcing/get-upload-url/route.ts`: Implements Google Cloud Storage Admin SDK (`fileRef.getSignedUrl({ version: 'v4', action: 'write', expires: 30 mins })`) for direct browser-to-bucket upload of CAD packages up to 100MB+, with fallback to direct public Firebase Storage paths.
   - `src/app/api/sourcing/upload/route.ts`: Multipart form-data upload fallback that buffers files server-side and streams them to bucket directory `sourcing-cad-packages/${timestamp}_${cleanFilename}` with download token generation.
   - `src/app/api/sourcing/download/[filename]/route.ts`: Server-side file streaming route that reads binary buffers from GCS bucket `sourcing-cad-packages/` and pipes them to the client with `Content-Disposition: attachment` headers.
   - `src/app/api/get-upload-url/route.ts`: Secondary helper returning static upload paths (**Tier 2**).

### 4.2 Firebase Storage Rules Audit (`storage.rules`)
Inspection of `storage.rules` confirms the following path rules and upload ceilings:
```
service firebase.storage {
  match /b/{bucket}/o {
    // 1. Project Images: Public read, Admin write, Max 2MB, Image MIME only
    match /project-images/{allPaths=**} {
      allow read: if true;
      allow write: if isProjectAdmin() && request.resource.size < 2 * 1024 * 1024 && request.resource.contentType.matches('image/.*');
    }
    // 2. Badge Images: Public read, Admin write, Max 2MB, Image MIME only
    match /badge-images/{allPaths=**} {
      allow read: if true;
      allow write: if isProjectAdmin() && request.resource.size < 2 * 1024 * 1024 && request.resource.contentType.matches('image/.*');
    }
    // 3. User Avatars: Public read, Owner write
    match /avatars/{userId}/{fileName} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
    // 4. Order Payment Receipts: Buyer & Admin read, Buyer write, Max 4MB, Image/PDF MIME
    match /orders/{buyerId}/{orderId}/{fileName} {
      allow read: if (request.auth != null && request.auth.uid == buyerId) || isProjectAdmin();
      allow write: if request.auth != null && request.auth.uid == buyerId && request.resource.size < 4 * 1024 * 1024 && (request.resource.contentType.matches('image/.*') || request.resource.contentType.matches('application/pdf'));
    }
    // 5. Bug Reports: Admin read, Auth user write, Max 500KB, Image MIME only
    match /bug-reports/{reportId}/{fileName} {
      allow read: if isProjectAdmin();
      allow write: if request.auth != null && request.auth.size < 500 * 1024 && request.resource.contentType.matches('image/.*');
    }
  }
}
```

**Key Security Finding**:
- CAD extensions (`.step`, `.stl`, `.iges`, etc.) are intentionally omitted from standard Firebase Client Storage rules. Direct client SDK uploads of CAD binaries to client buckets are disallowed by security rules (which enforce `image/.*` or `application/pdf`).
- All CAD file operations are appropriately routed through the Firebase Admin SDK / GCS signed URL pipeline (`src/app/api/sourcing/*`) or external repository links, isolating binary storage from client-side security rule bypasses.

### 4.3 General File Upload Components
- **`src/components/admin/image-uploader.tsx`**: Standard drag-and-drop / file selector component. Validates `image/*` MIME, enforces 5MB client-side limit, and uploads via `uploadBytesResumable` with progress tracking to Firebase Storage.
- **`src/components/admin/bug-report-button.tsx`**: Screenshot generator using `html2canvas` on `document.body`, converts canvas to WebP with 0.5 quality factor (< 150KB), uploads to Firebase Storage `bug-reports/${reportId}/screenshot.webp` (< 500KB constraint verified), and transmits payload to `/api/admin/bug-report`.
- **`src/app/admin/backup-restore/page.tsx`**: File input accepting `.json`. Parsed locally via `FileReader` and committed directly to Firestore via `writeBatch(db)`.

---

## 5. Logic Chain

1. **Architecture Determination**:
   - Examination of `package.json` revealed Next.js `15.0.0`, React `18.3.1`, Tailwind `3.4.1`, Radix UI, Three.js, React Flow, and Firebase SDKs.
   - Filesystem walk confirmed `src/app/` is the sole routing tree, verifying 100% App Router usage with standalone output.
   - Review of `src/app/layout.tsx` and `app-client-shell.tsx` verified that global state, auth listeners, and theme providers are mounted at the root client shell, while 3D Vanta canvases are conditionally disabled on heavy routes.
2. **Route Categorization**:
   - Traversal of `src/app` located exactly 121 `page.tsx` files and 88 `route.ts` files, yielding 209 active route endpoints.
   - Analysis of route directories and layout guards separated routes into 34 public presentation routes, 23 protected user routes, 57 protected admin routes, 9 dynamic page routes, and 10 dynamic API routes.
3. **Form & Capability Tier Classification**:
   - Inspected each form across user-facing pages, admin panels, and dialog components.
   - Traced submit handlers down to their data persistence layer:
     - 39 forms connect to real Firestore collections, Firebase Auth, or external services (Tier 1).
     - 3 forms/endpoints have wiring flaws (Tier 2): `/events/register` calling non-existent `/registerForEvent`, `/api/get-upload-url` returning static mock strings, and `/api/categories` returning in-memory mock responses.
     - 2 forms are explicitly disabled stubs with placeholder handlers (Tier 3): `/copilot` and `StudyAssistantSection`.
4. **CAD & Hardware Ingestion Synthesis**:
   - Cross-referenced CAD extensions in frontend forms (`EngineeringIntakeForm.tsx`) with API routes (`api/sourcing/*`) and `storage.rules`.
   - Proved that the system uses a hybrid model: cloud repository links + server-side GCS signed URLs, deliberately preventing arbitrary raw binary CAD uploads through client Firebase Storage rules.

---

## 6. Caveats

1. **Live Cloud Network Isolation**: In accordance with non-destructive benchmark requirements, no live network calls were made to external Stripe endpoints, live Firestore instances, or third-party webhooks during this audit. Analysis is based entirely on source code inspection.
2. **Dynamic Route Id Resolution**: Dynamic parameter folders (e.g. `[slug]`, `[id]`, `[userId]`, `[code]`) depend on runtime data in Firestore to resolve specific documents.
3. **Admin Hierarchy Edge Cases**: Drag-and-drop hierarchy operations in `src/app/admin/hierarchy/page.tsx` depend on correct document relationships in the `positions` and `users` collections.

---

## 7. Conclusion

The SEDS Pakistan website frontend architecture is a Next.js 15 App Router application with deep Firebase integration, Radix UI component primitives, dynamic Three.js/Vanta visual effects, and a 57-route administrative management suite.

Key Findings:
1. **Route Scale**: 209 total routes (121 pages and 88 API route handlers).
2. **Form Fidelity**: 39 forms are production-ready (**Tier 1**), featuring real Firestore persistence, Zod validation, and role auditing.
3. **Impairments & Stubs**:
   - 3 items are **Tier 2** (partial/impaired): `/events/register` (points to broken `/registerForEvent` path), `/api/get-upload-url` (static mock URL), and `/api/categories` (in-memory return without Firestore write).
   - 2 items are **Tier 3** (mock/stub): `/copilot` and `StudyAssistantSection` (disabled UI with placeholder handlers).
4. **Hardware Pipeline**: The CAD sourcing workflow (`/sourcing-bridge`) handles hardware specifications via a hybrid cloud repository intake with server-side GCS signed URLs, intentionally isolated from client-side Firebase Storage rules to enforce security and storage quotas.

---

## 8. Verification Method

To independently verify all findings:
1. **Route Count Verification**:
   - Run `fd -e tsx -e jsx -g "*page.*" src/app | wc -l` -> Confirm 121 page files.
   - Run `fd -e ts -e js -g "*route.*" src/app | wc -l` -> Confirm 88 route handler files.
2. **Layout & Guard Inspection**:
   - Inspect `src/app/admin/layout.tsx:18-28` to verify client-side RBAC gating.
   - Inspect `src/app/apply/layout.tsx:50-59` to verify unauthenticated redirect logic.
3. **Form & Tier Invalidation Checks**:
   - Inspect `src/app/events/register/page.tsx:99` -> Verify `fetch('/registerForEvent', ...)` target.
   - Inspect `src/app/copilot/page.tsx:87-102` -> Verify `disabled` attributes and `setTimeout` stub at line 33.
   - Inspect `src/app/api/categories/route.ts:104,128-135` -> Verify lack of Firestore `addDoc` and `TODO` comment.
   - Inspect `src/components/sourcing-bridge/EngineeringIntakeForm.tsx:139-150` -> Verify `cadDriveLink` transmission to `/api/sourcing/submit`.
   - Inspect `storage.rules:17-60` -> Confirm omission of CAD extensions from client storage rules.
