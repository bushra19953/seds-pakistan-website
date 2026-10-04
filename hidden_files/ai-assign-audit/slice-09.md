## Slice 09/20 DONE — other callers

- Only one other caller: delegate-task-dialog.tsx:192. Its registry is fetched FRESH on every dialog open (GET /api/admin/hierarchy/workload, force-dynamic, live Firestore BFS) — no staleness vector. BUT it builds role from user doc embedded field (displayRole || role || 'member') while task-form uses the roles COLLECTION (rolesMap 463-473, fallback to user doc role). Contradictory registries for the same person if sources disagree — the Eman Shah mechanism.
- delegate-task-dialog maps assigneeUid to name with "Unknown" fallback (~207-210) and POSTs unchecked to /api/tasks/delegate. Nothing blocks launch on bad uid.
- task-form: users+roles via useCollection live subscriptions (349-365), chapter-scoped, member/none filtered. roleDefinitions via getAllRoleDefinitionsCached — module-level 5-min TTL, only invalidated by upsertRoleDefinition. Minor staleness.
- Both callers share: zero UID validation on AI picks.
- Follow-ups: server-side validate assigneeUid in submitted registry; unify role source of truth; consider server-built registry.
