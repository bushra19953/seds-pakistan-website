# SEDS Audit Harness Acceptance Gates

Every gate defines an observable outcome verified by automated checks.

## Gates

### G1: Next.js Route Scanner Implementation
- Gate: `scan_nextjs_routes.py` parses Next.js App Router and Pages Router, detects dynamic routes, route handlers, server actions, middleware, client/server components, and outputs valid JSON.
- Status: PASSED
- CHECK: `python scripts/scan_nextjs_routes.py --help`
- EXPECT: `Next.js`

### G2: Firestore Schema Extractor Implementation
- Gate: `extract_firestore_schemas.py` extracts Firestore collections, operations, TypeScript interfaces, and security rules into valid JSON.
- Status: PASSED
- CHECK: `python scripts/extract_firestore_schemas.py --help`
- EXPECT: `Firestore`

### G3: RBAC Auth Auditor Implementation
- Gate: `audit_rbac_auth.py` audits Firebase Auth methods, custom claims, and role checks across routes and actions into valid JSON.
- Status: PASSED
- CHECK: `python scripts/audit_rbac_auth.py --help`
- EXPECT: `RBAC`

### G4: BRAG Report Generator Implementation
- Gate: `generate_brag_report.py` consumes inventories and generates `CAPABILITIES_BRAG_REPORT.md`, `GROUND_TRUTH_SCHEMA.json`, and `SEDS_BRAIN_INGESTION_BUNDLE.md`.
- Status: PASSED
- CHECK: `python scripts/generate_brag_report.py --help`
- EXPECT: `BRAG`

### G5: Component AST and Dependency Graph Analyzer Implementation
- Gate: `analyze_components_ast.py` scans JSX trees, form inputs, CAD dropzones, child component hierarchies, dead unreferenced components, and generates `component_tree.json` and `dependency_graph.json`.
- Status: PASSED
- CHECK: `python scripts/analyze_components_ast.py --help`
- EXPECT: `Analyze React and Next.js component ASTs`

### G6: Master Audit Pipeline Runner Implementation
- Gate: `audit_runner.py` executes all audit passes end-to-end with terminal telemetry, generates structured deliverables, and exits with code 0.
- Status: PASSED
- CHECK: `python scripts/audit_runner.py --help`
- EXPECT: `Master single-command audit runner`

### G7: Operational Manual Delivery
- Gate: `HARNESS_INSTRUCTIONS.md` provides complete documentation on prerequisites, single-command invocation, AI agent execution, pass breakdowns, schemas, and troubleshooting.
- Status: PASSED
- CHECK: `python -c "from pathlib import Path; p = Path('HARNESS_INSTRUCTIONS.md'); assert p.is_file() and p.stat().st_size > 1000; print('HARNESS_INSTRUCTIONS.md verified')"`
- EXPECT: `HARNESS_INSTRUCTIONS.md verified`

### G8: Harness Acceptance Verification Suite
- Gate: `harness_verify.py` compiles scripts, executes passes against a Next.js test fixture, validates output schemas, audits stop-slop rules, and exits with code 0.
- Status: PASSED
- CHECK: `python scripts/harness_verify.py`
- EXPECT: `ALL HARNESS VERIFICATION GATES PASSED`
