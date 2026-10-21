// Server-only adapter for the registration-status source of truth
// (Workstream D, spec 3.4). Reads settings/siteWide.registrationStatus.

import type { Firestore } from 'firebase-admin/firestore';
import {
  DEFAULT_REGISTRATION_STATUS,
  type RegistrationStatus,
} from './effective-status';

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  // Firestore Timestamp (Admin SDK) exposes toDate().
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return ((value as { toDate: () => Date }).toDate()).toISOString();
  }
  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// ADAPTER(phase0-registration-status): default until Phase 0/1 lands the settings/siteWide.registrationStatus field set.
export async function getRegistrationStatus(
  db: Firestore | null | undefined,
): Promise<RegistrationStatus> {
  if (!db) return { ...DEFAULT_REGISTRATION_STATUS };
  try {
    const snap = await db.collection('settings').doc('siteWide').get();
    if (!snap.exists) return { ...DEFAULT_REGISTRATION_STATUS };
    const raw = snap.data()?.registrationStatus as Record<string, unknown> | undefined;
    if (!raw || (raw.status !== 'in_process' && raw.status !== 'registered')) {
      return { ...DEFAULT_REGISTRATION_STATUS };
    }
    return {
      status: raw.status,
      registrationNumber: toNullableString(raw.registrationNumber),
      registrationDate: toIsoDate(raw.registrationDate),
      registrarJurisdiction: toNullableString(raw.registrarJurisdiction),
    };
  } catch (error) {
    console.error('[governance] getRegistrationStatus failed, using default:', error);
    return { ...DEFAULT_REGISTRATION_STATUS };
  }
}
