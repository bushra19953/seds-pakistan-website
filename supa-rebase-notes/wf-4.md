# Supa migration — Workflows+Missions cluster, Group 4 (wf-4)

Branch: `feat/supa-wf-4` off `feat/integration-wave3` @ `4d5a1e16`.
Scope: the `workflow_members` collection, and the workflow chat's
presence / typing / messages listeners
(`src/components/workflow/enhanced-workflow-chat.tsx` and the second
presence consumer `src/components/profile/workflow-visualizer.tsx`).

Adapter contract (landed on `feat/supa-adapter` @ 85e657f + f7defc3,
NOT merged/cherry-picked into this branch):

```ts
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
// gate: if (useSupa('workflows') && getSupaClient()) { getSupaAdapter()... }
// ops: getDoc / listDocs / countDocs / setDoc / updateDoc / deleteDoc
// getSupaClient() -> null when env unset (never throws); useSupa reads
// SUPA_SURFACES, case-insensitive, default OFF.
// SupaAdapterError / SupaUnavailableError -> fall back to Firestore.
```

All Supa access in this group goes through ONE seam module,
`src/lib/server/workflow-members-supa.ts`. Because the adapter is not in
this tree (and must not be merged in), the seam loads `@/lib/supa`
lazily through a variable-specifier dynamic import typed against a
local mirror of the adapter interface — the tasks-2 seam precedent —
so tsc and jest stay green pre-merge. At merge, once `src/lib/supa/`
lands, the loader resolves the real module and NO seam code change is
needed: the seam's gate is exactly
`useSupa('workflows') && getSupaClient()`, then `getSupaAdapter()`.

## Rules gap — workflow_members (recorded, NOT fixed here)

`firestore.rules` has NO `match /workflow_members/{id}` block
(verified by grep on the base tree: the only `workflow_members`
mention is the helper at firestore.rules:117-119,
`isWorkflowMember(wfId, uid)`, which itself is never called by any
other rule). Firestore rules are default-deny, so every CLIENT-SDK
read/write of `workflow_members` is denied for everyone. Contrast
firestore.rules:644-650: `workflow_presence` and `workflow_typing`
both have `allow read, write: if isSignedIn();`.

Consequence: the chat's client-direct auto-join
(enhanced-workflow-chat.tsx:130-135, below) fails at its `getDoc`,
is swallowed by its catch (console.warn only), and the `setDoc`
never runs — the feature is silently broken for everyone, exactly as
the founder access map found. firestore.rules is PINNED for this
group: do not fix it here. The fix (a match block) is a follow-up
for the rules owner. Server (Admin SDK) paths bypass rules and work.

## Inventory — workflow_members

Writers set docs at id `{workflowId}_{uid}` with
`{ workflowId, userId, joinedAt, role: 'owner' | 'member' }`.

