# Specification Report & Handoff: SEDS Audit Harness & Schemas

**Author**: `spec_miner_harness_1` (Specification Investigator / Spec Miner)  
**Date**: 2026-09-26  
**Target Repository**: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT`  
**Working Directory**: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\spec_miner_harness_1`  
**Parent Agent**: Project Orchestrator (`eb50595a-b458-4e87-a8e8-2126d0c6a4ec`)  

---

## Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Pipeline Orchestrator | `audit_runner.py` Master Runner | Orchestrates the 7 sequential audit passes, creates checkpoint directories, writes intermediate files, duplicates schema aliases, generates final deliverables, and records `audit_execution_summary.json`. | `--repo-path <PATH>` (required), `--output-dir <PATH>` (default `./audit_output`), `--verbose` (boolean flag) | 16 JSON/Markdown files in output directory, plus `lobe_checkpoints/` | Exits with code 1 if `--repo-path` is invalid or any subcommand exits non-zero. | `seds-audit-harness/scripts/audit_runner.py` |
| 2 | Static Analysis (Pass 1) | `analyze_components_ast.py` | Parses JSX/TSX component trees, form elements, CAD dropzones, imports/exports, dead unreferenced components, and generates directed dependency graphs. | `--repo-path <PATH>`, `--output-tree <PATH>`, `--output-graph <PATH>`, optional `--max-depth <INT>`, `--verbose` | `component_tree.json`, `dependency_graph.json` | Exits non-zero on file access failure or syntax errors. | `seds-audit-harness/scripts/analyze_components_ast.py` |
| 3 | Route Discovery (Pass 2) | `scan_nextjs_routes.py` | Traverses App Router (`app/` or `src/app/`) and Pages Router (`pages/` or `src/pages/`), detects dynamic params, route groups, parallel slots, intercepting routes, server actions, middleware, layout chains, error boundaries, and auth checks. | `--repo-path <PATH>`, `--output <PATH>` | `nextjs_routes_inventory.json`, aliased to `routes_manifest.json` | Exits non-zero if target repo does not exist. | `seds-audit-harness/scripts/scan_nextjs_routes.py` |
| 4 | Database Extractor (Pass 3) | `extract_firestore_schemas.py` | Extracts Firestore collections, subcollections, document fields, queries (`where`, `orderBy`, `limit`), operations (`getDocs`, `addDoc`, etc.), TypeScript interfaces, Zod schemas, mutation hooks, and parses `firestore.rules`. | `--repo-path <PATH>`, `--output <PATH>` | `firestore_schema_inventory.json`, aliased to `firestore_schemas.json` | Exits non-zero if target repo does not exist. | `seds-audit-harness/scripts/extract_firestore_schemas.py` |
| 5 | Security Auditor (Pass 4) | `audit_rbac_auth.py` | Audits Firebase Auth SDK methods, custom claims, session cookies (`__session`), multi-tenant chapter scoping, role check expressions, and flags client-only role checks lacking server verification. | `--repo-path <PATH>`, `--output <PATH>` | `rbac_auth_inventory.json`, aliased to `rbac_audit.json` | Exits non-zero if target repo does not exist. | `seds-audit-harness/scripts/audit_rbac_auth.py` |
| 6 | Storage Auditor (Pass 5) | `audit_hardware_storage.py` | Scans CAD/BOM file dropzones (`.step`, `.stl`, `.iges`, etc.), upload size limit checks (100MB ceiling), MIME whitelists, storage SDK calls, and parses `storage.rules`. | `--repo-path <PATH>`, `--output <PATH>` | `storage_schemas.json`, aliased to `hardware_pipeline_inventory.json` | Skipped with status `"SKIPPED_NOT_PRESENT"` if script not on disk; executes if present. | `seds-audit-harness/scripts/audit_hardware_storage.py` |
| 7 | Integration Auditor (Pass 6) | `audit_external_services.py` | Detects Google APIs (OAuth, Drive, Sheets, Functions), email relays (Resend, SendGrid, Nodemailer), webhooks (Discord, Slack, Telegram, WhatsApp, Stripe), hosting configs (`next.config`, `vercel.json`, `firebase.json`), environment variables, and hardcoded secrets. | `--repo-path <PATH>`, `--output <PATH>` | `external_services.json`, aliased to `external_services_inventory.json` | Skipped with status `"SKIPPED_NOT_PRESENT"` if script not on disk; executes if present. | `seds-audit-harness/scripts/audit_external_services.py` |
| 8 | Report Synthesizer (Pass 7) | `generate_brag_report.py` | Evaluates routes and 5 architectural lobes against 0-100 rubric, generates `CAPABILITIES_BRAG_REPORT.md`, master `GROUND_TRUTH_SCHEMA.json`, and `SEDS_BRAIN_INGESTION_BUNDLE.md`. | `--routes <PATH>`, `--firestore <PATH>`, `--rbac <PATH>`, `--output-dir <PATH>`, optional `--tree`, `--graph`, `--storage`, `--external` | `CAPABILITIES_BRAG_REPORT.md`, `GROUND_TRUTH_SCHEMA.json`, `SEDS_BRAIN_INGESTION_BUNDLE.md` | Crashes with `AttributeError` if `discovered_interfaces` values are lists unless patched. | `seds-audit-harness/scripts/generate_brag_report.py` |
| 9 | Quality Gate | `harness_verify.py` | Acceptance verification suite: compiles all 5 scripts, creates temporary Next.js/Firebase repo fixture, runs scanners and generators end-to-end, validates assertions, and enforces stop-slop prose rules. | Optional `--harness-dir <PATH>` (defaults to parent of `scripts/`) | Terminal logs (`[PASS]`/`[ERROR]`), exits 0 on total success | Exits code 1 on script syntax error, missing file, failed assertion, or stop-slop prose violation. | `seds-audit-harness/scripts/harness_verify.py` |
| 10 | Quality Gate | `verify_bundle.py` | Deliverable gate: validates presence, non-zero sizes (min 500B / 100B), required keys (`collections`, `endpoints`, `roles`), and required markdown section tokens. | `--output-dir <PATH>` (default `./audit_output`) | Terminal status (`PASS: ...` / `FAIL: ...`), exits 0 or 1 | Exits code 1 if directory missing, files undersized, missing JSON keys, or missing required markdown tokens. | `seds-audit-harness/scripts/verify_bundle.py` |
| 11 | Schema Definition | `ground_truth.schema.json` | Draft-07 JSON schema specifying master schema structure for `GROUND_TRUTH_SCHEMA.json`. | JSON input file | JSON validation result | Validation errors if required keys or types deviate. | `seds-audit-harness/schemas/ground_truth.schema.json` |
| 12 | Delivery Packaging | `seds_audit_results.zip` | Compressed distribution archive containing all audit output files with cryptographic SHA-256 integrity hash in `checksum.sha256`. | `./audit_output/*` | `seds_audit_results.zip`, `checksum.sha256` | Incomplete archive or hash mismatch invalidates delivery. | `seds-audit-harness/README.md` & `HARNESS_INSTRUCTIONS.md` |

