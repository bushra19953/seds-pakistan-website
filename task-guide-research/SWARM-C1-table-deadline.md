# SWARM-C1: Deadline rendering in the /admin/tasks table

Investigation only. No code changed.

## 1. Which field does the deadline column read?

The table is rendered inline in `src/app/admin/tasks/page.tsx` (there is no separate table component). The Deadline column cell is at lines 1273-1277:

```ts
const d = toDate(task.individualDeadline) || toDate(task.deadline);
return d ? format(d, 'dd/MM/yyyy hh:mm a') : '—';
```

It reads **`individualDeadline` first** and falls back to **`deadline`** only when `individualDeadline` is null/empty. So for any task that has an `individualDeadline` set (all workflow step tasks have one), the top-level `deadline` field is ignored by the table.

The same precedence is used for the overdue/status badge cell just above it (line 1251): `toDate(task.individualDeadline) || toDate(task.deadline)`.

## 2. How is it formatted?

- Library: **date-fns `format`**, imported at line 30 of `page.tsx`.
- Format string: **`'dd/MM/yyyy hh:mm a'`** — this is what produces the DD/MM/YYYY style seen on the page (e.g. `04/10/2026 02:00 PM`). `hh` is 12-hour zero-padded, `a` is AM/PM.
- Timezone: **no timezone conversion is specified**. date-fns `format` renders in the **browser's local timezone**. For the reviewer in Pakistan that is PKT (Asia/Karachi, UTC+5). The value rendered is the local-time reading of the stored UTC instant.
- Empty value renders `—`.

## 3. Storage to display path (full chain)

1. **Firestore stores** `deadline` and `individualDeadline` as **Firestore Timestamps** (via the Admin SDK). Write paths that produce them:
   - Create: client sends `new Date(deadline).toISOString()` (page.tsx line 637); server normalizes the ISO string to a Date and stores it as a Timestamp (`src/app/api/tasks/route.ts` lines 939-952).
   - Update: server normalizes ISO string/number to Date (route.ts lines 371-376).
   - Workflow steps: per-step `individualDeadline` from the step's `individualDeadlineIso` (page.tsx lines 824, 845); step deadline edits (page.tsx line 580).
2. **GET /api/tasks** (`src/app/api/tasks/route.ts` lines 1256-1267) serializes every Timestamp to a **UTC ISO string** with a `serializeTs` helper: `ts.toDate().toISOString()`. The wire format is therefore e.g. `2026-10-04T09:00:00.000Z`.
3. **Client normalization** after fetch (page.tsx lines 255-260):
   ```ts
   deadline: toDate(t?.deadline),
   individualDeadline: toDate(t?.individualDeadline),
   ```
   `toDate` (`src/lib/date-utils.ts`) converts ISO strings, Firestore Timestamps (`.toDate()` or `{seconds, nanoseconds}`), Dates, and millis into native Date objects. It performs no timezone shift; it materializes the same instant.
4. **Table cell** (page.tsx line 1274): `toDate(task.individualDeadline) || toDate(task.deadline)`, then `format(d, 'dd/MM/yyyy hh:mm a')` in browser local time.

Net effect: stored UTC instant -> ISO string on the wire -> Date -> date-fns formats in the viewer's local timezone (PKT).

## 4. Computation: stored deadline 2026-10-04T19:00, what should the table show in PKT?

The dialog showed `2026-10-04T19:00`. That string is produced by the Edit dialog's TaskForm initial values (page.tsx line 1355):

```ts
deadline: editingTask.deadline ? new Date(editingTask.deadline as any).toISOString().slice(0, 16) : '',
```

So the stored instant is **2026-10-04T19:00:00.000Z (UTC)**.

If the table were reading that same `deadline` field, it would render the instant in PKT (UTC+5): **2026-10-05 00:00 PKT**, displayed as:

```
05/10/2026 12:00 AM
```

(Verified with `TZ='Asia/Karachi' date -d '2026-10-04T19:00:00Z'`.)

## Root cause of the observed disagreement

The observed table value was `04/10/2026 02:00 PM`. That is exactly the PKT rendering of an instant of **2026-10-04T09:00:00Z** (14:00 PKT, verified with `TZ='Asia/Karachi' date -d '2026-10-04T09:00:00Z'` -> `04/10/2026 02:00 PM`).

The two views disagree because **they read different fields**:

- The **table** reads `individualDeadline` first (09:00Z -> 02:00 PM PKT Oct 4).
- The **dialog**'s task-level deadline input reads **only** `deadline` (19:00Z -> shown as `2026-10-04T19:00`), ignoring `individualDeadline` entirely. Per-step deadlines are edited through a separate per-step `individualDeadlineIso` input, not the main deadline field.

So for "Print Production & Material Procurement" and "Executive Document Audit", `individualDeadline` and `deadline` hold different instants, and each view shows its own field. The table is not mis-formatting; it is faithfully rendering the step-level deadline in local time, while the dialog shows the task-level deadline.

## Secondary display skew (dialog only, noted for the fix team)

The dialog builds its datetime-local value with `new Date(...).toISOString().slice(0, 16)`, i.e. it truncates the **UTC** clock reading and feeds it into a datetime-local input, which displays that string as if it were local time. For the 19:00Z instant the dialog shows `19:00`, but the true PKT reading of that instant is `00:00` on Oct 5, a 5-hour skew for PKT viewers. This skews the dialog's number but does not explain the `02:00 PM` table value; only the field-precedence difference does.
