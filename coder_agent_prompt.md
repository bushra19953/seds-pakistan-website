# Agent Prompt: SEDS Pakistan Website Full Codebase Audit

> **Copy this entire prompt and paste it into your AI coding agent (Cursor, Claude Code, GitHub Copilot, Windsurf, or Antigravity).**
> The agent must be opened in the root of the SEDS Pakistan website repository.

---

## Your Mission

You are executing a forensic, non-destructive audit of the SEDS Pakistan website codebase. You will use a pre-built audit harness to scan every route, database schema, auth gate, file upload handler, and external integration in this repository. You will produce 3 output files that document the exact capabilities of this platform.

**You will NOT modify any source code. Read-only inspection only.**

---

## Step 0: Setup the Harness

The audit harness is in a folder called `seds-audit-harness/`. It should be placed at the same level as this website repo, or inside it. Locate it now.

If the harness folder is at `../seds-audit-harness/` or `./seds-audit-harness/`, note the path. You will reference it throughout.

Verify Python 3.8+ is available:
```bash
python --version
```

No pip installs are needed. The harness uses Python standard library only.

---

## Step 1: Read the Operating Rules (MANDATORY — Do Not Skip)

Before touching any source code, read these files in the harness folder **in this exact order**:

1. **`seds-audit-harness/AGENTS.md`** — Your operating constraints. Read every line. Key rules:
   - Read-only code inspection. Zero source file modifications.
   - Zero database mutations. Never call Cloud Functions or API routes.
   - Zero credential exposure. Redact all secrets from reports.
   - Never label a UI component as a working backend. If a button calls `console.log()` or sets local state without database persistence, classify it as Tier 3 (Mock/Stub).
   - Write all output to `./audit_output/`. Keep the source tree clean.

2. **`seds-audit-harness/CLAUDE.md`** — Context engineering rules (applicable to all agents, not just Claude).

3. **`seds-audit-harness/prompts/01_context_decomposition.md`** — Defines the 5 subsystem lobes (A through E) you must decompose the codebase into.

4. **`seds-audit-harness/prompts/02_brag_capability_rubric.md`** — The 3-tier scoring rubric (Production Ready / Partial / Mock) and the 5 evaluation dimensions.

5. **`seds-audit-harness/prompts/03_second_brain_ingest_protocol.md`** — Format spec for the ingestion bundle (L0-L3 memory pyramid structure).

---

## Step 2: Run the Automated Audit Pipeline

Create the output directory, then execute the master runner:

```bash
mkdir -p audit_output

python seds-audit-harness/scripts/audit_runner.py \
  --repo-path . \
  --output-dir ./audit_output \
  --verbose
```

**On Windows PowerShell:**
```powershell
New-Item -ItemType Directory -Force -Path .\audit_output

python seds-audit-harness\scripts\audit_runner.py `
  --repo-path "." `
  --output-dir ".\audit_output" `
  --verbose
```

This runs 7 sequential passes:

| Pass | Script | What It Extracts |
|------|--------|-----------------|
| 1 | `analyze_components_ast.py` | JSX/TSX component tree, form inputs, CAD dropzones, dead components |
| 2 | `scan_nextjs_routes.py` | Every page, API route, dynamic segment, middleware, layout |
| 3 | `extract_firestore_schemas.py` | Firestore collections, TypeScript interfaces, `firestore.rules` permissions |
| 4 | `audit_rbac_auth.py` | Firebase Auth methods, role checks, route-level access guards |
| 5 | `audit_hardware_storage.py` | CAD upload handlers, storage buckets, file size limits |
| 6 | `audit_external_services.py` | External APIs, webhooks, email/SMS integrations |
| 7 | `generate_brag_report.py` | Final BRAG scoring and deliverable synthesis |

**Wait for the runner to complete with exit code 0 before proceeding.**

---

## Step 3: Handle Errors

If `audit_runner.py` fails:

**Error: "Target repository does not exist"**
→ Verify `--repo-path` points to the directory containing `package.json`.

**Error: "total_routes: 0"**
→ This is a monorepo. Look for the web app root (e.g. `apps/web/` or `packages/portal/`) and re-run with `--repo-path apps/web`.

**Error: Components flagged as dead but they exist**
→ Check `tsconfig.json` for path aliases (`@/components`, `@app/`). The parser reads these from config.

**Error: Permission denied on output**
→ Specify a writable output path: `--output-dir ~/Desktop/audit_output`

If a specific pass fails but others succeed, run the failing script individually:

```bash
# Example: Re-run just the Firestore scanner
python seds-audit-harness/scripts/extract_firestore_schemas.py \
  --repo-path . \
  --output ./audit_output/firestore_schema_inventory.json