---

## Edge Cases

| # | Feature | Input | Observed Behavior |
|---|---------|-------|-------------------|
| 1 | `generate_brag_report.py` | `first_iface` in `interfaces` is `list` (from `extract_firestore_schemas.py`) | Crashes at line 395 / 434 with `AttributeError: 'list' object has no attribute 'get'`. `extract_firestore_schemas.py` stores interfaces as `Dict[str, List[Dict[str, Any]]]`, whereas `generate_brag_report.py` expects a dict with a `"file"` key. |
| 2 | `harness_verify.py` Stop-Slop Prose Audit | Words ending in `-ly` where `len > 3` | Flags any word ending in `-ly` not in `{"apply", "early", "rely", "only", "daily", "assembly", "family", "supply", "multiply", "reply"}` as an error. Flags both generated markdown files and all Python scripts' comments/docstrings. |
| 3 | `harness_verify.py` Em Dash Audit | Em dashes: `\u2014`, `\u2013`, or `\s--\s` | Immediate error flag. Dashes must be formatted as hyphens or parentheses without em dash Unicode characters. |
| 4 | `verify_bundle.py` Token Checking | Missing required string tokens in markdown | Fails if `CAPABILITIES_BRAG_REPORT.md` lacks any of: `["Tier 1", "Tier 2", "Tier 3", "Data Persistence", "Access Control"]`. Fails if `SEDS_BRAIN_INGESTION_BUNDLE.md` lacks any of: `["node_id", "SEDS-WEB-PORTAL-L1", "SEDS-INTAKE-CAD-L1", "flowchart", "subgraph"]`. |
| 5 | `verify_bundle.py` File Size Thresholds | Output file under byte threshold | `CAPABILITIES_BRAG_REPORT.md` requires >= 500 bytes; `GROUND_TRUTH_SCHEMA.json` requires >= 100 bytes; `SEDS_BRAIN_INGESTION_BUNDLE.md` requires >= 500 bytes. Undersized files fail with code 1. |
| 6 | `audit_runner.py` Conditional Passes | Missing `audit_hardware_storage.py` or `audit_external_services.py` | Runner checks `is_file()` before invocation. If missing, marks status `"SKIPPED_NOT_PRESENT"` and continues pipeline without failure. If present, executes and copies aliases. |
| 7 | `audit_runner.py` Output Aliasing | Intermediate JSON files | Passes 2, 3, 4, 5, 6 duplicate outputs via `shutil.copy2` to fulfill dual naming requirements (`nextjs_routes_inventory.json` -> `routes_manifest.json`, `firestore_schema_inventory.json` -> `firestore_schemas.json`, `rbac_auth_inventory.json` -> `rbac_audit.json`, `storage_schemas.json` -> `hardware_pipeline_inventory.json`, `external_services.json` -> `external_services_inventory.json`). |
| 8 | Monorepo / Directory Layouts | Next.js routes in `app/`, `pages/`, `src/app/`, or `src/pages/` | `scan_nextjs_routes.py` checks both root candidates and `src/` subdirectories (`[resolved_repo / 'app', resolved_repo / 'src' / 'app']`). |