| # | Site (file:line at base 4d5a1e16) | Kind | Disposition |
|---|---|---|---|
| M1 | `src/app/api/workflows/route.ts:321-331` POST: batch.set per participant (merge) | server WRITE | PINNED FILE — untouched. Stays Firestore. |
| M2 | `src/app/api/workflows/route.ts:577-579` GET: `doc(memberId).get()`, existence = `isWorkflowMember` gate for contact masking | server one-shot READ | PINNED FILE — cannot migrate in this group. Documented follow-up: a `getWorkflowMemberViaSupa(memberId)`-shaped read (adapter `getDoc('workflow_members', memberId)`) once the pin lifts at merge-plan step 17. Until then it stays Firestore; note it is an Admin-SDK read, so the rules gap does not affect it. |
| M3 | `src/app/api/tasks/route.ts:1819-1832` POST: memberBatch.set per participant (merge) | server WRITE | STAYS Firestore. File is owned by the tasks cluster; writes are not in this group's read-migration scope (a). |
| M4 | `src/app/api/tasks/delegate/route.ts:180-187` batch.set per participant inside the delegation batch | server WRITE | STAYS Firestore. Same batch commits the delegated tasks + orchestration update; splitting the member write out would break batch atomicity. File also claimed by tasks group 4 (their seam) — not touched here. |
| M5 | `src/app/api/workflows/[id]/duplicate/route.ts:90` `db.collection('workflow_members').get()` — FULL-collection scan, prefix-filtered in memory (`d.id.startsWith(id + '_')`, uid = `data.userId \|\| id suffix`) | server one-shot READ | **MIGRATED** behind the seam/`'workflows'` flag: `listDocs('workflow_members')` (unfiltered, mirroring the original full scan so malformed docs with a missing `workflowId`/`userId` field behave identically), same prefix filter + uid extraction. Any adapter error / flag OFF / client null -> the original Firestore `.get()` path, byte-identical result set. |
| M6 | `src/app/api/workflows/[id]/duplicate/route.ts:96-107` batch.set of copied member docs under the new workflow id | server WRITE | STAYS Firestore: same batch as the cloned tasks; atomicity preserved. (Mirror-on-write is a later program step, not this group.) |
| M7 | `src/lib/server/workflow-cascade.ts:21-24` `db.collection('workflow_members').get()` — FULL-collection scan, prefix-filtered, refs collected for cascade deletion (callers: `src/app/api/workflows/[id]/route.ts:66` DELETE, `src/app/api/workflows/bulk-delete/route.ts:81`) | server one-shot READ | **MIGRATED** behind the seam/`'workflows'` flag: `listDocs('workflow_members')`, same prefix filter; member refs are then constructed with `db.collection('workflow_members').doc(id)` (constructing a ref is not a read). Returned `{ taskRefs, memberRefs }` shape, counts, and the Firestore batch deletion in `deleteWorkflowCascade` are unchanged. Fallback on any error = the original `.get()` path. |
| M8 | `src/components/workflow/enhanced-workflow-chat.tsx:130-141` client SDK: `doc('workflow_members', memberId)` + `getDoc` (auto-join check), `setDoc` if missing | CLIENT-direct read + write, NO server path | DOCUMENTED FOLLOW-UP per scope (c): do not invent an endpoint. Also silently broken today by the rules gap above (the `getDoc` is denied, the catch swallows it, auto-join never lands). A future fix needs (1) a rules match block from the rules owner and/or (2) a server membership endpoint from the workflows-route owner (step 17). Not changed here. |
| M9 | `firestore.rules:117-119` `isWorkflowMember()` helper (`exists(.../workflow_members/...)`) | rules-internal | PINNED — untouched, and note the helper has no caller in the rules as shipped. |
| M10 | `src/lib/backup/registry.ts:52` `{ name: 'workflow_members', backupClass: 'full' }` | backup registry entry | STAYS. Registry is single-writer at merge-plan step 16 (conflict C-19); per-cluster registry edits are forbidden. No change needed for a read migration anyway. |

Test-only references (not production reads/writes, unchanged):
`src/app/api/tasks/__tests__/route.bug3-single-doc.test.ts:76-77,294`
(mock collection + expected member doc paths),
`src/app/api/workflows/__tests__/route-assignment-notifications.test.ts:52`
(mock collection for the pinned POST route).

## Inventory — presence / typing / messages (chat)

Disposition for ALL of this section: **STAY on Firestore, unchanged.**
The adapter in this wave is one-shot reads/writes over jsonb tables;
it has no realtime/listener equivalent, and these are ephemeral live
subscriptions with heartbeat writes. Presence/typing data is also
classified ephemeral in the backup registry
(`src/lib/backup/registry.ts:54-55`). No chat behavior is changed —
in particular the messages listener's missing `limit()` is OUT of
scope for this group (recorded at C1, not fixed).