```

---

## Step 4: Manual Deep-Dive (CRITICAL — The Scripts Cannot Catch Everything)

The automated scripts use regex and AST parsing. They miss runtime behavior, conditional imports, and dynamic Firestore paths. After the scripts finish, manually inspect these areas:

### 4A. Auth Deep-Dive
- Find the Firebase config file (search for `initializeApp` or `firebase.ts` or `firebaseConfig`).
- Trace `onAuthStateChanged` to see how user sessions persist.
- Check for custom claims (`setCustomUserClaims`) in Cloud Functions.
- Check middleware.ts for server-side auth verification.

### 4B. Firestore Deep-Dive
- Search for `collection(db,` and `doc(db,` across all files.
- Look for dynamic collection paths: `collection(db, \`chapters/\${chapterId}/members\`)`.
- Read `firestore.rules` line by line. Document every `allow read`, `allow write`, and `allow create` condition.

### 4C. File Upload Deep-Dive
- Search for `ref(storage,`, `uploadBytes`, `uploadBytesResumable`, `getDownloadURL`.
- Check if `storage.rules` enforces file size limits and MIME type validation.
- Look for dropzone components (`react-dropzone`, `useDropzone`, or custom `<input type="file">`).

### 4D. External Services Deep-Dive
- Search for `fetch(`, `axios.`, `httpCallable`, environment variable references (`process.env.`).
- Check `functions/` directory for Cloud Functions that call external APIs.
- Look for email triggers (SendGrid, Resend, Nodemailer), webhook dispatchers, and Stripe/payment integrations.

### 4E. Component Fidelity Check
- For every form with a "Submit" button, trace the `onSubmit` handler.
  - Does it call a Firestore `addDoc` / `setDoc`? → Tier 1.
  - Does it call a mock function or `console.log`? → Tier 3.
  - Does it call an API route that returns hardcoded data? → Tier 2.

**Add your manual findings to the BRAG report before finalizing.**

---

## Step 5: Verify Outputs

Run both verification scripts:

```bash
python seds-audit-harness/scripts/harness_verify.py
python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output
```

Both must exit with code 0.

Check that `./audit_output/` contains at minimum:
- [ ] `CAPABILITIES_BRAG_REPORT.md`
- [ ] `GROUND_TRUTH_SCHEMA.json`
- [ ] `SEDS_BRAIN_INGESTION_BUNDLE.md`

---

## Step 6: Quality Gate Checklist (Verify Before Sending)

Before you declare the audit complete, confirm every item:

- [ ] Every route in the app has a tier classification (Tier 1 / 2 / 3).
- [ ] Every Firestore collection found in code appears in `GROUND_TRUTH_SCHEMA.json`.
- [ ] All file path references in the BRAG report point to actual files in the repo.
- [ ] Zero API keys, secrets, or tokens appear in any output file.
- [ ] Zero placeholder text like `[TBD]`, `[INSERT]`, `TODO`, or `FIXME` in the BRAG report.
- [ ] The ingestion bundle follows the L0-L3 pyramid structure (raw evidence → atomic facts → scenarios → strategic constraints).
- [ ] Forms that only `console.log` on submit are classified as Tier 3, not Tier 1.

---

## Step 7: Package and Send

Compress the output folder:

```bash
# Linux / macOS
tar -czvf seds_audit_results.tar.gz -C ./audit_output .

# Windows PowerShell
Compress-Archive -Path .\audit_output\* -DestinationPath "seds_audit_results.zip"
```

**Send these 3 files back to Zubair:**
1. `CAPABILITIES_BRAG_REPORT.md`
2. `GROUND_TRUTH_SCHEMA.json`
3. `SEDS_BRAIN_INGESTION_BUNDLE.md`

Or send the entire `seds_audit_results.zip`.

---

## What These Files Are For

Zubair is the President of SEDS Pakistan (Students for the Exploration and Development of Space). He is building alliances with SEDS chapters in Canada, Portugal, Italy, Brazil, India, and 15+ other countries. He needs an exact, verified capability inventory of the SEDS Pakistan website to:

1. **Prove to partner chapters** that a centralized platform exists with real auth, real databases, and real intake forms.
2. **Identify gaps** (mock features, missing backends) that need engineering before onboarding international chapters.
3. **Feed the results into his knowledge graph** (Second Brain) so every future agent session starts with verified ground truth about the platform.

**Do not inflate capabilities. Do not classify mock features as production. Honest, grounded truth is the entire point of this audit.**