---

## 1. Observation

Direct examination of `seds-audit-harness/` reveals the following concrete code structures, interfaces, and behaviors:

### 1.1 `audit_runner.py` Architecture & Execution Flow
- **CLI Arguments** (`parse_args` lines 22-44):
  - `--repo-path` (required, Path): Root directory of target repository.
  - `--output-dir` (optional, Path, default: `./audit_output`): Destination directory for deliverables.
  - `--verbose` (optional, flag): Enables verbose command logging and timing.
- **Directory Setup** (lines 97-100):
  - Resolves target directory. Exits with code 1 if `not resolved_repo.exists()`.
  - Creates `output_dir` and `output_dir / "lobe_checkpoints"` with `mkdir(parents=True, exist_ok=True)`.
- **Pass Execution Pipeline** (lines 116-308):
  1. **Pass 1**: `scripts/analyze_components_ast.py`
     - Command: `python analyze_components_ast.py --repo-path <repo> --output-tree <out>/component_tree.json --output-graph <out>/dependency_graph.json [--verbose]`
     - Writes: `component_tree.json`, `dependency_graph.json`
  2. **Pass 2**: `scripts/scan_nextjs_routes.py`
     - Command: `python scan_nextjs_routes.py --repo-path <repo> --output <out>/nextjs_routes_inventory.json`
     - Writes: `nextjs_routes_inventory.json`
     - Copies alias: `routes_manifest.json`
  3. **Pass 3**: `scripts/extract_firestore_schemas.py`
     - Command: `python extract_firestore_schemas.py --repo-path <repo> --output <out>/firestore_schema_inventory.json`
     - Writes: `firestore_schema_inventory.json`
     - Copies alias: `firestore_schemas.json`
  4. **Pass 4**: `scripts/audit_rbac_auth.py`
     - Command: `python audit_rbac_auth.py --repo-path <repo> --output <out>/rbac_auth_inventory.json`
     - Writes: `rbac_auth_inventory.json`
     - Copies alias: `rbac_audit.json`
  5. **Pass 5**: `scripts/audit_hardware_storage.py` (Conditional on `hardware_script.is_file()`)
     - Command: `python audit_hardware_storage.py --repo-path <repo> --output <out>/storage_schemas.json`
     - Writes: `storage_schemas.json`
     - Copies alias: `hardware_pipeline_inventory.json`
     - Note: `scripts/audit_hardware_storage.py` is present on disk (410 lines).
  6. **Pass 6**: `scripts/audit_external_services.py` (Conditional on `external_script.is_file()`)
     - Command: `python audit_external_services.py --repo-path <repo> --output <out>/external_services.json`
     - Writes: `external_services.json`
     - Copies alias: `external_services_inventory.json`
     - Note: `scripts/audit_external_services.py` is present on disk (506 lines).
  7. **Pass 7**: `scripts/generate_brag_report.py`
     - Command: `python generate_brag_report.py --routes <out>/nextjs_routes_inventory.json --firestore <out>/firestore_schema_inventory.json --rbac <out>/rbac_auth_inventory.json --output-dir <out>`
     - Implicitly loads from `<output_dir>`: `component_tree.json`, `dependency_graph.json`, `storage_schemas.json`, `external_services.json`.
     - Writes: `CAPABILITIES_BRAG_REPORT.md`, `GROUND_TRUTH_SCHEMA.json`, `SEDS_BRAIN_INGESTION_BUNDLE.md`.