| # | Site | Kind | Notes |
|---|---|---|---|
| C1 | `enhanced-workflow-chat.tsx:151-164` messages listener: `collection('messages')` where `workflowId ==`, `participantIds array-contains uid`, `orderBy createdAt asc`, **NO limit**; consumed via `useCollection(..., { listen: allowRealtime && isOpen })` | live listener READ | STAYS. Unbounded as shipped (census L10); bounding it is explicitly out of scope here. |
| C2 | `enhanced-workflow-chat.tsx:169-195` typing listener: `onSnapshot` on `workflow_typing` where `workflowId ==` (+ `userId in` first <=10 participants, L172/L178 slice(0,10)); keeps only `isTyping` docs fresher than 3s | live listener READ | STAYS. Ephemeral. |
| C3 | `enhanced-workflow-chat.tsx:236-273` presence heartbeat: `setDoc(workflow_presence/{wf}_{uid}, {..., isOnline: true, lastSeen: Timestamp.now()}, { merge: true })` immediately + `setInterval(..., 30000)` (L260); `beforeunload` writes `isOnline: false` (L262-266) | WRITE (30s heartbeat) | STAYS. Every heartbeat is one write per online participant. |
| C4 | `enhanced-workflow-chat.tsx:275-302` presence listener: `onSnapshot` on `workflow_presence` where `workflowId ==` (+ `userId in` first <=10 participants, L278/L283) | live listener READ | STAYS. Fan-out: with P participants each holding this listener, every 30s heartbeat round delivers up to P x P snapshot events (P-squared deliveries) — the cost is inherent to the Firestore-listener design and is unchanged by this group. |
| C5 | `enhanced-workflow-chat.tsx:304-331` typing write: `setDoc(workflow_typing/{wf}_{uid}, { isTyping: true, updatedAt }, { merge: true })` on keystroke (L316), timeout 3s later sets `isTyping: false` (L325) | WRITE | STAYS. Ephemeral. |
| C6 | `enhanced-workflow-chat.tsx:333-383` send message: client `addDoc(collection('messages'))`, fallback `POST /api/messages` (`src/app/api/messages/route.ts:58` server `add`) | WRITE | STAYS. Adjacent to this group (the `messages` collection belongs to the chat write path, not members/presence); recorded for completeness, not migrated. |
| C7 | `src/components/profile/workflow-visualizer.tsx:24-46` presence listener #2: `onSnapshot` on `workflow_presence` where `workflowId ==` (L29-32), NO participant cap, filters `isOnline` client-side | live listener READ | STAYS. Second presence consumer; same ephemeral disposition as C4. |
| C8 | `src/components/profile/workflow-visualizer.tsx:59-73` messages listener: where `workflowId ==`, `participantIds array-contains uid`, `orderBy createdAt desc`, `limit(10)` (L68) | live listener READ | STAYS. Note the contrast with C1: this consumer IS bounded (10), the chat's is not. |
| C9 | `firestore.rules:644-650` `workflow_presence` / `workflow_typing`: `allow read, write: if isSignedIn();` | rules | PINNED — untouched. These two collections DO have rules blocks (unlike `workflow_members`, M-gap above), which is why C2-C5/C7 work client-side while M8 does not. |

## What was actually migrated

- `src/lib/server/workflow-members-supa.ts` (new): the one seam.
  `listWorkflowMembersViaSupa()` -> `SupaDoc[] | null`
  (null = use Firestore), `extractWorkflowMemberUids(docs, workflowId)`
  (pure, replicates M5's prefix + uid logic),
  `__setWorkflowMembersSupaLoaderForTests()` test injection.
- M5 (duplicate route) and M7 (workflow-cascade): read path only.
  Writes, response shapes, counts, batch behavior: unchanged.
- Everything else above: documented disposition, zero code change.

## Gates

- New suites: `src/lib/server/__tests__/workflow-members-supa.test.ts`,
  `src/lib/server/__tests__/workflow-cascade-supa.test.ts`,
  `src/app/api/workflows/[id]/__tests__/duplicate-supa-members.test.ts`
  (all mocked; zero live Firestore/Supabase reads).
- Touched existing suites must stay green; tsc must show zero NEW
  errors vs the 151 baseline. Results recorded in the final report.
