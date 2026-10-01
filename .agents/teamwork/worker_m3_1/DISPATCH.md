# Task Dispatch: Worker M3 (Quality Gates, Packaging & Integrity Attestation)

## Identity
- Role: Packaging & Verification Specialist
- Working Directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m3_1
- Parent: Project Orchestrator (eb50595a-b458-4e87-a8e8-2126d0c6a4ec)

## Objective
Execute Milestone 3: Quality Gates, Packaging & Integrity Attestation.
1. Run and verify Quality Gates:
   - `python seds-audit-harness/scripts/harness_verify.py` (must exit with code 0).
   - `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output` (must exit with code 0).
   - Validate `./audit_output/GROUND_TRUTH_SCHEMA.json` against `seds-audit-harness/schemas/ground_truth.schema.json` using `jsonschema`.
2. Package all deliverables in `./audit_output/`:
   - Compress all files in `./audit_output/` into `seds_audit_results.zip` located at the root of the workspace (`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\seds_audit_results.zip`).
   - Use PowerShell `Compress-Archive -Path .\audit_output\* -DestinationPath "seds_audit_results.zip" -Force` or a python script using `zipfile`.
   - Compute the SHA-256 checksum of `seds_audit_results.zip` and write it to `checksum.sha256` at workspace root.
   - Verify the zip archive contents and ensure all 16 deliverables are present.
3. Verify Non-Destructive Integrity:
   - Verify that ZERO tracked source files in `src/`, `functions/`, `public/`, `firestore.rules`, `storage.rules`, or `package.json` were altered.
   - Verify that NO secrets or private keys were leaked in the output deliverables.

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Deliverable
Write your full completion report to:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m3_1\handoff.md`
Include verification command outputs, zip archive file size and entry count, SHA-256 hash, and source code immutability confirmation.

## 2026-09-26T07:05:47Z
You are worker_m3_1, a teamwork_preview_worker.
Your working directory is: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m3_1

MANDATORY FIRST STEPS:
1. Read ORIGINAL_REQUEST.md at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md
2. Read your task dispatch at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m3_1\DISPATCH.md
3. Read worker_m2_1 handoff report at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m2_1\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

EXCLUSIVE FILE OWNERSHIP:
- You own: `seds_audit_results.zip` (at workspace root)
- You own: `checksum.sha256` (at workspace root)
- STRICTLY FORBIDDEN: Modifying ANY repository source files (`src/`, `functions/`, `public/`, `firestore.rules`, `storage.rules`, `package.json`, etc.). Zero tracked files modified.

TASK INSTRUCTIONS:
1. Run Quality Gate 1:
   `python seds-audit-harness/scripts/harness_verify.py`
   Ensure exit code is 0.
2. Run Quality Gate 2:
   `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output`
   Ensure exit code is 0.
3. Validate schema:
   Run a Python verification one-liner using `jsonschema` to validate `./audit_output/GROUND_TRUTH_SCHEMA.json` against `seds-audit-harness/schemas/ground_truth.schema.json`.
4. Package deliverables:
   - Create `seds_audit_results.zip` containing all files and directories in `./audit_output/`. Ensure the zip file is placed at `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\seds_audit_results.zip`.
   - Calculate the SHA-256 checksum of `seds_audit_results.zip` and write it to `checksum.sha256` at `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\checksum.sha256`.
   - Verify that the zip archive is valid and can be read.
5. Check repository source immutability:
   Confirm zero tracked source files have been modified.
6. Write your complete handoff report to:
   `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m3_1\handoff.md`

When done, send a message back to your caller agent (parent).
