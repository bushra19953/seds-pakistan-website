// ADAPTER: thin local stand-in for the Phase 2 W0 substrate governance
// settings accessor (phase2_spec.md Section 0.1). Replace with the canonical
// W0 module at merge time; the exported signatures are the contract and must
// not change.
//
// The settings live in governance_settings/phase2 - deliberately NOT the
// public-read `settings` collection. A missing doc means in-memory defaults:
// every go-live flag false, every consent gate at its spec default. No
// caching: a flag flip takes effect on the next request.

import { getDb } from '@/lib/server/firebase-admin';

export type ConsentGateMode = 'hard' | 'record';
export type Phase2Flag =
  | 'consentLive'
  | 'boardLive'
  | 'disciplineLive'
  | 'cadetshipLive'
  | 'complianceLive';

export interface GovernanceSettings {
  consentGateMode: Record<string, ConsentGateMode>;
  probationRestoreMode: 'auto' | 'reappoint';
  warningRegistryVariant: 'internal' | 'retired';
  consentLive: boolean;
  boardLive: boolean;
  disciplineLive: boolean;
  cadetshipLive: boolean;
  complianceLive: boolean;
}

export const DEFAULT_CONSENT_GATE_MODES: Record<string, ConsentGateMode> = {
  category_b_appointment: 'hard',
  chapter_lifecycle: 'hard',
  catalog_amendment: 'hard',
  sponsor_partner: 'record',
  other_reserved: 'record',
};

export function defaultGovernanceSettings(): GovernanceSettings {
  return {
    consentGateMode: { ...DEFAULT_CONSENT_GATE_MODES },
    probationRestoreMode: 'auto',
    warningRegistryVariant: 'internal',
    consentLive: false,
    boardLive: false,
    disciplineLive: false,
    cadetshipLive: false,
    complianceLive: false,
  };
}

export async function getGovernanceSettings(): Promise<GovernanceSettings> {
  const defaults = defaultGovernanceSettings();
  try {
    const db = getDb();
    if (!db) return defaults;
    const snap = await db.collection('governance_settings').doc('phase2').get();
    if (!snap.exists) return defaults;
    const data = snap.data() as Partial<GovernanceSettings>;
    return {
      consentGateMode: {
        ...defaults.consentGateMode,
        ...(data.consentGateMode ?? {}),
      },
      probationRestoreMode:
        data.probationRestoreMode === 'reappoint' ? 'reappoint' : 'auto',
      warningRegistryVariant:
        data.warningRegistryVariant === 'retired' ? 'retired' : 'internal',
      consentLive: data.consentLive === true,
      boardLive: data.boardLive === true,
      disciplineLive: data.disciplineLive === true,
      cadetshipLive: data.cadetshipLive === true,
      complianceLive: data.complianceLive === true,
    };
  } catch {
    return defaults;
  }
}

export async function isPhase2Live(flag: Phase2Flag): Promise<boolean> {
  const settings = await getGovernanceSettings();
  return settings[flag] === true;
}

/** Gate mode for a matter class; a missing key means hard (fail closed). */
export async function getConsentGateMode(
  matterClass: string,
): Promise<ConsentGateMode> {
  const settings = await getGovernanceSettings();
  return settings.consentGateMode[matterClass] ?? 'hard';
}