- **Manifest File Generation** (lines 312-334):
  - Writes: `audit_execution_summary.json` containing pipeline timestamp, duration, target repo, output directory, `steps_executed` list, and `deliverables` dictionary mapping 8 core artifacts.

### 1.2 Verification Scripts Analysis

#### `harness_verify.py` (Lines 1-484)
- Syntax validation (`check_script_syntax` lines 51-63):
  - Validates `SCRIPTS`: `["scan_nextjs_routes.py", "extract_firestore_schemas.py", "audit_rbac_auth.py", "generate_brag_report.py", "harness_verify.py"]` using `py_compile.compile(..., doraise=True)`.
- Mock fixture creation (`create_mock_seds_repository` lines 109-330):
  - Builds temporary Next.js project with App Router, Pages Router, Server Actions, Firebase Auth, Firestore queries, and `firestore.rules`.
- Execution checks:
  - `scan_nextjs_routes.py`: asserts `routes_data["summary"]["total_routes"] >= 5`, `"app"` and `"pages"` in `router_types_detected`.
  - `extract_firestore_schemas.py`: asserts `"chapters"` and `"events"` in `collections`, `"Chapter"` in `discovered_interfaces`.
  - `audit_rbac_auth.py`: asserts `"chapter_lead"` and `"admin"` in `roles_discovered`.
  - `generate_brag_report.py`: asserts all 3 deliverable files exist, and `len(ground_data["routes"]) >= 5`.
- Stop-slop validation (`check_stop_slop_compliance` lines 90-106):
  - Disallows em dashes (`\u2014`, `\u2013`, `\s--\s`).
  - Disallows words ending in `-ly` (length > 3) not in `ALLOWED_EXCEPTIONS`: `{"apply", "early", "rely", "only", "daily", "assembly", "family", "supply", "multiply", "reply"}`.
  - Audits both markdown deliverables AND Python docstrings/comments in all 5 scripts.
- **Observed Failure upon Direct Execution**:
  - Running `python seds-audit-harness/scripts/harness_verify.py` failed with exit code 1:
    ```
    RuntimeError: Command failed (... generate_brag_report.py ...):
    File "seds-audit-harness/scripts/generate_brag_report.py", line 395, in compute_lobe_scorecards
      iface_file = first_iface.get("file", "")
                   ^^^^^^^^^^^^^^^
    AttributeError: 'list' object has no attribute 'get'
    ```
  - Root cause: `extract_firestore_schemas.py` line 303 stores `all_interfaces: Dict[str, List[Dict[str, Any]]]`. `first_iface` is therefore a `list` of field objects, not a dict. Line 395 and line 434 in `generate_brag_report.py` attempt `.get("file", "")` without checking `isinstance(first_iface, dict)`.

