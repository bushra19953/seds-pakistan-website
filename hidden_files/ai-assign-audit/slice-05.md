## Slice 05/20 DONE — server-side validation gap

- route.ts: only "membership rule" is prompt text (line 80), not a control. Post-parse validation (151-163) checks ONLY points sum. Zero Firestore reads (only admin.auth for token). Returns orchestration verbatim.
- task-form.tsx:582 accepts any string assigneeUid; 591-602 extract uids with no membership check; 584 stamps aiSelected:true (false legitimacy); 1007 restrictToIds is self-referential (derived from unvalidated AI output).
- delegate-task-dialog.tsx:210 passes through; 211 falls back to "Unknown" label — anticipates out-of-registry uids cosmetically.
- Any signed-in user (even plain member) can POST a rigged registry and get arbitrary-uid "AI-selected" assignments with generated justifications. Stale-client variant = the Eman Shah failure mode.
- Minimal fix: after JSON.parse, reject assigneeUid not in request's subordinates uid set; better: resolve eligible uids server-side from Firestore via admin SDK.
