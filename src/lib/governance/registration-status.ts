// Server-only adapter for the registration-status source of truth
// (Workstream D, spec 3.4). Reads settings/siteWide.registrationStatus.

import type { Firestore } from 'firebase-admin/firestore';
import {
  DEFAULT_REGISTRATION_STATUS,
  type RegistrationStatus,
} from './effective-status';
import { resolveRegistrationInfo } from '@/lib/legal-status';

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

// INTEGRATION (step 12, adapter row 24): Phase 0 has landed, so the
// parsed value is normalised through the single source of truth
// (src/lib/legal-status.ts resolveRegistrationInfo) before returning:
// an incomplete 'registered' (any of number/date/jurisdiction empty)
// downgrades to 'in_process', exactly as everywhere else on the site.
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
    const resolved = resolveRegistrationInfo({
      registrationStatus: raw.status,
      registrationNumber: toNullableString(raw.registrationNumber),
      registrationDate: toIsoDate(raw.registrationDate),
      registrarJurisdiction: toNullableString(raw.registrarJurisdiction),
    });
    return {
      status: resolved.status === 'registered' ? 'registered' : 'in_process',
      registrationNumber: resolved.registrationNumber || null,
      registrationDate: resolved.registrationDate || null,
      registrarJurisdiction: resolved.registrarJurisdiction || null,
    };
  } catch (error) {
    console.error('[governance] getRegistrationStatus failed, using default:', error);
    return { ...DEFAULT_REGISTRATION_STATUS };
  }
}
