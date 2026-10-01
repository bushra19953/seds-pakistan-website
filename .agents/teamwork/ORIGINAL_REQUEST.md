# Original User Request

## 2026-09-26T06:06:12Z

Execute a comprehensive forensic, non-destructive audit of the SEDS Pakistan website codebase using the `seds-audit-harness/` toolchain, generating an exact capability inventory, schema ground truth, and second-brain ingestion bundle.

Working directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT
Integrity mode: benchmark

## Requirements

### R1. Non-Destructive Automated Audit Execution
Execute the automated 7-pass inspection pipeline using the local Python harness without modifying any repository source files, executing network calls to live databases, or calling external cloud functions:
```bash
python seds-audit-harness/scripts/audit_runner.py --repo-path . --output-dir ./audit_output --verbose
```
All intermediate AST dumps, route scans, and schemas must be written strictly to `./audit_output/`.

### R2. Manual Deep-Dive & Capability Tier Classification
Perform deep manual code inspection to supplement the AST/regex parsers across 5 critical dimensions:
1. **Authentication & RBAC**: Firebase auth mechanisms, session handling, custom claims, and route guards.
2. **Firestore Schema & Rules**: Real database collection usage vs mock state; analyze `firestore.rules` permissions.
3. **Storage & Hardware Pipelines**: CAD dropzones, storage buckets, file size limits, and `storage.rules`.
4. **External Services**: APIs, webhooks, Resend/SMTP mailer dispatchers, and environment variable references.
5. **Component & Form Fidelity**: Classify all form submissions into:
   - **Tier 1 (Production Ready)**: Real Firestore/API persistence.
   - **Tier 2 (Partial / Impaired)**: Hardcoded API returns or partially wired backends.
   - **Tier 3 (Mock / Stub)**: Buttons that only log to `console.log()` or update ephemeral local React state.

### R3. Quality Gates & Format Verification
Verify the audit deliverables using both harness validation scripts:
```bash
python seds-audit-harness/scripts/harness_verify.py
python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output
```
Both verification gates must pass with exit code 0.

### R4. Final Deliverable Packaging
Synthesize findings into the 3 mandatory deliverable artifacts in `./audit_output/`:
1. `CAPABILITIES_BRAG_REPORT.md` (Honest, evidence-backed capabilities with zero inflated tiers and zero placeholders).
2. `GROUND_TRUTH_SCHEMA.json` (Validated JSON schema covering every collection and model).
3. `SEDS_BRAIN_INGESTION_BUNDLE.md` (Structured L0-L3 memory pyramid: raw evidence → atomic facts → scenarios → strategic constraints).
Package all results into `seds_audit_results.zip`.

## Acceptance Criteria

### Verification & Schema Conformance
- [ ] `python seds-audit-harness/scripts/harness_verify.py` exits with code 0.
- [ ] `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output` exits with code 0.
- [ ] `./audit_output/GROUND_TRUTH_SCHEMA.json` validates against `seds-audit-harness/schemas/ground_truth.schema.json`.

### Deliverable Completeness & Integrity
- [ ] `./audit_output/CAPABILITIES_BRAG_REPORT.md` is complete with zero `[TBD]`, `TODO`, or placeholder values.
- [ ] `./audit_output/SEDS_BRAIN_INGESTION_BUNDLE.md` strictly adheres to L0-L3 pyramid specifications.
- [ ] Every form and route across the website is audited and assigned an objective tier score (Tier 1 / 2 / 3).
- [ ] Zero source code files in the repository have been altered (`git status` shows zero tracked modifications).
- [ ] Zero secrets, private keys, or API tokens are leaked in any output report.
- [ ] `seds_audit_results.zip` is created containing the complete audit output.
