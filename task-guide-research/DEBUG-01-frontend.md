# DEBUG-01: Unchecked fetch in task submit paths (frontend)

## Scope
`src/components/profile/assigned-tasks.tsx` (856 lines) plus related profile components.
Systematic debugging Phase 1 (root cause) and Phase 2 (pattern analysis).
Investigation only — no fixes applied.

## Phase 1: Root cause — every fetch/submit path in assigned-tasks.tsx

### 1. `handleQuickAction` (line 266) — BROKEN
The one-click transmit button ("TRANSMIT SUCCESS").

```ts
await fetch('/api/tasks', {
  method: 'PATCH',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ taskId: task.id, updates: { status: 'submitted-for-review', report: 'Objective reached. Direct Transmit.' } })
});
setIsSuccess(true);
toast.success("Mission Success Transmitted!");
confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
// ...
} catch (err) { setIsUpdating(false); }
```

| Case | Behavior |
|---|---|
| HTTP 200 | Success UI (correct) |
| HTTP 4xx/5xx (401, 403, 500) | **Success UI anyway** — `setIsSuccess(true)`, toast, confetti. The `fetch` promise resolves on HTTP errors; the result is discarded (`await fetch(...)` with no `res` variable), so nothing ever checks the status. |
| Network failure (offline, DNS, timeout) | `catch` runs `setIsUpdating(false)` only — **no error shown at all**. The button just stops spinning. User has zero feedback. |

This is the exact bug: a failed submission is indistinguishable from a successful one.

### 2. `handleRecall` (line 284) — CORRECT
```ts
const res = await fetch('/api/tasks', { method: 'PATCH', ... });
if (!res.ok) throw new Error();
setIsSuccess(true);
toast.success("Submission recalled — back to Active.");
// ...
} catch (err) { toast.error("Fail."); setIsUpdating(false); }
```
Checks `res.ok`, throws on HTTP error, shows `toast.error("Fail.")` in catch. Confirmed working.

### 3. `handleFullUpdate` (line 305) — CORRECT
```ts
const res = await fetch('/api/tasks', { method: 'PATCH', ... });
if (!res.ok) throw new Error();
setIsSuccess(true);
toast.success("Operational Log Saved.");
// ...
} catch (err) { toast.error("Fail."); setIsUpdating(false); }
```
Same correct pattern as `handleRecall`. Confirmed working.

### 4. `fetchContext` (line 217) — CORRECT (read path, not a submit)
```ts
const res = await fetch(`/api/workflows?workflowId=...`, ...);
const data = await res.json();
if (res.ok && data.ok) { setSteps(...); ... }
// catch: console.warn only
```
Guards state updates behind `res.ok && data.ok`. Fine for a read path.

### 5. `fetchWorkflowTasks` (679), `fetchUserNames` (768) — N/A
Firestore SDK calls (`getDocs`, `getDoc`), not `fetch`. Errors caught. Fine.

## Phase 2: Pattern analysis

The broken path vs the working paths, side by side:

| | `handleQuickAction` (broken) | `handleRecall` / `handleFullUpdate` (working) |
|---|---|---|
| Captures response | No — `await fetch(...)` discarded | Yes — `const res = await fetch(...)` |
| Checks `res.ok` | No | Yes — `if (!res.ok) throw new Error();` |
| HTTP error UX | Success toast + confetti (wrong) | `toast.error("Fail.")` (right) |
| Network error UX | Silent reset, no feedback | `toast.error("Fail.")` |

The defect is isolated to ONE function. It is not a file-wide habit: the two sibling mutation functions in the same file, written in the same style, both do it correctly. Likely cause is a single oversight (probably an early draft of the quick-action that never got the guard added when the pattern was established elsewhere), not a systemic misunderstanding.

## Other profile components — same unchecked-fetch pattern?

Checked every `await fetch(` in `src/components/profile/`:

| Location | Type | Checks `res.ok`? | Verdict |
|---|---|---|---|
| `assigned-tasks.tsx:272` (`handleQuickAction`) | PATCH (submit) | **No** | **BROKEN — the bug** |
| `assigned-tasks.tsx:290` (`handleRecall`) | PATCH | Yes | OK |
| `assigned-tasks.tsx:311` (`handleFullUpdate`) | PATCH | Yes | OK |
| `assigned-tasks.tsx:225` (`fetchContext`) | GET | Yes (`res.ok && data.ok`) | OK |
| `mission-card.tsx:88` | PATCH (inline update) | Yes (`!res.ok \|\| !data.ok` → throw) | OK |
| `team-tasks.tsx:181` | POST (create task) | Yes (parses error body) | OK |
| `team-tasks.tsx:280` (`handleStatusChange`) | PATCH | Yes | OK |
| `task-detail-dialog.tsx:189` | GET (validation info) | Yes (`!res.ok` → return) | OK |

`handleQuickAction` is the ONLY unchecked mutation fetch across all profile components checked. No other instance of this bug pattern was found.

## Recommended fix (for the implementing agent)
Mirror the sibling pattern exactly:
```ts
const res = await fetch('/api/tasks', { ... });
if (!res.ok) throw new Error();
```
and change the catch to `catch (err) { toast.error("Fail."); setIsUpdating(false); }`.
Optionally surface the server's error message: `const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || 'Submit failed');` then `toast.error(err.message)`.
