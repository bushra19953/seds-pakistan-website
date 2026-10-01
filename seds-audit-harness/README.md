# SEDS Website Audit Harness

## Purpose

This harness guides developers and AI agents through a forensic audit of the SEDS Pakistan official website repository. It uncovers working systems, half-built features, and static mock components without altering production code. 

The audit extracts empirical ground truth about:
- Authentication flows and access control gates
- Component AST hierarchies and directed dependency graphs
- Database schemas and persistence layers
- Hardware intake forms for CAD, STEP, and STL files
- Third-party communication integrations for email and chat
- Frontend component fidelity and production readiness

The harness equips any developer with tools to verify claims before integrating the SEDS Sourcing Bridge portal.

---

## System Requirements

Install these tools before running the audit:

- **Python 3.8+**: Runs AST parsing scripts, JSON schema generation, and token budget management. Uses standard library modules only. Zero pip packages required.
- **Node.js 18+ & npm 9+**: Inspects TypeScript interfaces, React component trees, and Next.js route maps.
- **Git 2.30+**: Tracks file modification dates, commit authorship, and codebase churn.

Verify tool availability:

```bash
python --version
node --version
git --version
```

---

## Directory Architecture

```
seds-audit-harness/
├── GATES.md                           # Acceptance gates ledger
├── HARNESS_INSTRUCTIONS.md            # Comprehensive operational manual
├── README.md                          # Master developer quickstart guide
├── AGENTS.md                          # Operating instructions for AI agents
├── CLAUDE.md                          # Context engineering rules for Claude Code
├── prompts/                           # Sequential execution prompt playbooks
│   ├── 01_context_decomposition.md    # Codebase lobe isolation prompt
│   ├── 02_brag_capability_rubric.md   # Objective 3-tier capability rubric
│   └── 03_second_brain_ingest_protocol.md # Second Brain ingestion guide
├── schemas/                           # Formal JSON validation schemas
├── scripts/
│   ├── audit_runner.py                # Unified master audit pipeline runner
│   ├── analyze_components_ast.py      # Component AST and dependency graph analyzer
│   ├── scan_nextjs_routes.py          # Next.js route scanner
│   ├── extract_firestore_schemas.py   # Firestore schema extractor
│   ├── audit_rbac_auth.py             # RBAC and Auth auditor
│   ├── generate_brag_report.py        # BRAG report and bundle generator
│   ├── verify_bundle.py               # Deliverable verification tool
│   └── harness_verify.py              # Verification test suite
└── docs/
    └── harness-adoption-report.md     # Harness adoption report
```

---

## Single-Command Execution

The developer can run the audit through an automated single-command runner, a piped multi-stage suite, or an interactive AI agent.

### Option A: Master Audit Runner

Execute the automated scanner from the harness directory:

```bash
python scripts/audit_runner.py --repo-path /path/to/seds-website --output-dir ./audit_output --verbose
```

On Windows PowerShell:

```powershell
python .\scripts\audit_runner.py --repo-path "C:\Projects\seds-website" --output-dir ".\audit_output" --verbose
```

The script orchestrates seven sequential inspection passes:
1. Component AST, JSX hierarchy, form input, and dependency graph scan
2. Next.js App Router and Pages Router route mapping
3. Firestore collection, interface, and security rule extraction
4. RBAC role detection and client-side guard audit
5. Hardware CAD storage and upload ceiling audit (if scanner present)
6. External service API and webhook audit (if scanner present)
7. BRAG capability classification and deliverable synthesis

### Option B: Multi-Stage Specialized Python Pipeline

Run each specialized script in sequence for granular inspection:

```bash
# 1. Analyze component AST and dependency graph
python scripts/analyze_components_ast.py \
  --repo-path <PATH_TO_SEDS_REPO> \
  --output-tree component_tree.json \
  --output-graph dependency_graph.json

# 2. Scan Next.js routes
python scripts/scan_nextjs_routes.py \
  --repo-path <PATH_TO_SEDS_REPO> \
  --output nextjs_routes_inventory.json

# 3. Extract database schemas
python scripts/extract_firestore_schemas.py \
  --repo-path <PATH_TO_SEDS_REPO> \
  --output firestore_schema_inventory.json

# 4. Audit authentication and RBAC roles
python scripts/audit_rbac_auth.py \
  --repo-path <PATH_TO_SEDS_REPO> \
  --output rbac_auth_inventory.json

# 5. Generate BRAG evaluation deliverables
python scripts/generate_brag_report.py \
  --routes nextjs_routes_inventory.json \
  --firestore firestore_schema_inventory.json \
  --rbac rbac_auth_inventory.json \
  --output-dir audit_output/
```

