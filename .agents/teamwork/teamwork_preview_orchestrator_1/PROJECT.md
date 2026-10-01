# Project: SEDS Pakistan Website Non-Destructive Forensic Audit

## Architecture
- Codebase: Next.js 15 (App Router), React 18, TypeScript 5, Tailwind CSS, Radix UI primitives.
- Backend/Data: Firebase Client & Admin SDK, Cloud Functions v2, Firestore, Firebase Storage.
- Toolchain: `seds-audit-harness/` Python inspection pipeline (Passes 1-7, harness verification, bundle verification, JSON schemas).
- Output Directory: `./audit_output/` (strictly non-destructive, zero tracked repo modifications).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Tooling Fix (`generate_brag_report.py`) | Guard `first_iface` type check at lines 395/434 so `harness_verify.py` exits 0 | M1 | Survey (spec miner) |
| 2 | Automated Pipeline Execution (`audit_runner.py`) | Execute 7-pass inspection pipeline writing 16 output files and checkpoints strictly to `./audit_output/` | M1 | Survey (spec miner) |
| 3 | AST & Route Manifest Verification | Confirm `component_tree.json`, `dependency_graph.json`, `nextjs_routes_inventory.json`, `routes_manifest.json` | M1 | Survey (spec miner/codebase) |
| 4 | Deep-Dive 5-Dimension Technical Audit | Synthesize findings on Auth/RBAC, Firestore, Storage, External Services, and Form Fidelity | M2 | Survey (codebase & backend) |
| 5 | Master Schema Ground Truth (`GROUND_TRUTH_SCHEMA.json`) | Validated JSON schema covering 209 routes, 34 primary collections, endpoints, roles, and interfaces | M2 | Survey (spec miner/backend) |
| 6 | Capabilities BRAG Report (`CAPABILITIES_BRAG_REPORT.md`) | Honest rubric scoring across 5 lobes, 44 forms tiered (39 T1, 3 T2, 2 T3), zero placeholders, stop-slop prose compliant | M2 | Survey (spec miner/codebase) |
| 7 | Second Brain Ingestion Bundle (`SEDS_BRAIN_INGESTION_BUNDLE.md`) | L0-L3 memory pyramid, L1 12-column ledger, L2 scenarios, L3 strategic arbitrage, Mermaid sourcing canvas | M2 | Survey (spec miner/backend) |
| 8 | Quality Gate 1 (`harness_verify.py`) | Validate Python syntax, mock repo execution, and stop-slop compliance (exit code 0) | M3 | Survey (spec miner) |
| 9 | Quality Gate 2 (`verify_bundle.py`) | Validate deliverable presence, byte thresholds, required keys and tokens (exit code 0) | M3 | Survey (spec miner) |
| 10 | Schema Gate (`ground_truth.schema.json`) | Validate `GROUND_TRUTH_SCHEMA.json` against Draft-07 schema | M3 | Survey (spec miner) |
| 11 | Deliverable Packaging (`seds_audit_results.zip`) | Compress `./audit_output/*` into zip with SHA-256 checksum | M3 | Survey (spec miner) |
| 12 | Non-Destructive Integrity & Zero Leaks | Attest `git status` has zero tracked modifications and zero secrets leaked in deliverables | M3 | Survey (backend) |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Automated Audit Pipeline Execution & Tooling Hardening | Patch `generate_brag_report.py` type bug, execute `audit_runner.py`, verify all 16 intermediate outputs in `./audit_output/` | Survey | DONE |
| M2 | Forensic Deep-Dive & Deliverables Synthesis | Generate `CAPABILITIES_BRAG_REPORT.md`, `GROUND_TRUTH_SCHEMA.json`, and `SEDS_BRAIN_INGESTION_BUNDLE.md` with complete empirical ground truth | M1 | DONE |
| M3 | Quality Gates, Packaging & Integrity Attestation | Execute `harness_verify.py`, `verify_bundle.py`, validate schema, create `seds_audit_results.zip`, verify zero tracked diffs | M2 | DONE |

## Interface Contracts
### `audit_runner.py` ↔ `audit_output/`
- Target repo: `.`
- Output dir: `./audit_output`
- Output files: 16 JSON/Markdown files + `lobe_checkpoints/` + `audit_execution_summary.json`
- Integrity: Non-destructive, no modification to tracked codebase files.

### Deliverables ↔ Verification Gates
- `harness_verify.py`: Validates script syntax, mock execution, stop-slop prose rules.
- `verify_bundle.py`: Validates files in `--output-dir ./audit_output`, byte sizes, required tokens (`Tier 1`, `Tier 2`, `Tier 3`, `Data Persistence`, `Access Control`, `node_id`, `SEDS-WEB-PORTAL-L1`, `SEDS-INTAKE-CAD-L1`, `flowchart`, `subgraph`).
- `ground_truth.schema.json`: Validates 9 top-level keys (`metadata`, `routes`, `collections`, `endpoints`, `roles`, `typescript_interfaces`, `storage_schemas`, `external_services`, `dependency_graph`).

## Code Layout
- Repository source files: `src/`, `functions/`, `public/`, `firestore.rules`, `storage.rules`, `package.json` (READ-ONLY, NEVER MODIFIED).
- Audit Tooling: `seds-audit-harness/` (contains `scripts/` and `schemas/`).
- Audit Deliverables: `./audit_output/` (all generated intermediate and final audit artifacts).
- Delivery Archive: `seds_audit_results.zip` (at workspace root) and `checksum.sha256`.