#### `verify_bundle.py` (Lines 1-103)
- Checks `--output-dir` (default: `./audit_output`):
  1. `CAPABILITIES_BRAG_REPORT.md`: exists, >= 500 bytes, contains tokens `["Tier 1", "Tier 2", "Tier 3", "Data Persistence", "Access Control"]`.
  2. `GROUND_TRUTH_SCHEMA.json`: exists, >= 100 bytes, valid JSON, contains top-level keys `["collections", "endpoints", "roles"]`.
  3. `SEDS_BRAIN_INGESTION_BUNDLE.md`: exists, >= 500 bytes, contains tokens `["node_id", "SEDS-WEB-PORTAL-L1", "SEDS-INTAKE-CAD-L1", "flowchart", "subgraph"]`.

### 1.3 Schema Contracts

#### `seds-audit-harness/schemas/ground_truth.schema.json`
- Top-level object required keys:
  `["metadata", "routes", "collections", "endpoints", "roles", "typescript_interfaces", "storage_schemas", "external_services", "dependency_graph"]`
- `metadata` required keys:
  `["generated_at", "repo_path", "total_routes", "total_components", "total_collections", "total_roles"]`
- `routes`: array of objects (`path`, `route`, `router_type`, `http_methods`, `component_path`, `auth_required`, `roles_allowed`, `is_protected`).
- `endpoints`: array of objects (`route`, `method`, `file`, `handler_type`).
- `roles`: array of objects (`role_name`, `role`, `access_level`, `routes_guarded`).
- `collections`, `typescript_interfaces`, `storage_schemas`, `external_services`, `dependency_graph`: objects.

### 1.4 Deliverable Formatting & Rubric Specifications

#### `CAPABILITIES_BRAG_REPORT.md` (per `generate_brag_report.py` & Prompt 02)
- Must adhere to 5 technical evaluation dimensions:
  1. Data Persistence (0-20 pts)
  2. Error Handling / Resilience (0-20 pts)
  3. Access Control (0-20 pts)
  4. Binary Intake (0-20 pts)
  5. Integration Pipeline (0-20 pts)
  - Tier 1: 90-100 pts (Production Ready)
  - Tier 2: 40-89 pts (Partial / WIP)
  - Tier 3: 0-39 pts (Mock / Stub)
- Required sections:
  1. `# SEDS Capabilities BRAG Evaluation Report`
  2. `## Executive Scorecard` (Table)
  3. `## Five Evaluation Dimensions`
  4. `## Module-Level Scorecard Breakdown Across Five Lobes` (Lobes A-E with score breakdown, empirical evidence, and remediation plan)
  5. `## Route Inventory and Readiness Grading` (Table)
  6. `## Empirical Evidence and Code Citations` (Per-route breakdown)
  7. `## Firestore Collection Schemas and Operations` (Operations, security rule path & allow conditions, known schema fields)
  8. `## Role-Based Access Control Audit` (Discovered roles, flagged security risks)
  9. `## Strategic Remediation Plan`
- Strict stop-slop rules: zero em dashes, zero adverbs ending in `-ly` (unless in `ALLOWED_EXCEPTIONS`), zero placeholders (`TODO`, `[TBD]`).

