// ADAPTER(W0): Local reader for the governance settings doc until the Phase 2
// substrate (feat/bylaws-p2-consent) lands. DISCREPANCY NOTE: spec Section 0.1
// names the doc governance_settings/phase2, while Sections B.2.2, B.4.6 and
// C.4 all name settings/governance. This reader follows B.2.2 / B.4.6 / C.4
// (settings/governance, the doc the B.4.6 rules rider governs). The exported
// signatures are the contract other Phase 2 workstreams consume; if the
// substrate crew lands governance_settings/phase2 instead, only this module's
// internals change at integration.
//
// No caching anywhere in this module: gate modes and feature flags are read on
// every call so a settings flip takes effect on the next request (rollback
// depends on this property, spec B.8).

import type { Firestore } from 'firebase-admin/firestore';

export const GOVERNANCE_SETTINGS_PATH = { collection: 'settings', doc: 'governance' } as const;

export type ConsentGateMode = 'hard' | 'record';

export interface ConsentMatterSettings {
  mode: ConsentGateMode;
  validityDays: number;
  source: 'doc' | 'missing' | 'malformed';
}

export const DEFAULT_VALIDITY_DAYS = 90;

async function readGovernanceDoc(db: Firestore): Promise<Record<string, unknown> | null> {
  const snap = await db
    .collection(GOVERNANCE_SETTINGS_PATH.collection)
    .doc(GOVERNANCE_SETTINGS_PATH.doc)
    .get();
  if (!snap.exists) return null;
  return (snap.data() as Record<string, unknown>) ?? null;
}

/**
 * Per-matter gate settings (spec B.2.2). Reader rules:
 * - Doc missing, consentGate missing, or the matter key missing -> mode
 *   'record', source 'missing' (deploying the gate before the doc is seeded
 *   degrades to record-only, loudly - the gate logs it).
 * - Malformed mode string -> 'record', source 'malformed'. Never guess hard
 *   from bad data, never guess record silently.
 */
export async function getConsentMatterSettings(
  db: Firestore,
  matterKey: string,
): Promise<ConsentMatterSettings> {
  let data: Record<string, unknown> | null = null;
  try {
    data = await readGovernanceDoc(db);
  } catch {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  if (!data) {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  const consentGate = data.consentGate as Record<string, unknown> | undefined;
  const matters = consentGate?.matters as Record<string, unknown> | undefined;
  const raw = matters?.[matterKey] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  const validityDays =
    typeof raw.validityDays === 'number' && raw.validityDays > 0
      ? raw.validityDays
      : DEFAULT_VALIDITY_DAYS;
  if (raw.mode === 'hard' || raw.mode === 'record') {
    return { mode: raw.mode, validityDays, source: 'doc' };
  }
  return { mode: 'record', validityDays, source: 'malformed' };
}

/**
 * Phase 2 feature-flag reader (Section 0.1 accessor shape): flags live as
 * top-level boolean fields on settings/governance (e.g. boardLive). Absent doc
 * or absent flag = false (dormant).
 */
export async function isPhase2Live(db: Firestore, flag: string): Promise<boolean> {
  try {
    const data = await readGovernanceDoc(db);
    return data?.[flag] === true;
  } catch {
    return false;
  }
}

/** Raw settings read for admin surfaces that display current modes. */
export async function getGovernanceSettings(
  db: Firestore,
): Promise<Record<string, unknown> | null> {
  try {
    return await readGovernanceDoc(db);
  } catch {
    return null;
  }
}
