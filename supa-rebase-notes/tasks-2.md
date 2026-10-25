# Supa rebase notes — tasks cluster, group 2 (secondary task routes)

Branch: feat/supa-tasks-2, base 4d5a1e16 (feat/integration-wave3).
Surface string: 'tasks'. Seam: src/lib/supa/seam-tasks-lists.ts (ONE seam for this group).
Adapter: NOT in this base; seam lazy-loads '@/lib/supa' via a variable specifier
typed to a locally declared interface. MERGE-TIME RE-POINT: when the adapter branch
lands, the dynamic import in seam-tasks-lists.ts resolves to the real
src/lib/supa/index.ts (getSupaAdapter + useSupa) with no code change; verify the
exported names (getSupaAdapter, useSupa) and ListOptions/WhereClause shapes match
adapter.ts in wt-supa-adapter (getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc
over fs_<collection> jsonb tables, Firestore-shaped {id, ...data}).

## Sections (filled per file as each lands)
- [ ] team/route.ts
- [ ] review-queue/route.ts
- [ ] approval-rate/route.ts
- [ ] [id]/activity/route.ts
- [ ] [id]/validation/route.ts
- [ ] Status-literal inventory
- [ ] Timestamp consumer inventory (.toDate()/Timestamp, file:line)
- [ ] Collision protocol vs fix/tasks-status-semantics + fix/tasks-profile-board
