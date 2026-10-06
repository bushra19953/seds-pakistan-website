# Backfill `submittedAt` — Write-Path Research (Worker 2a)

Investigation only. No code changed. Repo: `~/workspace/seds-pakistan-website`, branch `feat/remediation-harness-complete`.
Target: truthfully backfill `submittedAt` on the 3 Task 02 step task docs (currently all `submitted-for-review`, no `submittedAt` recorded — View Submission dialog falls back to `updatedAt` with the label "no submission timestamp recorded").

## 1. Exact `submittedAt` format used by the new code

**Writer:** `src/app/api/tasks/route.ts`, PATCH handler, line 487 (commit `6b24632` swarm work).

```ts
if (transitionedToSubmitted) {
  updatesToApply.submittedBy = decoded.uid;
  updatesToApply.submittedAt = admin.firestore.Timestamp.now();
  // A resubmission clears the previous decision stamps.
  updatesToApply.approvedBy = admin.firestore.FieldValue.delete();
  ...
}
```

- **Field name:** `submittedAt` (top-level field on the task document).
- **Format:** **Firestore Timestamp** (not ISO string, not millis, not `FieldValue.serverTimestamp()`).
- **Example value shape in Firestore:** `Timestamp { seconds: 176... , nanoseconds: ... }`. Over the API it arrives JSON-serialized as `{ seconds, nanoseconds }` (via `Timestamp.toJSON()`); the review-queue serializer (`review-queue/route.ts:120`, `toIso`) additionally emits it as an ISO string to its own clients.
- **When it's set:** server-side on every transition into `submitted-for-review`, placed *after* field-level auth so the server-added field never trips the assignee safe-field check.
- **Companion fields written in the same block:** `submittedBy = decoded.uid`; decision stamps (`approvedBy/approvedAt/rejectedBy/rejectedAt`) are deleted on resubmission.

