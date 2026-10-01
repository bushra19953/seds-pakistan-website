# SEDS Codebase Audit Harness: Operational Manual

## 1. Overview and Core Purpose

The SEDS Audit Harness provides an automated, non-destructive inspection scaffold for the SEDS Pakistan official web portal. It inspects Next.js App Router and Pages Router architectures, React component AST trees, Firebase authentication rules, Firestore collections, and hardware CAD intake pipelines.

This manual serves two user groups:
1. Human software developers executing local audits from the command line.
2. Autonomous AI coding agents (Claude Code, Cursor, Antigravity, GitHub Copilot) performing codebase capability extraction.

The harness inspects code without altering production files, modifying environment variables, or executing remote writes to cloud databases.

---

## 2. Environment and Tooling Prerequisites

The harness uses standard Python and Node.js toolchains with zero external package dependencies.

### Required Runtimes
- **Python 3.8 or higher**: Executes AST parsers, regex tokenizers, schema generators, and verification suites. Uses Python standard library modules only (`pathlib`, `json`, `re`, `subprocess`, `argparse`, `sys`, `time`). Zero `pip install` commands required.
- **Node.js 18 or higher (Optional for verification)**: Inspects TypeScript definitions and runs Node.js verification scripts.
- **Git 2.30 or higher**: Resolves commit SHAs, file history, and branch status.

### Verification of Local Toolchain
Run these commands to verify runtime versions:

```bash
python --version
node --version
git --version
```

---

## 3. Quickstart: Single-Command Master Execution

The fastest way to audit a target codebase is through `scripts/audit_runner.py`.

### Linux and macOS
```bash
python scripts/audit_runner.py \
  --repo-path /path/to/seds-website \
  --output-dir ./audit_output \
  --verbose
```

### Windows PowerShell
```powershell
python .\scripts\audit_runner.py `
  --repo-path "C:\Projects\seds-website" `
  --output-dir ".\audit_output" `
  --verbose
```

The master runner orchestrates all inspection passes in sequential order, displays real-time progress indicators, and exits with code 0 upon completion.

---

## 4. Granular CLI Arguments and Options

`scripts/audit_runner.py` accepts these command line flags:

| Flag | Type | Default | Description |
|---|---|---|---|
| `--repo-path` | Path (Required) | None | Absolute or relative path to the root of the target website repository. |
| `--output-dir` | Path (Optional) | `./audit_output` | Destination directory where all JSON inventories, markdown reports, and summary manifests are written. |
| `--verbose` | Boolean Flag | False | Enables verbose terminal telemetry, displaying individual subcommands, timing metrics, and discovery counts. |

---

## 5. Autonomous AI Agent Operating Protocol

Autonomous AI agents executing this harness must follow this deterministic four-step loop:

### Step 1: Ingestion of Agent Invariants
Before reading target repository source code, the agent must read:
1. `AGENTS.md`: Operating constraints and anti-sycophancy rules.
2. `CLAUDE.md`: Context engineering guidelines and high-speed grep commands.
3. `prompts/01_context_decomposition.md`: Subsystem boundaries across Lobes A through E.

### Step 2: Automated Codebase Extraction
Execute `scripts/audit_runner.py` against the target repository root to produce structured JSON and Markdown artifacts in the output directory.

### Step 3: Capability Classification and Rubric Scoring
Load `prompts/02_brag_capability_rubric.md` to evaluate extracted features across the 5 evaluation dimensions:
- Data Persistence (Firestore CRUD, client versus server queries)
- Error Handling (Error boundaries, status alerts, recovery flows)
- Access Control (Auth gates, session tokens, custom claims)
- Binary Intake (CAD dropzones, STEP/STL validation, file size limits)
- Integration Pipeline (Third-party webhooks, notification dispatch)

### Step 4: Second Brain Ingestion Bundle Assembly
Review `prompts/03_second_brain_ingest_protocol.md` to confirm the generated `SEDS_BRAIN_INGESTION_BUNDLE.md` adheres to the TencentDB L0 to L3 memory pyramid structure.

---

## 6. Inspection Pipeline Architecture

The audit executes across seven coordinated passes:

```
[Target Next.js + Firebase Codebase]
                  │
                  ▼
