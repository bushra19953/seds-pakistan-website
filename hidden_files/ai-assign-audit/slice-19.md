## Slice 19/20 DONE — Firestore rules / persistence angle

- roles collection: allow get,list if isSignedIn() — ANY authenticated user can enumerate full UID->role mapping. Writes restricted (superadmin/canManageRoles, guards on superadmin/president_national targets). Read-caching: none server-side per request.
- Client persistence: DISABLED. persistentLocalCache imports in firebase/core.ts:5 are dead; getFirestore plain; no initializeFirestore anywhere; no fromCache reads. In-memory cache only.
- This slice traced page.tsx:157,160 (board-level onSnapshot) — but the FORM builds its registry from its own useCollection calls (task-form 349-365) with listen:false default = one-time getDocs per mount (slices 1,7,15). Discrepancy noted; weight of evidence supports mount-once snapshot for the AI registry path.
- Verdict: observed wrong picks are NOT a cache bug — registry reflects server truth at generation time; demotion simply hadn't been saved yet. Fix = ordering (save demotions, then regenerate). Narrow residual: use-collection error-cooldown holds last-known data after transient errors.
