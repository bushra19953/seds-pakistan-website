# Prompt 01: Context Decomposition Protocol

## Context Engineering Rationale

Feeding an entire repository into an AI model at once causes attention fragmentation, hallucinations, and lost context. 
Large codebases demand deliberate decomposition into isolated architectural lobes.

This protocol instructs the agent to audit five distinct lobes in order. The agent must document findings from each lobe before loading files from the next lobe. This process keeps context utilization below the 120,000 token ceiling and preserves precision.

## Token Budget Allocation Model (120k Token Ceiling)

Auditing complex Next.js and Firebase codebases demands strict token accounting. The agent operates within a 120,000 token context window partitioned into five distinct allocations:

| Budget Allocation Segment | Token Share | Percentage | Operational Purpose |
|---|---|---|---|
| System Prompts and Invariants | 12,000 | 10% | Core system rules, role contracts, stop-slop invariants |
| Active Lobe Inspection Window | 36,000 | 30% | File source code, AST dumps, parser token slices for the active lobe |
| Checkpoint Scratchpad | 12,000 | 10% | Rolling intermediate checkpoint data from preceding lobes |
| Output Synthesis Workspace | 40,000 | 33% | Draft generation of inventory matrices, schema JSON, capability records |
| Reserve Context Buffer | 20,000 | 17% | Slack margin preventing truncation during long tool responses |
| Total Context Budget | 120,000 | 100% | Hard upper limit for single audit turn session |

### Token Management Rules
1. Never exceed 36,000 tokens of raw source code in a single inspection turn.
2. If an architectural lobe contains more than 36,000 tokens of code, chunk the files by directory and write intermediate observations to the lobe checkpoint.
3. Flush raw source code from context before transitioning to the next lobe. Carry forward only the summarized checkpoint markdown.
4. Keep the reserve buffer untouched during inspection turns to avoid context overflow errors.

## Master Decomposition Workflow

Execute each lobe audit in sequence:

Start Audit Session -> Lobe A -> Lobe B -> Lobe C -> Lobe D -> Lobe E -> Master Inventory

## Lobe A: Routing and Navigation Architecture

### Objective
Map all visible pages, route handlers, dynamic parameters, route groups, parallel slots, intercepting routes, layout inheritance chains, and error boundaries.

### Subsystem Scanner
scripts/scan_nextjs_routes.py

### Target Files and Patterns
- app/**/page.tsx, app/**/page.ts, app/**/page.jsx, app/**/page.js
- app/**/route.ts, app/**/route.js
- app/**/layout.tsx, app/**/template.tsx
- app/**/error.tsx, app/**/global-error.tsx, app/**/not-found.tsx
- Parallel slots: app/**/@slot/**
- Intercepting routes: app/**/(.)*, app/**/(..)*, app/**/(...)*
- Route groups: app/**/(group)/**
- pages/**/*.tsx, pages/api/**/*.ts
- middleware.ts, src/middleware.ts
- Navigation menus, headers, sidebars (components/Nav*.tsx, components/Header*.tsx)

### Core Inspection Questions
1. Which router architectures exist in the codebase (App Router, Pages Router, or hybrid)?
2. What public routes exist (home, about, initiatives, chapters, sourcing bridge)?
3. What protected routes exist (dashboard, admin, chapter portal, review panels)?
4. What parallel route slots (@slot) exist, and which parent layouts mount them?
5. What intercepting routes exist, and which targets do they intercept?
6. Does each route inherit a valid layout chain from root down to leaf folder?
7. What error boundaries exist in the route tree?
8. Which page files use client directive versus server components, and which files define server actions?

### Lobe A Output Artifact Format
Write observations into ./audit_output/lobe_checkpoints/lobe_a_summary.md:
- Route Path: [path]
- Component File: [file path and line number]
- Router Type: [app | pages]
- Component Boundary: [client | server]
- Parallel Slot: [@slot name or None]
- Intercepting Marker: [(.) | (..) | (...) or None]
- Layout Chain: [ordered list of layout files]
- Error Boundaries: [list of error boundary files]
- Access Level: [Public | Authenticated | Role Protected]
- Dynamic Arguments: [list or None]

