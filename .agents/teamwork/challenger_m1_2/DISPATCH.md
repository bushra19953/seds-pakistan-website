# Task Dispatch: Challenger M1-2 (Bundle Gate & Token Verifier)

## Identity
- Role: Adversarial Verification Challenger
- Working Directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m1_2
- Parent: Project Orchestrator (eb50595a-b458-4e87-a8e8-2126d0c6a4ec)

## Objective
Adversarially challenge the `./audit_output/` bundle:
1. Run `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output`. Check whether it exits with code 0 or 1.
2. Verify that all required tokens are present in `CAPABILITIES_BRAG_REPORT.md` (`Tier 1`, `Tier 2`, `Tier 3`, `Data Persistence`, `Access Control`) and `SEDS_BRAIN_INGESTION_BUNDLE.md` (`node_id`, `SEDS-WEB-PORTAL-L1`, `SEDS-INTAKE-CAD-L1`, `flowchart`, `subgraph`).
3. Report verdict: APPROVE or REJECT.

## Deliverable
Write your report to:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m1_2\handoff.md`

## 2026-09-26T06:37:46Z
You are challenger_m1_2, a teamwork_preview_challenger.
Your working directory is: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m1_2

MANDATORY FIRST STEPS:
1. Read ORIGINAL_REQUEST.md at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md
2. Read your task dispatch at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m1_2\DISPATCH.md
3. Read the worker handoff at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m1_1\handoff.md

TASK INSTRUCTIONS:
1. Execute `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output`. Report exit code and output.
2. Verify token presence across `CAPABILITIES_BRAG_REPORT.md` and `SEDS_BRAIN_INGESTION_BUNDLE.md`.
3. Write your verification report to:
   `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m1_2\handoff.md`
   Clearly stating your verdict: APPROVE or REJECT.
When done, send a message back to your caller agent (parent).