#### `SEDS_BRAIN_INGESTION_BUNDLE.md` (per `generate_brag_report.py` & Prompt 03)
- Conforms to TencentDB-Agent-Memory L0-L3 memory pyramid:
  1. `# SEDS Platform Architecture and Capability Dossier` + `Related dossiers:` wikilinks
  2. `## Section 1: L0 Epistemic Provenance` (Timestamp, repo path, branch/commit, auditor model, cleanliness, metrics, scanner roster)
  3. `## Section 2: L1 Atomic Fact Ledger Insertions` (12-column table with `node_id`, `Entity Name`, `Ring / Hub`, `Subsystem`, `Key Contact`, `Verified Phone`, `Verified WeChat ID`, `Verified Machinery Bank`, `Metrology & Certs`, `Factory Physical Gate Address`, `Pipeline Status`, `Evidence / Dossier Path`)
     - Node IDs: `SEDS-WEB-PORTAL-L1`, `SEDS-RBAC-AUTH-L1`, `SEDS-DATA-FIRESTORE-L1`, `SEDS-INTAKE-CAD-L1`, `SEDS-EXT-INTEGRATION-L1`
  4. `## Section 3: L2 Operational Scenarios` (Scenarios 1, 2, and 3)
  5. `## Section 4: L3 Arbitrage Analysis and Strategic Alignment` (Cost Arbitrage 50-70%, Turnaround 12 weeks to 7 days, Flight Qualification)
  6. `## Section 5: L3 Master Sourcing Canvas` (Mermaid `flowchart TD` connecting `SEDS_Web_Bridge`, `SEDS_Subsystems` S1-S6, and `China_Manufacturing_Corridor` with `CJPM`, `SENDOT`, `YZ`, `ILINK`)

### 1.5 Packaging Specifications
- Archive name: `seds_audit_results.zip`
- Path: root directory of workspace
- Contents: All artifacts in `./audit_output/`
- PowerShell generation command: `Compress-Archive -Path .\audit_output\* -DestinationPath "seds_audit_results.zip" -Force`
- Checksum: `Get-FileHash -Algorithm SHA256 .\seds_audit_results.zip | Out-File -FilePath checksum.sha256`

---

## 2. Logic Chain

1. **Input Trace**:
   - The user requested a comprehensive forensic audit using `seds-audit-harness/`.
   - `DISPATCH.md` directed `spec_miner_harness_1` to investigate the harness scripts, schemas, templates, validation rules, intermediate files, deliverable formats, and packaging requirements.
2. **Analysis of Execution Pipeline**:
   - `audit_runner.py` is the top-level CLI orchestrator that calls scripts sequentially.
   - It executes 7 passes, but Passes 5 and 6 check if `audit_hardware_storage.py` and `audit_external_services.py` exist before running them. Since both are present in `seds-audit-harness/scripts/`, all 7 passes will execute when invoked against the target repository.
   - Outputs from Passes 1-6 are written into `./audit_output/`, and several are copied to alias filenames to satisfy alternative naming conventions.
   - Pass 7 (`generate_brag_report.py`) consumes the outputs of Passes 1-6 and produces the final 3 deliverables.
3. **Analysis of Verification Gates**:
   - Acceptance criteria require both `harness_verify.py` and `verify_bundle.py` to exit with code 0.
   - `verify_bundle.py` inspects the delivered files in `./audit_output/` for specific string tokens, minimum file sizes, and top-level JSON keys.
   - `harness_verify.py` tests the harness itself against an ephemeral mock repository and validates stop-slop prose rules.
   - Running `harness_verify.py` directly exposed a runtime crash in `generate_brag_report.py` at line 395 due to an unhandled data type mismatch between `extract_firestore_schemas.py` (`all_interfaces` is `Dict[str, List]`) and `generate_brag_report.py` (which treats `first_iface` as a `Dict` and calls `.get("file")`).
   - For downstream agents, this means `generate_brag_report.py` requires a patch (`isinstance(first_iface, dict)`) before `harness_verify.py` can pass.
4. **Schema & Report Synthesis**:
   - `GROUND_TRUTH_SCHEMA.json` must strictly validate against `schemas/ground_truth.schema.json`.
   - `CAPABILITIES_BRAG_REPORT.md` and `SEDS_BRAIN_INGESTION_BUNDLE.md` must strictly conform to stop-slop rules (no em dashes, no forbidden `-ly` adverbs) and must contain the exact token strings checked by `verify_bundle.py`.
   - Packaging must compress `./audit_output/*` into `seds_audit_results.zip` with a SHA-256 hash.

---

## 3. Caveats

