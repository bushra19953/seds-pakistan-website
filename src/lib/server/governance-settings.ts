// Phase 2 governance switches (spec Section 0.1).
// Singleton doc governance_settings/phase2. Deliberately NOT in the
// existing `settings` collection, which has a public-read rules block.
// Missing doc = defaults computed in memory; nothing changes behaviour
// until the doc exists AND the relevant flag is flipped.
// NO caching: every accessor reads Firestore, so a flag flip takes
// effect on the next request (Sections B and D rely on this).

import type { Firestore } from 'firebase-admin/firestore';

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
  db: Firestore,
  flag: Phase2Flag,
): Promise<boolean> {
  const settings = await getGovernanceSettings(db);
  return settings.flags[flag] === true;
}
