Audit complete. Here is the full slice report.

---

# AUDIT SLICE 3/20 — Roles data layer trace: AI auto-assign pipeline

## (a) Every read path for the task form's user picker and the AI registry

**AI registry (the "Team Registry" the AI sees)** — built client-side in `generateWithAI`, then POSTed to `/api/ai-task-generator`:

1. `src/components/admin/tasks/task-form.tsx:350-357` — `roles` read: `useCollection(query(collection(firestore, "roles")))` → **real-time `onSnapshot` listener** (verified: `src/firebase/firestore/use-collection.ts:70` uses `onSnapshot`).
2. `src/components/admin/tasks/task-form.tsx:358-365` — `users` read: `useCollection(query(collection(firestore, "users")))` → real-time.
3. `src/components/admin/tasks/task-form.tsx:464-472` — roles map built **from the `roles` collection only**: `acc[uid] = String(r.role).toLowerCase()`.
4. `src/components/admin/tasks/task-form.tsx:474-483` — user pool: `role: rolesMap[uid] || (u?.role ? lower(u.role) : '')`, then `.filter(u => u.role && u.role !== 'member' && u.role !== 'none')`. **The `roles` collection wins over `users.role`; `displayRole` is never consulted.**
5. `src/components/admin/tasks/task-form.tsx:528` — the AI payload: `subordinates: usersChapter.map(u => ({ uid, name, role: u.role }))`.
6. `src/app/api/ai-task-generator/route.ts:60-100` — the server just embeds that client-supplied array verbatim into the Gemini prompt as "TEAM REGISTRY". **The AI has no independent role lookup; it sees exactly what the client sent.**
7. Role descriptions come from `getAllRoleDefinitionsCached` (`src/lib/role-definitions.ts:26-56`) — **module-level in-memory cache, 5-minute TTL**. Stale descriptions possible for 5 min; per-user roles are not cached here.

**User picker read paths** (same precedence — `roles` collection overlaid on `users` docs):

8. `src/components/admin/multi-select-user-combobox.tsx:234-246` — initial read from `users` collection docs' `role` field; then `273-296` — **one-time** `getDocs(collection(firestore, "roles"))` on mount, overlaid: `role: map[u.uid] ? map[u.uid] : (u.role || undefined)`. One-shot fetch, stale after mount until remount.
9. `src/components/admin/user-selection-combobox.tsx:76-90` — same pattern: `users` docs' `role`, then `123-150` one-time `roles` overlay.

**Other role readers (for the divergence analysis):**

10. `src/lib/role-management.ts:157-170` `getUserRole` — reads `roles/{uid}.role` only.
11. `src/lib/server/permissions.ts:58-72` `resolveUserRole` — reads **`users/{uid}.role`, falling back to `displayRole`**. Never reads the `roles` collection.
12. Custom-claims readers (server): `src/app/api/chapter-applications/route.ts:24,63,162`, `src/app/api/events/publish/route.ts:22`, `src/app/api/store/orders/route.ts:32,221,345`, `src/app/api/workflows/route.ts:458` — all read `decoded.role` from the ID token.
13. `src/hooks/use-role.ts:20` — module-level `roleCache = new Map()`; but lines 103-114 attach a real-time `onSnapshot` on the role doc that refreshes the cache, so it self-heals.

## (b) `role` vs `displayRole` divergence — and which one the AI sees

**The AI never sees `displayRole`.** Its registry role is `roles/{uid}.role` (with `users/{uid}.role` as fallback). `displayRole` appears nowhere in the AI path.

**The two fields CAN and DO disagree.** Write paths:

- `assignRole` (`src/lib/role-management.ts:44-72`): writes `roles/{uid}.role`, then tries to denormalize `users/{uid}.{role, displayRole}` — but the denormalization is wrapped in `.catch()` with the comment *"Non-fatal denormalization failure (Likely Rules)"*. **If Firestore rules reject the users-doc write, `roles.role` updates while `users.role`/`displayRole` silently stay stale.**
- `revokeRole` (`src/lib/role-management.ts:104-145`): writes `roles/{uid}.role = 'member'` **and never touches `users.role` or `users.displayRole` at all**. Guaranteed divergence on every revoke.
- Cloud Function `onRoleWritten` (`functions/src/index.ts:260-300`, trigger on `roles/{userId}`): on every roles write it syncs `users/{uid}.displayRole = newRole` and sets custom claims — **but it does NOT update `users/{uid}.role`**. Same in the API-route twin `handleRoleWritten` (`src/app/api/webhooks/firestore/route.ts:247-265`).

Resulting steady-state after any demotion: `roles.role` = new, `users.displayRole` = new (if the CF is deployed and fires), **`users.role` = old value, permanently** — nothing in the codebase ever writes it back except `assignRole`'s best-effort denormalization. Consequences:
- AI registry: correct (reads `roles`).
- Server permission checks (`resolveUserRole`): **wrong — still sees the old role**, because it reads `users.role` first. A demoted admin keeps passing server-side role gates until something rewrites `users.role`.
- Custom claims: updated by the CF, but **only take effect on the next ID-token refresh** (up to ~1h of staleness for `decoded.role` readers).

## (c) Custom-claim staleness

`onRoleWritten` calls `auth.setCustomUserClaims(userId, {role, chapter_id})` on every roles write. Firebase custom claims propagate to ID tokens only on token refresh (hourly, or on `getIdToken(true)`). Every `decoded.role` reader listed in (a-12) can therefore enforce the OLD role for up to an hour after a demotion. No code in the repo forces a token refresh on role change.

## The exact mechanism: how a demoted user keeps their OLD role in front of the AI

The AI's role for a user comes **exclusively** from `roles/{uid}.role` via a real-time listener (`task-form.tsx:464-483,528`). There is **no reverse sync** anywhere: `onRoleWritten` syncs roles→users.displayRole, but nothing ever syncs users→roles. Therefore a demoted user appears with their old role to the AI **if and only if the demotion did not update the `roles/{uid}` document**. Concretely:

1. **Demotion done by editing `users/{uid}` directly in the Firebase console** (the exact pattern used earlier in this session for the induction-form config edit): setting `role`/`displayRole` to `member` there leaves `roles/{uid}.role` = old value forever, fires no trigger, and the AI — which reads `roles` first — perpetually sees the old role. **This is the highest-probability explanation for the observed behavior** (AI repeatedly suggesting Eman Shah as General Secretary after a demotion was ordered).
2. **Timing**: "Generate Suggestions" clicked before the `roles/{uid}` write landed/propagated. The AI payload is snapshotted at click time.
3. **A demotion code path that writes only the user doc** (none exists in the current UI — both `assignRole` and `revokeRole` write `roles` — so this would have to be a console edit or an external script).

Secondary finding for the parent: even when the demotion IS correctly written to `roles/{uid}`, `users/{uid}.role` stays stale (CF doesn't sync it, `revokeRole` doesn't write it), so **server-side permission checks via `resolveUserRole` continue to honor the old role** — a privilege-persistence bug adjacent to this slice. The complete fix is a single-writer rule (all role mutations go through `roles/{uid}`) plus extending `onRoleWritten` to also sync `users.role`, and forcing token refresh on role change.

No code was modified in this audit.