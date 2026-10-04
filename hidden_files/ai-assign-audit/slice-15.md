## Slice 15/20 DONE — stale registry fix design (server-built registry)

Hypothesis VERIFIED with exact mechanism:
1. roles/users mount-once snapshots via useCollection (listen:false default); hook early-returns when memoized query unchanged and data exists — no refetch while dialog open. Demotion in another tab invisible to Generate Suggestions.
2. getAllRoleDefinitionsCached 5-min TTL module cache.
3. Trust hole: server accepts subordinates/roleDefinitions from body, zero validation.

Fix: server builds registry via firebase-admin per request.
- route.ts: add buildTeamRegistry(chapterId?) — getDb().collection('roles').get() -> uid->role lowercased; users.get() -> resolve role from roles map (fallback user.role), keep {uid,name,role}, drop empty/member/none; roleDefinitions.get() -> {role,description}; chapter filter server-side from client-sent chapterId.
- POST: after authenticate(), buildTeamRegistry() and pass to orchestrateMission() INSTEAD of body arrays; ignore client arrays; fail closed 500 if registry can't build.
- Response shape unchanged. Cheap hardening: require canManageTasks using roles data already fetched (route currently lets ANY signed-in user burn server Gemini key).
- task-form.tsx: stop sending subordinates/roleDefinitions; delete dead registry code (rolesMap, userPool, usersChapter), the two useCollection queries (verified unused elsewhere; comboboxes fetch separately), getAllRoleDefinitionsCached call + dead availableRoles.
- New flow: click -> POST {prompt,totalPoints,chapterId,apiKey,model} + Bearer -> server verifies -> fresh Admin reads -> registry -> Gemini. Demotion visible on next click.
- Cost: 3 small reads per generation. No new deps, no schema changes.