### Option C: Guided AI Agent Execution

Mount this harness inside your AI coding assistant (Cursor, Claude Code, Antigravity, or GitHub Copilot):

1. Copy `AGENTS.md` and `CLAUDE.md` to the root of the target website repository.
2. Open the website repository in your IDE.
3. Feed the prompts in `prompts/` in sequence:
   - `prompts/01_context_decomposition.md`
   - `prompts/02_brag_capability_rubric.md`
   - `prompts/03_second_brain_ingest_protocol.md`
4. The agent writes all deliverables to `./audit_output/`.

Consult `HARNESS_INSTRUCTIONS.md` for detailed agent operating protocols.

---

## Output Deliverables

The audit produces core deliverables inside `./audit_output/`:

### 1. `CAPABILITIES_BRAG_REPORT.md`
A technical audit report that classifies every feature into three tiers:
- **Tier 1 (Production Ready)**: Features with live database connections, input validation, error boundaries, and security rules.
- **Tier 2 (Partial / Work in Progress)**: Features with working UI connected to mock data, incomplete validation, or stubbed API endpoints.
- **Tier 3 (Mock / Stub)**: Visual facades, static JSX components, non-functional submit buttons, and hardcoded JSON arrays.

The report includes exact file references, line numbers, and remediation requirements for every gap.

### 2. `GROUND_TRUTH_SCHEMA.json`
A machine-readable specification that documents the real database architecture. It captures:
- Collection and table names
- Document attributes and data types
- Required versus optional fields
- TypeScript interface definitions
- API endpoint paths, methods, and payload structures
- Access control roles (Admin, Member, Guest, Sourcing Client)

### 3. `SEDS_BRAIN_INGESTION_BUNDLE.md`
A structured Markdown package engineered for direct ingestion into Zubair's TencentDB-Agent-Memory L0 to L3 pyramid. It provides:
- Immutable atomic facts for `L1_atomic_facts_ledger.md`
- Pre-formatted Mermaid nodes for `active_symbolic_sourcing_canvas.mmd`
- Subsystem links connecting web intake forms to Chinese aerospace manufacturing rings

### 4. `component_tree.json` & `dependency_graph.json`
Comprehensive AST structural deliverables mapping:
- Component hierarchies for all routes
- Form inputs, file uploads, and CAD dropzones (`.step`, `.stl`, `.iges`)
- Directed module import graphs, circular dependencies, and dead components

### 5. `audit_execution_summary.json`
Unified pipeline execution manifest recording timestamps, durations, step statuses, and output artifact paths.

---

## Verification and Packaging Protocol

Once the audit finishes, the developer must verify and package the results for Zubair.

### Step 1: Run Output Verification

Run the harness test suite to confirm zero regressions:

```bash
python scripts/harness_verify.py
```

Check that deliverables pass verification:

```bash
python scripts/verify_bundle.py --output-dir ./audit_output
```

### Step 2: Create Distribution Archive

Compress the outputs into a single archive tagged with the current date:

```bash
# Linux / macOS
tar -czvf seds_audit_results_$(date +%F).tar.gz -C ./audit_output .

# Windows PowerShell
Compress-Archive -Path .\audit_output\* -DestinationPath "seds_audit_results_$(Get-Date -Format 'yyyy-MM-dd').zip"
```

### Step 3: Compute Cryptographic Checksum

Generate a SHA-256 hash to prove data integrity during transmission:

```bash
# Linux / macOS
sha256sum seds_audit_results_*.tar.gz > checksum.sha256

# Windows PowerShell
Get-FileHash -Algorithm SHA256 .\seds_audit_results_*.zip | Out-File -FilePath checksum.sha256
```

### Step 4: Transmit Bundle to Zubair

Send the compressed archive and `checksum.sha256` to Zubair through established channels:
- **WeChat**: Dispatch to verified handle with header `[SEDS AUDIT BUNDLE]`
- **WhatsApp**: Attach to the SEDS Executive operational chat
- **Git**: Push to branch `audit/ground-truth-results` and open a Pull Request

Zubair ingests the bundle into the Second Brain memory pyramid to lock verified capabilities into the sourcing pipeline.