## Lobe B: Authentication and Role-Based Access Control

### Objective
Uncover user identity management, multi-tenant chapter isolation, session cookies, custom claims, and client versus server authorization enforcement.

### Subsystem Scanner
scripts/audit_rbac_auth.py

### Target Files and Patterns
- src/lib/firebase.ts, src/lib/auth.ts, src/context/AuthContext.tsx
- middleware.ts, src/middleware.ts
- Route guards and wrappers (components/ProtectedRoute.tsx, components/AdminGuard.tsx)
- Server session cookies: cookies().get('__session'), request.cookies.get('__session')
- Session cookie SDK calls: createSessionCookie, verifySessionCookie
- Multi-tenant chapter scoping: where('chapterId', '==', ...), where('tenantId', '==', ...)
- Security rules: firestore.rules, storage.rules

### Core Inspection Questions
1. What authentication provider handles identity (Firebase Auth, custom JWT)?
2. What sign-in methods does the app implement (email/password, OAuth providers, anonymous tokens)?
3. How does the app enforce multi-tenant chapter isolation across SEDS chapters (GIKI, NUST, IST, FAST, Karachi)?
4. Do database queries on chapter collections filter by chapterId or tenantId?
5. Does the application use cookie sessions for Server Side Rendering, or does it depend on client tokens alone?
6. What custom claims exist, and where does the server mint them?
7. Do client components execute role checks without matching server-side route handler enforcement?

### Lobe B Output Artifact Format
Write observations into ./audit_output/lobe_checkpoints/lobe_b_summary.md:
- Auth Provider: [Name and version]
- Sign-In Methods: [list methods and file locations]
- Custom Claims: [list claims such as admin, council, chapter_lead]
- Multi-Tenant Chapter Isolation: [Enforced with chapterId filters | Missing tenant filter]
- Session Persistence Mode: [Cookie-backed SSR session | Client token only]
- Client-Only Role Checks: [list client files checking roles without server guard]
- Security Rule File: [file path or None]

## Lobe C: Database Models and State Management

### Objective
Extract all collections, nested subcollections, document fields, TypeScript interfaces, Zod validation schemas, client queries, and mutation hooks.

### Subsystem Scanner
scripts/extract_firestore_schemas.py

