# Audit Actions Guide

This guide documents how audit actions are defined, stored, displayed, and evolved across the codebase. It provides patterns and procedures to safely change or expand how actions are used in the future.

## Overview

- Audit entries record what happened (`action`), who did it (`actorUid`), what it affected (`targetUidOrResource`), details (`payload`), and when (`timestamp`).
- Entries are written to Firestore collection `audit_logs` via `logAuditEntry` in `src/lib/audit-logging.ts`.
- The Audit Logs UI (`src/app/admin/audit-logs/page.tsx`) reads and filters entries by `actorUid` and `action` and exports them to CSV.
- Legacy role-change entries may exist in `auditLogs` (camelCase); the UI normalizes and displays them alongside unified entries.

## Core Schema

All audit entries must follow this contract:

```
collection: audit_logs
document: {
  action: string,                 // e.g., 'application_submitted', 'role_change'
  actorUid: string,               // user who performed the action
  targetUidOrResource: string,    // affected user id or resource id
  payload: any,                   // contextual details (structured JSON)
  timestamp: Timestamp,           // serverTimestamp()
  meta?: {                        // optional request metadata
    clientIp?: string,
    userAgent?: string,
    isPreview?: boolean,
    schemaVersion?: string        // optional for versioned payloads
  }
}
```

Reference implementation: `src/lib/audit-logging.ts`.

## Naming Convention for Actions

- Use concise, snake_case verbs aligned to domain:
  - applications: `application_submitted`, `application_status_updated`
  - roles: `assign_role`, `role_change`
  - announcements: `announcement_created`, `announcement_updated`
  - skills: `skill_created`, `skill_updated`, `skill_deleted`
- Prefer “entity_operation” style; avoid ambiguous verbs.
- Be stable: once introduced, don’t rename casually. If needed, use migration steps below.
- Avoid PII in action names; put sensitive context in `payload` and enforce redaction as needed.

## How to Add a New Action

1. Choose a clear name following the convention.
2. Identify the code path where the operation occurs.
3. Call `logAuditEntry` with the new action:

```ts
await logAuditEntry(db, 'events_deleted', adminUid, eventId, {
  title,
  deleted_reason,
});
```

4. Ensure Firestore rules allow `create` on `audit_logs` and restrict reads to admin roles (see `firestore.rules`).
5. Verify the Audit Logs UI shows the new action (it auto-populates from recent logs). Optionally pre-register actions (see Catalog below).

## Changing an Existing Action

When the semantics or name must change:

- Recommended approach: introduce a new action; keep the old intact for historical continuity.
- UI normalization (temporary): map legacy actions to new labels for filters.
- Optional backfill: migrate old documents to the new action name.

### Safe Change Procedure

1. Introduce the new action constant and start writing it for new operations.
2. Update the Audit Logs UI to recognize and display both old and new actions.
3. Add tests to confirm both actions filter correctly.
4. (Optional) Run a backfill/migration script to update existing entries.
5. Announce deprecation and a sunset date for the old action.

## Catalog Options (Optional)

To improve discoverability and UX, maintain a catalog of known actions.

- Code constants file: `src/lib/audit-actions.ts` exporting `AUDIT_ACTIONS` and a `label` map.
- Firestore catalog: `audit_action_catalog` with docs `{ action, label, description, group }` for dynamic UI.
- UI behavior:
  - Populate dropdown from catalog first; fall back to scanning recent logs.
  - Group actions by domain (e.g., Roles, Applications, Content).

## UI Integration Notes

- Audit Logs page: `src/app/admin/audit-logs/page.tsx`.
- Filters:
  - Actor: uses `UserSelectionCombobox` to pick a user by UID.
  - Action: dynamic dropdown from recent logs; supports “All actions”.
- Avoid empty string values in `SelectItem` (use a sentinel like `__ALL__`).
- Pagination: uses `limit` and `startAfter`; sort by `timestamp desc`.
- CSV export: includes normalized fields; ensure payload is JSON-stringified.

## Security & Compliance

- Firestore rules (see `firestore.rules`):
  - `allow create` to signed-in users (or only privileged writers depending on policy).
  - `allow read` to admin roles; block general reads of audit logs.
  - Immutability: `allow update, delete: if false` (recommended).
- Redaction: avoid storing secrets or raw PII in `payload`.
- Metadata: optionally capture `meta.userAgent`, `meta.clientIp` for forensics.

## Performance & Indexing

- Queries combine `where('action','==', ...)`, `where('actorUid','==', ...)`, `orderBy('timestamp','desc')`.
- Ensure composite indexes exist when combining filters (Firestore will suggest index definitions in dev console if missing).
- Use pagination (`limit`, `startAfter`) for large result sets.

## Testing Strategy

- Unit tests: verify `logAuditEntry` writes the correct schema.
- Emulator tests: confirm rules allow `create` and restrict `read` appropriately.
- Integration tests: perform operations (e.g., role change) and assert an audit entry appears with expected `action` and payload.
- UI tests: select actions from dropdown and ensure filtered results are correct.

## Migration & Backfill

If you need to rename or merge actions:

1. Create a migration script (Node.js) that:
   - Reads from `audit_logs` (and `auditLogs` legacy, if needed).
   - Transforms `action` values (e.g., `role_updated` → `role_change`).
   - Optionally adds `meta.schemaVersion` or a `payload.migratedFrom` field.
   - Writes updates to new documents (prefer write-new, leave old immutable), or plan carefully if updating in place.
2. Run against a Firestore emulator first.
3. Document the migration in the repo (changelog).

### Backfill Script Sketch

```js
// scripts/migrate-audit-actions.js (sketch)
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc } from 'firebase/firestore';

const app = initializeApp({ /* config */ });
const db = getFirestore(app);

async function migrate() {
  const src = collection(db, 'audit_logs');
  const snap = await getDocs(src);
  for (const d of snap.docs) {
    const data = d.data();
    const mapped = mapAction(data.action);
    if (mapped !== data.action) {
      await setDoc(doc(collection(db, 'audit_logs')), {
        ...data,
        action: mapped,
        meta: { ...(data.meta || {}), migratedFrom: data.action },
      });
    }
  }
}

function mapAction(a) {
  const map = { role_updated: 'role_change' };
  return map[a] || a;
}

migrate().then(() => console.log('Done'));
```

## Versioning Payloads

- If payload structures evolve, include `meta.schemaVersion` (e.g., `"v2"`).
- UI can render payloads differently based on version.

## Examples in Repo

- Induction submission: `src/app/induction/page.tsx` → `application_submitted`.
- Application status update: `src/app/admin/applications/page.tsx` → `application_status_updated`.
- Role assignment/change: `src/app/admin/roles/page.tsx` → `assign_role`, `role_change`.
- Announcements: `src/app/admin/announcements/page.tsx` → `announcement_created`, `announcement_updated`.

## Checklist for Future Changes

- Define action name and payload contract.
- Implement `logAuditEntry` at the operation point.
- Update UI catalog or rely on dynamic discovery.
- Confirm Firestore rules and indexes.
- Add tests (unit/emulator/integration/UI).
- Document change and migration plan (if altering existing actions).

## FAQ

- Why not rename actions directly? Preserve historical integrity; prefer additive changes and normalization.
- Can we limit who writes audits? Yes — tighten rules to only privileged roles/services.
- How do we show user-friendly labels? Maintain a catalog (`audit_action_catalog`) or a constants map for labels/tooltips.

---

For questions or proposals, open an ADR (Architecture Decision Record) or add an entry to `docs/blueprint.md` and reference this guide.