┌────────────────────────────────────────────────────────┐
│ PASS 1: Component AST & Dependency Graph Analyzer      │
│ (scripts/analyze_components_ast.py)                    │
│ -> component_tree.json & dependency_graph.json         │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ PASS 2: Next.js Route Scanner                          │
│ (scripts/scan_nextjs_routes.py)                        │
│ -> nextjs_routes_inventory.json & routes_manifest.json │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ PASS 3: Firestore Schema Extractor                     │
│ (scripts/extract_firestore_schemas.py)                 │
│ -> firestore_schema_inventory.json & firestore_schemas │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ PASS 4: RBAC & Auth Auditor                            │
│ (scripts/audit_rbac_auth.py)                           │
│ -> rbac_auth_inventory.json & rbac_audit.json          │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ PASS 5: Hardware CAD & Storage Auditor (Conditional)   │
│ (scripts/audit_hardware_storage.py)                    │
│ -> storage_schemas.json                                │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ PASS 6: External Services & Webhooks (Conditional)     │
│ (scripts/audit_external_services.py)                   │
│ -> external_services.json                              │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ PASS 7: BRAG Capability & Deliverable Synthesis        │
│ (scripts/generate_brag_report.py)                      │
│ -> CAPABILITIES_BRAG_REPORT.md                         │
│ -> GROUND_TRUTH_SCHEMA.json                            │
│ -> SEDS_BRAIN_INGESTION_BUNDLE.md                      │
└────────────────────────────────────────────────────────┘
```

### Detailed Pass Breakdown:
- **Pass 1: Component AST Analysis**: Scans all `.tsx`, `.ts`, `.jsx`, `.js` files. Parses static and dynamic imports, exports, and JSX trees. Traces child component trees from entry routes down to leaf components. Detects file upload elements, CAD dropzones (`.step`, `.stl`, `.iges`), form hooks (`useForm`, `zodResolver`), and dead unreferenced components. Produces `component_tree.json` and `dependency_graph.json`.
- **Pass 2: Route Scanning**: Identifies Next.js App Router and Pages Router pages, dynamic segments, route handlers (`route.ts`), server actions, and middleware guards. Produces `nextjs_routes_inventory.json`.
- **Pass 3: Firestore Schema Extraction**: Extracts collection calls, field references, TypeScript interfaces, and parses `firestore.rules` for security conditions. Produces `firestore_schema_inventory.json`.
- **Pass 4: RBAC Auth Audit**: Scans Firebase Auth SDK methods, role comparison patterns, and flags client-only role checks lacking server-side enforcement. Produces `rbac_auth_inventory.json`.
- **Pass 5: Hardware Storage Audit**: Inspects `storage.rules`, upload size ceilings, and binary intake pipelines.
- **Pass 6: External Services Audit**: Inspects third-party notification APIs, webhooks, and hosting redirects.
- **Pass 7: BRAG Synthesis**: Combines all inventories into the final capability matrix, ground-truth schema, and Second Brain ingestion bundle.

---

## 7. Output Deliverables and Schema Contracts

All deliverables are written to the directory specified by `--output-dir`.

### Core Deliverables Catalog:
1. `CAPABILITIES_BRAG_REPORT.md`: Evaluates each module across three capability tiers:
   - **Tier 1 (Production Ready)**: Verified database persistence and enforced server authorization.
   - **Tier 2 (Partial / Work in Progress)**: Functional UI with incomplete validation or client-only checks.
   - **Tier 3 (Mock / Stub)**: Static visual facade without data persistence.
2. `GROUND_TRUTH_SCHEMA.json`: Machine-readable master schema preserving discovered routes, Firestore collections, TypeScript interfaces, API endpoints, storage buckets, and access roles.
3. `SEDS_BRAIN_INGESTION_BUNDLE.md`: Dense Markdown dossier structured for Zubair's Second Brain memory pyramid. Includes L0 provenance, L1 atomic facts ledger table with `node_id` tags, L2 operational scenarios, L3 strategic arbitrage, and Mermaid sourcing canvas.
4. `component_tree.json`: Hierarchical component tree for every route showing depth, child components, form inputs, and CAD dropzones.
5. `dependency_graph.json`: Complete directed graph containing internal file nodes, external package dependencies, circular dependency cycles, and dead component inventories.
6. `audit_execution_summary.json`: Execution manifest with timestamps, durations, step statuses, and artifact paths.

---

## 8. Verification and Transmission Protocol

Before dispatching results to Zubair, the operator must verify deliverables.

### Step 1: Verification Suite Execution
Run the verification check:
```bash
python scripts/harness_verify.py
```
This confirms script syntax, verifies mock fixture execution, and validates stop-slop prose rules.

### Step 2: Distribution Archive Creation
Compress the deliverables into an archive:

```bash
# Linux / macOS
tar -czvf seds_audit_results_$(date +%F).tar.gz -C ./audit_output .

# Windows PowerShell
Compress-Archive -Path .\audit_output\* -DestinationPath "seds_audit_results_$(Get-Date -Format 'yyyy-MM-dd').zip"
```

### Step 3: Cryptographic Integrity Checksum
Generate a SHA-256 hash:

```bash
# Linux / macOS
sha256sum seds_audit_results_*.tar.gz > checksum.sha256

# Windows PowerShell
Get-FileHash -Algorithm SHA256 .\seds_audit_results_*.zip | Out-File -FilePath checksum.sha256
```

### Step 4: Secure Dispatch
Transmit archive and checksum to Zubair via WeChat or WhatsApp with subject `[SEDS AUDIT BUNDLE]`.

---

## 9. Exit Codes and Troubleshooting Guide

### Exit Code Definitions:
- **0**: Success. All audit passes executed and all deliverables generated.
- **1**: Target repository does not exist, syntax validation failed, or a subprocess step failed.

### Troubleshooting Scenarios:

#### Scenario A: Target Repository Path Not Found
- **Symptom**: `Error: Target repository does not exist: /path`
- **Remedy**: Provide absolute path to repository root (containing `package.json` or `app/`/`pages/`).

#### Scenario B: Monorepo Subdirectory Structure
- **Symptom**: `total_routes: 0`
- **Remedy**: In Turborepo or Nx monorepos, point `--repo-path` to the web application root (e.g. `apps/web` or `packages/portal`).

#### Scenario C: Non-Standard Import Aliases
- **Symptom**: Components in `components/` flagged as dead when imported as `@app/components`.
- **Remedy**: Ensure `tsconfig.json` or `jsconfig.json` defines `compilerOptions.paths`. The AST parser parses path aliases from configuration.

#### Scenario D: Permission Denied on Output Directory
- **Symptom**: `PermissionError: [Errno 13]`
- **Remedy**: Specify an output directory in user workspace with write access using `--output-dir`.