1. **Read-Only Mining Scope**: As a specification miner, no source code files or harness scripts were modified in this turn. The `AttributeError` bug in `generate_brag_report.py` line 395 and line 434 was identified and documented, but must be resolved by an implementation/fixer agent or orchestrator before `harness_verify.py` can pass.
2. **Target Codebase Monorepo vs Flat Layout**: In the root directory, code is placed in `src/` (e.g. `src/app/` or `src/pages/`). `scan_nextjs_routes.py` supports both `./app` and `./src/app`.
3. **Execution Environment**: Shell commands on Windows PowerShell require forward slashes or escaped backslashes, and non-interactive flags must be respected.

---

## 4. Conclusion

The specification for executing and validating the SEDS Codebase Audit Harness is fully mined, verified, and mapped:

1. **Audit Execution Command**:
   ```bash
   python seds-audit-harness/scripts/audit_runner.py --repo-path . --output-dir ./audit_output --verbose
   ```
2. **Complete Output Artifact Inventory (16 files + checkpoints)**:
   - `component_tree.json` & `dependency_graph.json`
   - `nextjs_routes_inventory.json` & `routes_manifest.json`
   - `firestore_schema_inventory.json` & `firestore_schemas.json`
   - `rbac_auth_inventory.json` & `rbac_audit.json`
   - `storage_schemas.json` & `hardware_pipeline_inventory.json`
   - `external_services.json` & `external_services_inventory.json`
   - `CAPABILITIES_BRAG_REPORT.md`
   - `GROUND_TRUTH_SCHEMA.json`
   - `SEDS_BRAIN_INGESTION_BUNDLE.md`
   - `audit_execution_summary.json`
   - `lobe_checkpoints/`
3. **Quality Gates to Satisfy**:
   - `python seds-audit-harness/scripts/harness_verify.py` (requires patching lines 395 & 434 of `generate_brag_report.py` to guard `isinstance(first_iface, dict)`).
   - `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output`.
   - JSON Schema validation of `GROUND_TRUTH_SCHEMA.json` against `seds-audit-harness/schemas/ground_truth.schema.json`.
4. **Packaging Protocol**:
   - Compress `./audit_output/*` into `seds_audit_results.zip`.
   - Compute SHA-256 hash in `checksum.sha256`.

---

## 5. Verification Method

To independently verify all findings in this specification report:

1. **Verify Script Arguments & Help Outputs**:
   ```powershell
   python seds-audit-harness/scripts/audit_runner.py --help
   python seds-audit-harness/scripts/scan_nextjs_routes.py --help
   python seds-audit-harness/scripts/extract_firestore_schemas.py --help
   python seds-audit-harness/scripts/audit_rbac_auth.py --help
   python seds-audit-harness/scripts/audit_hardware_storage.py --help
   python seds-audit-harness/scripts/audit_external_services.py --help
   python seds-audit-harness/scripts/generate_brag_report.py --help
   python seds-audit-harness/scripts/verify_bundle.py --help
   python seds-audit-harness/scripts/harness_verify.py --help
   ```

2. **Verify Schema Conformance**:
   Inspect `seds-audit-harness/schemas/ground_truth.schema.json` lines 6-16 to confirm required top-level keys.

3. **Verify Bundle Validator Tokens**:
   Inspect `seds-audit-harness/scripts/verify_bundle.py` lines 71, 33, 88 to confirm exact tokens:
   - BRAG Report: `["Tier 1", "Tier 2", "Tier 3", "Data Persistence", "Access Control"]`
   - Schema JSON: `["collections", "endpoints", "roles"]`
   - Brain Bundle: `["node_id", "SEDS-WEB-PORTAL-L1", "SEDS-INTAKE-CAD-L1", "flowchart", "subgraph"]`

4. **Verify Discovered Bug in `generate_brag_report.py`**:
   Inspect lines 393-397 and 432-436 of `seds-audit-harness/scripts/generate_brag_report.py`:
   Observe `first_iface = interfaces[first_iface_name]` followed by `first_iface.get("file", "")`.
   Inspect lines 303 & 320 of `seds-audit-harness/scripts/extract_firestore_schemas.py`: observe `all_interfaces: Dict[str, List[Dict[str, Any]]]`.
   Confirm that calling `harness_verify.py` reproduces the `AttributeError: 'list' object has no attribute 'get'`.
