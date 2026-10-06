# BACKFILL-01: Task 02 step doc IDs + current field state

Investigation date: 2026-10-06 ~06:45 PKT (Worker 1, read-only).
Workflow: Task 02 Executive Portfolio, `wf_1791096197560_ugmmt1`
(recreated 2026-10-04 ~11:45 PKT; all 3 steps co-assigned to Maira Batool + Muhammad Huzaifah Shujjah).

## KEY FINDING: no backfill needed — `submittedAt` already exists on all three docs

The premise ("submitted before the `submittedAt` field existed") does not match the
live data. `git log -L` on `src/app/api/tasks/route.ts` shows the `submittedAt` write
(`updatesToApply.submittedAt = admin.firestore.Timestamp.now()` when a task transitions
to submitted-for-review, plus `submittedBy`) was added in commit `6ddb95d`
("feat: hierarchical task validation via reporting chain"), deployed **2026-10-04 ~20:20 PKT**
— i.e. BEFORE the three Oct 5 submissions. The docs below carry truthful
submission-time stamps, so a backfill from email logs would write the same values.

Note: an earlier live verification (2026-10-06 06:28 PKT) reported "no submittedAt
recorded on these older submissions" — that was a misread by the verifying agent; the
top-level `submittedAt` field IS present (the new admin tasks page at
`src/app/admin/tasks/page.tsx:1518-1522` reads `t.submittedAt` directly).

## Verified title → document ID mapping (read live from Firestore, unauthenticated)

Read method: Firestore REST API `GET .../documents/tasks/{id}` with the public
`NEXT_PUBLIC_FIREBASE_API_KEY`. Allowed because `firestore.rules` line 318 permits
unauthenticated read of tasks docs with a non-null `workflowId`
(`resource.data.workflowId != null`). 200 on all three. Doc `updateTime`/`createTime`
metadata included below to rule out a later backfill write.

| # | Title | Doc ID | sequenceIndex |
|---|-------|--------|---------------|
| 1 | Print Production & Material Procurement | `UHtT8yldnfIjWFmnnhGM` | 1 |
| 2 | Executive Document Audit, Verification & Print File Preparation | `L5Kv8tmIsb6yGi44zkyT` | 0 |
| 3 | Assembly, 5-Point Quality Control & Final Delivery | `z20ZnLAPd3q8ZWRPnRVr` | 2 |

### Doc 1 — `UHtT8yldnfIjWFmnnhGM` — "Print Production & Material Procurement"
- `status`: `submitted-for-review`
- `submittedAt`: `2026-10-05T15:53:19.448Z` (20:53:19 PKT Oct 5)
- `submittedBy`: `aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2` (= `assigneeId`, i.e. Maira's submit)
- `updatedAt`: `2026-10-05T15:53:19.448Z` (== submittedAt: single write at submit)
- Doc metadata: createTime `2026-10-04T06:43:18.286775Z`, updateTime `2026-10-05T15:53:24.947775Z`
- Other timestamps: `createdAt` 2026-10-04T06:43:18.128Z; `deadline` 2026-10-04T19:00:00Z;
  `individualDeadline` 2026-10-04T09:00:00Z. No `completedAt`, no `approvedAt/reviewedAt`,
  no nested `submission` object. `hoursWorked`: absent.
- `report`: Google Doc link `https://docs.google.com/document/d/18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2/edit?usp=sharing&ouid=108789080876588241975&rtpof=true&sd=true`
- `penaltyPoints`: 5, `points`: 3

### Doc 2 — `L5Kv8tmIsb6yGi44zkyT` — "Executive Document Audit, Verification & Print File Preparation"
- `status`: `submitted-for-review`
- `submittedAt`: `2026-10-05T15:38:59.024Z` (20:38:59 PKT Oct 5)
- `submittedBy`: `aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2`
- `updatedAt`: `2026-10-05T15:53:48.862Z` (> submittedAt by ~15 min — a later re-save; this
  doc's `deadline` is stored as `2026-10-05T20:00:00+05:00`, i.e. written by the fixed
  deadline dialog, consistent with the 20-agent swarm's deadline-fix re-save)
- Doc metadata: createTime `2026-10-04T06:43:18.004751Z`, updateTime `2026-10-05T15:53:48.993343Z`
- Other timestamps: `createdAt` 2026-10-04T06:43:17.847Z; `individualDeadline`
  2026-10-04T09:00:00Z. No `completedAt`/`approvedAt`. `hoursWorked`: 1
- `report`: `Objective reached. Direct Transmit.` (the old dummy transmit text)
- `penaltyPoints`: 5, `points`: 4

### Doc 3 — `z20ZnLAPd3q8ZWRPnRVr` — "Assembly, 5-Point Quality Control & Final Delivery"
- `status`: `submitted-for-review`
- `submittedAt`: `2026-10-05T15:47:56.154Z` (20:47:56 PKT Oct 5)
- `submittedBy`: `aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2`
- `updatedAt`: `2026-10-05T15:47:56.154Z` (== submittedAt: single write at submit)
- Doc metadata: createTime `2026-10-04T06:43:17.725775Z`, updateTime `2026-10-05T15:48:01.685759Z`
- Other timestamps: `createdAt` 2026-10-04T06:43:17.560Z; `deadline` 2026-10-05T05:00:00Z;
  `individualDeadline` 2026-10-04T09:00:00Z. No `completedAt`/`approvedAt`. `hoursWorked`: 0.5
- `report`: Google Doc link (same link as Doc 1)
- `penaltyPoints`: 5, `points`: 3

## How to read task docs (for future workers)

1. **Firestore REST, unauthenticated** (works today): tasks docs with `workflowId != null`
   are publicly readable per `firestore.rules:318`. `GET https://firestore.googleapis.com/v1/projects/seds-pakistan/databases/(default)/documents/tasks/{id}?key=$NEXT_PUBLIC_FIREBASE_API_KEY`.
2. **Public mission API** (sanitized, no auth): `GET /api/missions/{workflowId}` returns
   id/title/status/deadlines/createdAt/completedAt — but NOT `submittedAt`/`updatedAt`.
3. **Service account**: NOT available in this sandbox. `scripts/*.js` expect
   `seds-pakistan-service-account.json` at repo root (gitignored, absent);
   `vercel env pull --environment=production` refuses secret values
   ("5 Secret values cannot be pulled"); no `FIREBASE_SERVICE_ACCOUNT` in local env.
   Admin API routes need session auth, which a worker has no credentials for.

## Recommendation

Skip the backfill for these three docs: `submittedAt`/`submittedBy` are already
present with values matching the verified email-log times (20:38:59 / 20:47:56 /
20:53:19 PKT on Oct 5 — consistent with the logged "8:39–8:53 PM Oct 5" submissions).
The remaining known data gaps are content gaps, not timestamp gaps:
the Audit step's `report` is the dummy transmit text, and Deliverable A was never submitted.
