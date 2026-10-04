Audit complete. Here is the full report for slice 2/20.

## AUDIT SLICE 2/20 — `roleDefinitions` in the AI auto-assign pipeline

### Code path (exact)

**Client (admin task form):**
- `src/components/admin/tasks/task-form.tsx:446` — `const roleDefinitions = await getAllRoleDefinitionsCached(firestore);`
- `src/components/admin/tasks/task-form.tsx:529` — payload: `roleDefinitions: roleDefinitions.map(r => ({ role: r.role, description: r.description }))`, sent alongside `subordinates` in the POST to `/api/ai-task-generator`.

**Source:**
- `src/lib/role-definitions.ts:13` — `ROLE_DEFINITIONS_COLLECTION = 'roleDefinitions'` (Firestore collection).
- `src/lib/role-definitions.ts:35` — one-time `getDocs(collection(firestore, ...))`. **Not a realtime listener.**
- `src/lib/role-definitions.ts:22-33` — 5-minute in-memory TTL cache (`ttlMs = 5 * 60 * 1000`, min 10s).
- `src/lib/role-definitions.ts:42` — description read as `data?.description || data?.responsibilities || ''`.

**Second path (delegate dialog):** `src/components/profile/delegate-task-dialog.tsx:198-199` forwards `roleDefinitions` to the same API, sourced from `GET /api/admin/hierarchy/workload`, which does a server-side one-time `db.collection('roleDefinitions').get()` (`src/app/api/admin/hierarchy/workload/route.ts:113`) with no cache.

**Server consumption:** `src/app/api/ai-task-generator/route.ts` system instruction contains an explicit rule: *"MATCHING: Analyze the 'Role Definitions'. Match the step requirements to the 'current role' of users in the 'Team Registry'."* The definitions are injected verbatim as JSON into the user prompt.

### Freshness behavior

- `roleDefinitions` (the descriptions): one-time fetch + 5-min TTL. `upsertRoleDefinition` and `invalidateRoleDefinitionsCache` (`src/lib/role-definitions.ts:60-62, 65`) have **zero callers** in `src/` — the cache can only expire by TTL, never by explicit invalidation. External edits take up to 5 minutes to reach the AI payload.
- `users` / `roles` (the per-user role mapping in `subordinates`): realtime `onSnapshot` listeners (`task-form.tsx:350-365` via `useCollection`, confirmed `onSnapshot` at `src/firebase/firestore/use-collection.tsx:70`). Demotions reflect immediately, and demoted-to-`member` users are filtered out of the AI candidate pool entirely (`task-form.tsx` userPool filter excludes `role === 'member'`).
- Net effect: after today's demotions, the AI can no longer *select* Eman Shah / Dabeer / Syeda (they vanish from `subordinates` at once), but the *descriptions* of `general_secretary` / `projects_director` can persist in prompts for up to 5 minutes.

### Does it reflect current role definitions?

Structurally yes (same collection the roles admin writes to), but the **descriptions themselves are stale legacy data**: the admin role editor (`src/components/admin/roles/role-privileges-drawer.tsx:129`) writes `roleDefinitions/{slug}` with `{ merge: true }` but never writes a `description` field — only permissions/scope/allowedChapters. There is no seed file and no UI to edit descriptions. Whatever wording is in Firestore is invisible to code review and has no audit trail (consistent with the repo AGENTS.md lesson on admin-edited config docs).

### Coordinator bias — evidence

Could not read the raw Firestore descriptions from the sandbox (rules require sign-in: `roleDefinitions` allows `get` only if signed in). Bias evidence is therefore behavioral, and it is strong:

1. The AI is explicitly instructed to match steps to role *descriptions*, not just role names.
2. Observed output (from the live session): for Step 1 "Executive Verification & Digital Asset Preparation" the AI picked the General Secretary with rationale *"ideally suited for this critical coordination role, involving direct liaison with executive leadership… meticulous documentation management"* — a near-verbatim echo of a liaison/coordination/documentation-style description.
3. The brain dump explicitly named "President / Senior Academic Patron" as collaborators, yet the AI assigned neither `president_national`, `vice_president`, nor `chair_design` (the actual doers) — it mapped "verification/coordination" language onto the coordinator-role description and treated leadership as external stakeholders to liaise with.

**Conclusion:** Yes — the pipeline is structurally biased toward coordinator roles whenever a step contains verification/liaison language, because matching runs against free-text legacy descriptions the AI interprets literally, and those descriptions cannot currently be inspected or corrected through the app. Recommended follow-ups (for parent, not implemented): expose `description` editing in the role-privileges drawer, and/or add a prompt-level rule such as "prefer assignees whose role description contains execution/production verbs for build steps; do not assign pure coordination roles to production steps."