### Target Files and Patterns
- Database initialization and references (src/lib/firestore.ts, services/*.ts)
- TypeScript type definitions (types/*.ts, types/**/*.ts)
- Validation schemas (schemas/*.ts, Zod z.object, z.infer)
- Subcollection paths: collection(db, 'projects', id, 'milestones')
- Query filters: where(...), orderBy(...), limit(...)
- Mutation hooks: useQuery, useMutation, useSWR, addDoc, setDoc, updateDoc, deleteDoc

### Core Inspection Questions
1. What datastore does the application use (Cloud Firestore, Realtime Database)?
2. What top-level collections exist in the codebase?
3. What nested subcollections exist (e.g. projects/{id}/milestones, rfqs/{id}/bids)?
4. What fields and data types make up each document interface?
5. What Zod validation schemas exist, and which collections link to them?
6. Which queries apply filtering, sorting, or pagination limits?
7. What mutation hooks and state management stores handle write operations?

### Lobe C Output Artifact Format
Write observations into ./audit_output/lobe_checkpoints/lobe_c_summary.md:
- Collection Name: [name]
- Subcollection Path: [nested path or None]
- TypeScript Interface: [interface name, file path, line range]
- Zod Validation Schema: [schema name, file path or Missing]
- Query Filters: [list where and orderBy fields]
- Write Mutation Hooks: [list files and hook calls]
- Security Rule Match: [matching rule block from firestore.rules]

## Lobe D: Sourcing Bridge Hardware Intake Pipeline

### Objective
Audit the end-to-end hardware procurement intake workflow: CAD file dropzones, BOM ingestion, accepted file extensions, 100MB limits, MIME whitelists, and Firebase Storage rules.

### Subsystem Scanner
scripts/audit_hardware_storage.py

### Target Files and Patterns
- Sourcing bridge routes (app/sourcing*, pages/sourcing*, components/sourcing/*)
- Intake forms and file dropzones (components/*Intake*.tsx, components/*Upload*.tsx, components/*Dropzone*.tsx)
- Storage handlers (src/lib/storage.ts, server actions handling FormData)
- Storage security rules (storage.rules)
- CAD extensions: .step, .stp, .stl, .iges, .igs, .dxf, .dwg, .sldprt
- BOM extensions: .zip, .pdf, .csv, .xlsx

### Core Inspection Questions
1. What form fields exist on the intake form (project name, team, institution, material, tolerances, quantity, target date)?
2. Does the form accept file uploads, and what CAD/BOM extensions does the input specify?
3. Does client code or server code check file size limits (enforcing the 100MB ceiling)?
4. What storage buckets store uploaded CAD files?
5. Do storage security rules (storage.rules) enforce authentication, size limits, and MIME whitelists?
6. Does the upload function write download URLs into a database collection alongside hardware metadata?

### Lobe D Output Artifact Format
Write observations into ./audit_output/lobe_checkpoints/lobe_d_summary.md:
- Intake Form Route: [path]
- Dropzone Component: [file path and line number]
- Storage Target: [bucket name or reference path]
- Accepted CAD Extensions: [list extensions]
- Enforced File Size Limit: [limit in megabytes, or Unenforced]
- MIME Whitelist: [list MIME types]
- Storage Rules Status: [Auth enforced | Size enforced | Open / Insecure]
- Database Metadata Target: [collection name]

## Lobe E: External Services and Hosting Architecture

### Objective
Uncover outbound notifications, Google APIs, email services, webhooks, hosting redirects, rewrites, and environment variable configurations.

### Subsystem Scanner
scripts/audit_external_services.py

### Target Files and Patterns
- Google APIs: OAuth, Google Drive, Google Sheets, Cloud Functions
- Email services: Resend, SendGrid, Nodemailer, Postmark, AWS SES
- Webhooks: Discord, Slack, Telegram, WhatsApp, Stripe
- Hosting configuration files: next.config.js, next.config.mjs, vercel.json, firebase.json
- Inbound webhook handlers: app/api/webhooks/*, pages/api/webhooks/*
- Environment variables: process.env.*, .env.example, .env.local.example

### Core Inspection Questions
1. What Google APIs does the project consume (OAuth, Drive intake, Sheets export, Cloud Functions)?
2. What email delivery service does the app invoke (SendGrid, Resend, Nodemailer)?
3. Does form submission trigger confirmation notifications to users or administrators?
4. What webhooks exist, and do inbound handlers verify cryptographic signatures?
5. What redirects, rewrites, and security headers does next.config.js or vercel.json declare?
6. What environment variables does the codebase consume, and do all variables exist in .env.example?
7. Do any source files contain hardcoded API keys or plaintext credentials?

### Lobe E Output Artifact Format
Write observations into ./audit_output/lobe_checkpoints/lobe_e_summary.md:
- Google APIs Detected: [list services and occurrences]
- Email Provider: [service name and handler file]
- Webhooks: [list webhook targets and signature verification status]
- Hosting Redirects and Rewrites: [count and sample mappings]
- Security Headers: [CSP present | CORS present | Missing]
- Environment Variables: [total count, documented vs undocumented]
- Hardcoded Secrets: [None | list flagged lines]

## Intermediate State Preservation and Lobe Checkpoints

Before moving between lobes, the agent must write its findings into a structured checkpoint file:
./audit_output/lobe_checkpoints/lobe_[a-e]_summary.md

This discipline prevents context loss when resetting memory between audit phases.

### Checkpoint File Schema Contract
Every checkpoint summary must include:
1. Header: LOBE [A-E] AUDIT CHECKPOINT
2. Timestamp: UTC ISO-8601 string
3. Scanner Used: Script path and command
4. Key Findings Matrix: Structured table of mapped components
5. Security and Gap Ledger: High, medium, and low severity observations
6. Ground Truth Tokens: Extracted interface names, routes, roles, and collections
