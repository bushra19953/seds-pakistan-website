// Phase 2 governance switches (spec Section 0.1).
// Singleton doc governance_settings/phase2. Deliberately NOT in the
// existing `settings` collection, which has a public-read rules block.
// Missing doc = defaults computed in memory; nothing changes behaviour
// until the doc exists AND the relevant flag is flipped.
// NO caching: every accessor reads Firestore, so a flag flip takes
// effect on the next request (Sections B and D rely on this).

import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firebase-admin';

export type ConsentGateMode = 'hard' | 'record';

export type Phase2Flag =
  | 'consentLive'
  | 'boardLive'
  | 'disciplineLive'
  | 'cadetshipLive'
  | 'complianceLive';

export const PHASE2_FLAGS: Phase2Flag[] = [
  'consentLive',
  'boardLive',
  'disciplineLive',
  'cadetshipLive',
  'complianceLive',
];

export interface GovernanceSettings {
  consentGateMode: Record<string, ConsentGateMode>;
  probationRestoreMode: 'auto' | 'reappoint';
  warningRegistryVariant: 'internal' | 'retired';
  flags: Record<Phase2Flag, boolean>;
  updatedAt?: unknown;
  updatedBy?: string;
  changeReason?: string;
}

export const DEFAULT_GOVERNANCE_SETTINGS: GovernanceSettings = {
  consentGateMode: {
    category_b_appointment: 'hard',
    chapter_lifecycle: 'hard',
    catalog_amendment: 'hard',
    sponsor_partner: 'record',
    other_reserved: 'record',
  },
  probationRestoreMode: 'auto',
  warningRegistryVariant: 'internal',
  flags: {
    consentLive: false,
    boardLive: false,
    disciplineLive: false,
    cadetshipLive: false,
    complianceLive: false,
  },
};

function cloneDefaults(): GovernanceSettings {
  return {
    consentGateMode: { ...DEFAULT_GOVERNANCE_SETTINGS.consentGateMode },
    probationRestoreMode: DEFAULT_GOVERNANCE_SETTINGS.probationRestoreMode,
    warningRegistryVariant: DEFAULT_GOVERNANCE_SETTINGS.warningRegistryVariant,
    flags: { ...DEFAULT_GOVERNANCE_SETTINGS.flags },
  };
}

export async function getGovernanceSettings(
  db: Firestore,
): Promise<GovernanceSettings> {
  const settings = cloneDefaults();
  try {
    const snap = await db.collection('governance_settings').doc('phase2').get();
    if (!snap || !snap.exists) return settings;
    const data = (snap.data() ?? {}) as Record<string, unknown>;

    if (data.consentGateMode && typeof data.consentGateMode === 'object') {
      for (const [key, value] of Object.entries(
        data.consentGateMode as Record<string, unknown>,
      )) {
        if (value === 'hard' || value === 'record') {
          settings.consentGateMode[key] = value;
        }
      }
    }
    if (data.probationRestoreMode === 'auto' || data.probationRestoreMode === 'reappoint') {
      settings.probationRestoreMode = data.probationRestoreMode;
    }
    if (data.warningRegistryVariant === 'internal' || data.warningRegistryVariant === 'retired') {
      settings.warningRegistryVariant = data.warningRegistryVariant;
    }
    if (data.flags && typeof data.flags === 'object') {
      for (const flag of PHASE2_FLAGS) {
        const value = (data.flags as Record<string, unknown>)[flag];
        if (typeof value === 'boolean') settings.flags[flag] = value;
      }
    }
    if (data.updatedAt !== undefined) settings.updatedAt = data.updatedAt;
    if (typeof data.updatedBy === 'string') settings.updatedBy = data.updatedBy;
    if (typeof data.changeReason === 'string') settings.changeReason = data.changeReason;
    return settings;
  } catch {
    // Fail closed: defaults have every live flag off.
    return cloneDefaults();
  }
}

// A missing key means 'hard' (fail closed), per spec 0.1.
export async function getConsentGateMode(
  db: Firestore,
  matterClass: string,
): Promise<ConsentGateMode> {
  const settings = await getGovernanceSettings(db);
  return settings.consentGateMode[matterClass] ?? 'hard';
}

export async function isPhase2Live(
  dbOrFlag: Firestore | Phase2Flag | string,
  flag?: Phase2Flag | string,
): Promise<boolean> {
  // Dual call shape (integration step 7): Workstream A's consumers call
  // isPhase2Live(db, flag); the Cadetship+Compliance crew's module bound
  // getDb() internally and its consumers call isPhase2Live(flag). Both
  // shapes are supported; the string form resolves the db itself.
  let db: Firestore | null;
  let flagName: string;
  if (typeof dbOrFlag === 'string') {
    flagName = dbOrFlag;
    db = getDb();
    if (!db) return false;
  } else {
    db = dbOrFlag;
    flagName = String(flag ?? '');
  }
  const settings = await getGovernanceSettings(db);
  if (settings.flags[flagName as Phase2Flag] === true) return true;
  // Workstream B flag names (e.g. 'boardLive' from the board route) live
  // as top-level booleans on the same doc; check the raw doc too.
  try {
    const snap = await db.collection('governance_settings').doc('phase2').get();
    const raw = (snap?.data() ?? {}) as Record<string, unknown>;
    return raw[flagName] === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workstream B per-matter gate settings (integration step 4). The gates
// branch read these from settings/governance; the canonical doc is
// governance_settings/phase2 (spec 0.1), so this reader is implemented
// over the accessor above - the "one-line swap" the gates crew isolated
// for. Contract preserved from the gates implementation:
// - doc missing or matter key absent -> mode 'record', source 'missing'
//   (deploying the gate before the doc is seeded degrades to record-only);
// - mode present in consentGateMode -> source 'doc';
// - validityDays: no canonical per-matter field exists; the optional
//   matterValidityDays map on the doc is honored when present, else the
//   90-day default. NOTE the deliberate default difference from
//   getConsentGateMode above (absent -> 'hard'): getConsentMatterSettings
//   serves Workstream B's assertConsentFor, whose spec'd degraded state
//   is record-only. Both contracts are kept as their specs wrote them;
//   the divergence is recorded in the integration log.
// ---------------------------------------------------------------------------

export const GOVERNANCE_SETTINGS_PATH = {
  collection: 'governance_settings',
  doc: 'phase2',
} as const;

export interface ConsentMatterSettings {
  mode: ConsentGateMode;
  validityDays: number;
  source: 'doc' | 'missing' | 'malformed';
}

export const DEFAULT_VALIDITY_DAYS = 90;

export async function getConsentMatterSettings(
  db: Firestore,
  matterKey: string,
): Promise<ConsentMatterSettings> {
  let raw: Record<string, unknown> | null = null;
  try {
    const snap = await db.collection('governance_settings').doc('phase2').get();
    if (snap && snap.exists) raw = (snap.data() ?? {}) as Record<string, unknown>;
  } catch {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  if (!raw) {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  const validityMap = raw.matterValidityDays as Record<string, unknown> | undefined;
  const rawValidity = validityMap?.[matterKey];
  const validityDays =
    typeof rawValidity === 'number' && rawValidity > 0 ? rawValidity : DEFAULT_VALIDITY_DAYS;
  const modes = raw.consentGateMode as Record<string, unknown> | undefined;
  const mode = modes?.[matterKey];
  if (mode === 'hard' || mode === 'record') {
    return { mode, validityDays, source: 'doc' };
  }
  if (mode === undefined) {
    return { mode: 'record', validityDays, source: 'missing' };
  }
  return { mode: 'record', validityDays, source: 'malformed' };
}
