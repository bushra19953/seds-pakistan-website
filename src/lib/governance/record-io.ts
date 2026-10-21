// Server-only IO helpers for governance records (Workstream D).
// Routes adapt Firestore documents to the GovernanceRecord shape in
// types.ts: Timestamp fields become ISO strings and effectiveStatus is
// always recomputed at read time via deriveEffectiveStatus, so a
// registration-status change takes effect with no data migration
// (spec 3.2 / 3.4).

import type { Firestore } from 'firebase-admin/firestore';
import { deriveEffectiveStatus, type RegistrationStatus } from './effective-status';
import { getRegistrationStatus } from './registration-status';
import type { GovernanceRecord } from './types';

export const GOVERNANCE_COLLECTION = 'governance_records';

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return ((value as { toDate: () => Date }).toDate()).toISOString();
  }
  return null;
}

/** Convert a raw Firestore doc data object to the API record shape. */
export function toGovernanceRecord(
  raw: Record<string, unknown>,
  registrationStatus: RegistrationStatus,
): GovernanceRecord {
  const record = { ...(raw as unknown as GovernanceRecord) };
  record.createdAt = toIso(raw.createdAt);
  record.updatedAt = toIso(raw.updatedAt);
  record.effectiveStatus = deriveEffectiveStatus(
    { series: record.series, adoptionStatus: record.adoptionStatus },
    registrationStatus,
  );
  return record;
}

export async function loadRecord(
  db: Firestore,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const snap = await db.collection(GOVERNANCE_COLLECTION).doc(recordId).get();
  if (!snap.exists) return null;
  return (snap.data() as Record<string, unknown>) ?? null;
}

export async function loadRecordForApi(
  db: Firestore,
  recordId: string,
): Promise<GovernanceRecord | null> {
  const raw = await loadRecord(db, recordId);
  if (!raw) return null;
  const registrationStatus = await getRegistrationStatus(db);
  return toGovernanceRecord(raw, registrationStatus);
}

/** All records of one family, raw, sorted by version ascending. */
export async function loadFamily(
  db: Firestore,
  familyId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db
    .collection(GOVERNANCE_COLLECTION)
    .where('familyId', '==', familyId)
    .get();
  const rows = snap.docs.map(
    (d) => d.data() as Record<string, unknown>,
  );
  rows.sort(
    (a, b) => Number(a.version ?? 0) - Number(b.version ?? 0),
  );
  return rows;
}
