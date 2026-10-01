# Task Dispatch: Challenger M3 (Zip Integrity & Verification Suite Challenger)

## Identity
- Role: Adversarial Verification Challenger
- Working Directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m3_1
- Parent: Project Orchestrator (eb50595a-b458-4e87-a8e8-2126d0c6a4ec)

## Objective
Adversarially challenge Milestone 3:
1. Run `python seds-audit-harness/scripts/harness_verify.py` and confirm exit code 0.
2. Run `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output` and confirm exit code 0.
3. Test `seds_audit_results.zip` for corruption using `zipfile.ZipFile.testzip()`. Verify checksum in `checksum.sha256` matches the archive.
4. Report verdict: APPROVE or REJECT.

## Deliverable
Write your report to:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m3_1\handoff.md`

## 2026-09-26T09:21:54Z
You are challenger_m3_1, a teamwork_preview_challenger.
Your working directory is: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m3_1

MANDATORY FIRST STEPS:
1. Read ORIGINAL_REQUEST.md at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md
2. Read your task dispatch at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m3_1\DISPATCH.md
3. Read the worker handoff at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\worker_m3_1\handoff.md

TASK INSTRUCTIONS:
1. Run `python seds-audit-harness/scripts/harness_verify.py` and confirm exit code 0.
2. Run `python seds-audit-harness/scripts/verify_bundle.py --output-dir ./audit_output` and confirm exit code 0.
3. Test `seds_audit_results.zip` for corruption using `zipfile.ZipFile.testzip()`. Verify that the calculated SHA-256 hash matches `checksum.sha256`.
4. Write your verification report to:
   `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\challenger_m3_1\handoff.md`
   Clearly stating your verdict: APPROVE or REJECT.
When done, send a message back to your caller agent (parent).

