## AUDIT 10/20 — workload route: already correct (210eb29)
- Tally unions assigneeId + assigneeIds per doc, dedupes, counts +1 per person.
- tasks/route.ts:862-900 splits multi-assignee creates into one doc per assignee (singular assigneeId, no array on split docs).
- workflowParticipantIds intentionally not counted as workload.
- Minor: :151 non-string truthy assigneeId silently skipped. Latent: future split docs retaining array would double-count.
- NO FIX NEEDED for the core; note the data-model fact: create=SPLIT docs, edit=ARRAY on one doc.
