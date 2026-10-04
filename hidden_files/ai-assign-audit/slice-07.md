## Slice 07/20 DONE — Generate Suggestions flow, exact clobber mechanism

- Handler generateWithAI at task-form.tsx:441. POST body (513-532): prompt, totalPoints, chapterId, apiKey, model, subordinates (chapter-scoped, member/none filtered), roleDefinitions.
- Candidate pool rebuilt from LIVE Firestore at click time (roles sub line 357, users sub line 365); rolesMap uid->role.toLowerCase() (464-473); only exclusion is member/none (483).
- roleDefinitions via getAllRoleDefinitionsCached (446). Dead code: availableRoles (449-458) never referenced elsewhere.
- Clobber mechanism (596-606), no dirty checks:
  (a) title: parsed.missionTitle always truthy -> always overwrites user correction.
  (b) deadline: route.ts contains ZERO occurrences of "deadline" — API never returns one, so fallback now+7d ALWAYS fires; v.deadline can never survive. Observed 2026-10-11T07:52 = click time + 7d exactly.
  (c) assignees: non-empty AI list wholesale replaces manual edits (wiped the Eman Shah removal).
  (d) workflow steps: full replacement with fresh ids — destroys per-step manual edits.
- Stale Eman Shah root cause: pool is live at click time; anyone still carrying a leadership role string passes the filter. Demotions fix this at the source.
- Secondary: AI treats President/VP as external stakeholders to "collaborate with", never as assignees, regardless of brain-dump phrasing.
- Fix directions: fill-if-empty/dirty guards; return real deadline from API or stop overwriting; remove dead availableRoles.