**For the backfill, write a real Firestore Timestamp from the verified email-log time:**
```ts
admin.firestore.Timestamp.fromDate(new Date('<verified ISO>'))
```
(`Timestamp.fromDate` is already used in the codebase, e.g. `src/app/api/events/publish/route.ts:67`.) Writing the same type the new code writes keeps `orderBy('submittedAt')` in review-queue correct and matches every reader. The View Submission dialog's `toDate()` also accepts ISO strings/millis, but a plain string would be a *different* type than the code writes going forward — don't do that. Also backfill `submittedBy` (the doer's uid) in the same write, since the dialog renders "No submitter recorded" when it's missing.

## 2. How the codebase does Admin SDK writes

**Env / credentials (names only — no secret values read or printed):**
- Production (Vercel): `FIREBASE_SERVICE_ACCOUNT` — one JSON blob of the service-account, parsed by `src/lib/server/firebase-admin.ts` (Strategy 1, with tolerant parsing).
- Also consulted: `FIREBASE_PROJECT_ID` / `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (public IDs only).
- `.env.local` in this repo does **not** contain `FIREBASE_SERVICE_ACCOUNT` (0 matches) and has no `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`. Local dev can use a local `*-service-account.json` file (dev mode only) or falls through to ADC/other strategies. Conclusion: the write must run against **production Firestore via a deployed route** (Vercel has the credential); a local script can't authenticate as admin from this sandbox.

**Entry points:** `getDb()` / `ensureAdminInitialized()` from `@/lib/server/firebase-admin`.

**Candidate existing routes (auth patterns):**
- `src/app/api/admin/sync-user-role/route.ts` — **best pattern to copy**: `ensureAdminInitialized()` → `verifyAuthentication(request)` (from `@/lib/auth-middleware`; accepts Bearer Firebase ID token or `__session` cookie) → `hasServerPermission(callerRole, 'canManageTasks' | 'canManageRoles')` (from `@/lib/server/permissions`; `roles/{uid}.role` is the declared source of truth) → `db.collection(...).doc(...).set({...}, { merge: true })`. Uses `FieldValue.serverTimestamp()` for its own stamp.
- `src/app/api/admin/universal-review/route.ts` — same auth shape, writes with `admin.firestore.FieldValue.serverTimestamp()`.
- `src/app/api/admin/email-logs/route.ts`, `src/app/api/admin/role-permissions/route.ts` — same family of admin routes (list/read roles).

**Why the existing PATCH `api/tasks` route does NOT work for this:** its zod body schema (`TaskUpdateSchema`) is `.strict()` and `submittedAt` is **not** an allowed field → any body containing it gets a 400. And on the normal submit path the server stamps `Timestamp.now()`, which would be the *wrong (present) time* for a backfill — we need the verified historical times. So no existing route can do it; a dedicated endpoint is needed.

## 3. Recommendation: temporary admin-only endpoint, then delete it

**Method (a): a tiny temporary admin-only API endpoint** following the `sync-user-role` convention exactly, used once via curl, then **REMOVED** (Zubair's standing rule: no single-use machinery left in the product).

Suggested route: `src/app/api/admin/backfill-submitted-at/route.ts` (POST):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageTasks'))) {
    return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const items: Array<{ taskId: string; submittedAtIso: string; submittedBy?: string }> = body.items || [];
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const results = [];
  for (const it of items) {
    if (!it.taskId || !it.submittedAtIso) { results.push({ taskId: it.taskId, ok: false, error: 'taskId and submittedAtIso required' }); continue; }
    const ref = db.collection('tasks').doc(it.taskId);
    const snap = await ref.get();
    if (!snap.exists) { results.push({ taskId: it.taskId, ok: false, error: 'not found' }); continue; }
    const data = snap.data() || {};
    // Fail-closed: never clobber a real server-written stamp.
    if (data.submittedAt) { results.push({ taskId: it.taskId, ok: false, error: 'submittedAt already set' }); continue; }
    const d = new Date(it.submittedAtIso);
    if (isNaN(d.getTime())) { results.push({ taskId: it.taskId, ok: false, error: 'bad ISO' }); continue; }
    const update: Record<string, any> = { submittedAt: admin.firestore.Timestamp.fromDate(d) };
    if (it.submittedBy) update.submittedBy = it.submittedBy;
    await ref.update(update);
    results.push({ taskId: it.taskId, ok: true });
  }
  return NextResponse.json({ ok: true, results });
}
```

**Execution plan:**
1. Add the route on a branch, deploy to production (`vercel deploy --prebuilt --prod` — only Vercel has `FIREBASE_SERVICE_ACCOUNT`).
2. curl POST to `https://sedspakistan.live/api/admin/backfill-submitted-at` with a **manager's Bearer Firebase ID token** (any `canManageTasks` holder; verifyAuthentication also accepts the `__session` cookie). Token source must be an admin session arranged with Zubair — agents can't mint one.
3. Verify live: open `/admin/tasks`, View Submission on each of the 3 tasks → "Submitted at" shows the email-log time (not the "no submission timestamp recorded" fallback), and "Submitted by" shows the doer's name.
4. **Delete the route file, commit, redeploy** — nothing single-use remains in the product. Note it in the daily log.

**Method (b) rejected:** no existing route can write `submittedAt` (PATCH schema rejects it; normal path stamps `Timestamp.now()` = wrong time).

**Safety notes:**
- Fail-closed guard (`if (data.submittedAt) skip`) prevents clobbering real stamps if the endpoint is ever hit twice.
- Timestamps must come from the **verified email logs** (8:39–8:53 PM Oct 5 PKT window, per task-status notes), converted to UTC ISO (PKT = UTC+5, e.g. 20:39 PKT = 15:39Z).
- Writing a historical `submittedAt` changes only the display label/ordering; it does not alter review state (`submittedBy` is already set, no decision stamps touched). Do NOT touch `updatedAt`.

## 4. What the View Submission dialog reads (commit 6b24632)

File: `src/app/admin/tasks/page.tsx`, lines ~1518–1522.

```tsx
const submittedAt = toDate(t.submittedAt);          // toDate from @/lib/date-utils
const fallbackAt = toDate(t.updatedAt);
const timestampLabel = submittedAt ? 'Submitted at' : 'Updated at (no submission timestamp recorded)';
const timestamp = submittedAt || fallbackAt;
...
<p className="text-sm">{timestamp ? format(timestamp, 'dd/MM/yyyy hh:mm a') : 'Not recorded'}</p>
```

- **Reads:** `t.submittedAt`, with fallback to `t.updatedAt`.
- **`toDate()` (`src/lib/date-utils.ts:38`)** accepts: JS Date, Firebase-like Timestamp (has `.toDate`), plain `{seconds, nanoseconds}` object, or ISO string / millis number. So a real Firestore Timestamp doc value serializes over the API as `{seconds, nanoseconds}` and is picked up correctly. (Note: the GET `/api/tasks` serializer spreads `...data` and only explicitly serializes deadline/createdAt/updatedAt etc. — `submittedAt` passes through raw, which is exactly the `{seconds, nanoseconds}` shape `toDate` handles.)
- **Labels:** "Submitted at" when `submittedAt` exists; otherwise "Updated at (no submission timestamp recorded)"; "Not recorded" if neither.
- **Submitter:** `t.submittedBy || t.submittedById`, resolved via `usersMap` to displayName/email, else raw id, else "No submitter recorded" — which is why `submittedBy` should be backfilled alongside.

---
*Worker 2a, 2026-10-06 ~06:35 PKT. No code written — research only.*
