# Task Dispatch: Worker M1 (Automated Pipeline Execution & Tooling Hardening)

## Identity
- Role: Implementation & Execution Worker
- Working Directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m1_1
- Parent: Project Orchestrator (eb50595a-b458-4e87-a8e8-2126d0c6a4ec)

## Objective
Execute Milestone 1:
1. Patch the bug in `seds-audit-harness/scripts/generate_brag_report.py` at line 395 and line 434 discovered during survey. Guard `first_iface` so that if it is a list, extract the first dict item or verify `isinstance(first_iface, dict)` to prevent `AttributeError: 'list' object has no attribute 'get'`.
2. Run the automated 7-pass inspection pipeline:
   `python seds-audit-harness/scripts/audit_runner.py --repo-path . --output-dir ./audit_output --verbose`
3. Verify that all 16 intermediate AST dumps, route scans, and schema inventory files are created in `./audit_output/` along with `lobe_checkpoints/` and `audit_execution_summary.json`.
4. Check `git status` to ensure ZERO tracked repository source files (`src/`, `functions/`, `public/`, etc.) have been modified.

## Exclusive File Ownership
- Allowed to edit: `seds-audit-harness/scripts/generate_brag_report.py` (tooling fix only)
- Allowed to write: `./audit_output/*`
- STRICTLY FORBIDDEN: Modifying any tracked source files in `src/`, `functions/`, `firestore.rules`, `storage.rules`, etc.

## Inputs to Read First
- `ORIGINAL_REQUEST.md`: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md`
- `PROJECT.md`: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\teamwork_preview_orchestrator_1\PROJECT.md`
- Survey Spec Miner Report: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\spec_miner_harness_1\handoff.md`

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Deliverable
Write your full completion report to:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m1_1\handoff.md`
Including exact command outputs, file lists with sizes in `./audit_output/`, and `git status`.

## 2026-09-26T06:30:23Z
You are worker_m1_1, a teamwork_preview_worker.
Your working directory is: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m1_1

MANDATORY FIRST STEPS:
1. Read ORIGINAL_REQUEST.md at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md
2. Read your task dispatch at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m1_1\DISPATCH.md
3. Read the survey report at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\spec_miner_harness_1\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

EXCLUSIVE FILE OWNERSHIP:
- You own: `seds-audit-harness/scripts/generate_brag_report.py` (patching the type mismatch bug at line 395 and line 434)
- You own: `./audit_output/*` (generated audit artifacts)
- STRICTLY FORBIDDEN: Modifying ANY repository source files (`src/`, `functions/`, `public/`, `firestore.rules`, `storage.rules`, `package.json`, etc.). Zero tracked files modified.

TASK INSTRUCTIONS:
1. In `seds-audit-harness/scripts/generate_brag_report.py`, at lines 395 and 434, handle the case where `first_iface` is a list or not a dict. Specifically:
   In line 395 and 434, `iface_file = first_iface.get("file", "") if isinstance(first_iface, dict) else (first_iface[0].get("file", "") if isinstance(first_iface, list) and len(first_iface) > 0 and isinstance(first_iface[0], dict) else "")`.
   Ensure no syntax errors and stop-slop prose rules are strictly respected (no em dashes, no disallowed -ly words).
2. Execute the automated audit pipeline:
   `python seds-audit-harness/scripts/audit_runner.py --repo-path . --output-dir ./audit_output --verbose`
3. Verify that `./audit_output/` contains all expected outputs:
   - `component_tree.json`
   - `dependency_graph.json`
   - `nextjs_routes_inventory.json`
   - `routes_manifest.json`
   - `firestore_schema_inventory.json`
   - `firestore_schemas.json`
   - `rbac_auth_inventory.json`
   - `rbac_audit.json`
   - `storage_schemas.json`
   - `hardware_pipeline_inventory.json`
   - `external_services.json`
   - `external_services_inventory.json`
   - `CAPABILITIES_BRAG_REPORT.md`
   - `GROUND_TRUTH_SCHEMA.json`
   - `SEDS_BRAIN_INGESTION_BUNDLE.md`
   - `audit_execution_summary.json`
   - `lobe_checkpoints/`
4. Run `git status` and verify that zero tracked repository source files are modified.
5. Write your complete handoff report to:
   `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m1_1\handoff.md`

When done, send a message back to your caller agent (parent) informing them of completion and referencing your handoff report.
