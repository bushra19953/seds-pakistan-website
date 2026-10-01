# CLAUDE.md: Context Engineering Rules for SEDS Audit

## Project Context

You are auditing the SEDS Pakistan website and SEDS Sourcing Bridge intake codebase. 
Your goal is to extract empirical ground truth, assess production readiness, and construct machine-readable schemas.

Audit Output Directory: `./audit_output/`

---

## Target Tech Stack Architecture

The codebase contains some or all of these technologies:

- **Frontend Core**: Next.js 13/14/15 (App Router or Pages Router), React 18/19, TypeScript 5
- **Styling**: Tailwind CSS, PostCSS, Lucide React icons, Radix UI primitives
- **Backend & Cloud**: Next.js Server Actions, Next.js API Routes (`/api/*`), Node.js Express, Firebase Cloud Functions
- **Database & Auth**: Firebase Auth, Google Cloud Firestore, Firebase Storage, Supabase (PostgreSQL / GoTrue)
- **Validation & State**: Zod, React Hook Form, TanStack React Query, Zustand

---

## High-Speed Scan Commands

Run these targeted commands to inspect the codebase without exhausting context window tokens:

### 1. Framework and Route Discovery

```bash
# Check dependencies and framework version
cat package.json | grep -E "(next|react|firebase|supabase|zod|tailwind)"

# Discover all App Router routes (Next.js)
find app -name "page.tsx" -o -name "page.jsx" -o -name "route.ts" -o -name "route.js"

# Discover all Pages Router routes (Next.js)
find pages -name "*.tsx" -o -name "*.jsx"

# On Windows PowerShell:
Get-ChildItem -Path "app", "pages", "src" -Include "*page.tsx", "*route.ts", "*.routes.ts" -Recurse -Name
```

### 2. Authentication and Security Rules Search

```bash
# Locate auth middleware and protection logic
grep -rn "middleware" src/ app/ pages/
grep -rn "onAuthStateChanged" src/ app/ pages/
grep -rn "getAuth" src/ app/ pages/

# Find database security rules
find . -name "firestore.rules" -o -name "storage.rules"
```

### 3. Database Queries and Models

```bash
# Locate Firestore collection references
grep -rn "collection(" src/ app/ pages/ lib/
grep -rn "doc(" src/ app/ pages/ lib/

# Locate Supabase client queries
grep -rn "supabase.from(" src/ app/ pages/ lib/

# Locate TypeScript interfaces for domain entities
grep -rn "interface " src/types/ lib/types/ types/
```

### 4. Hardware CAD Intake and Upload Mechanics

```bash
# Locate file upload dropzones and input elements
grep -rn "type=\"file\"" src/ app/ pages/ components/
grep -rn "uploadBytes" src/ app/ pages/ lib/
grep -rn "storage.ref" src/ app/ pages/ lib/

# Locate accepted CAD file extensions
grep -rn -E "\.(step|stp|iges|stl|dxf|dwg)" src/ app/ pages/
```

### 5. Notification and Webhook Calls

```bash
# Search outbound communications
grep -rn "nodemailer" src/ app/ pages/
grep -rn "sendgrid" src/ app/ pages/
grep -rn "resend" src/ app/ pages/
grep -rn "fetch(" app/api/ pages/api/
```

---

## Context Budget Management

The context window is a working desk. Budget tokens with discipline:

1. **Trim at 75% Capacity**
   Do not wait for context exhaustion. Compress intermediate file listings before diving into component source code.

2. **Selective File Inclusion**
   Never load an entire component folder at once. Load the route page first. Next, load the specific form submission handler.

3. **Breadcrumb Compression**
   Summarize completed inspection steps in one sentence before loading new files:
   `"Auth verified in src/lib/firebase.ts: uses client email-password with custom claims for admin."`

4. **Recency Placement**
   Place active task files and live code snippets closest to the generation point. Keep background project rules at the top.

---

## File Conventions and Boundaries

Follow these rules during every session:

- **Target Output Paths**:
  - Audit Report: `./audit_output/CAPABILITIES_BRAG_REPORT.md`
  - JSON Schema: `./audit_output/GROUND_TRUTH_SCHEMA.json`
  - Ingestion Package: `./audit_output/SEDS_BRAIN_INGESTION_BUNDLE.md`
- **Zero In-Place Edits**: Do not modify source code files under `app/`, `pages/`, `src/`, or `lib/`.
- **Zero Secrets**: Strip service account keys, Firebase private keys, and environment tokens from all output files.
- **Evidence Citation**: Cite exact file paths and line ranges for every fact (`src/components/IntakeForm.tsx#L42-L88`).
- **No Hallucinated Types**: Document types extracted from source code or mark them as missing without exception.
