// Consent feature config (Phase 2 spec, Sections A.2 and A.12).
// Lives in settings/consent_config, seeded by scripts/seed-consent-matters.ts.
// Distinct from governance_settings/phase2 (the Section 0.1 switches doc).

import type { Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';

export type FounderRootMode = 'founder_only' | 'founder_or_cto_under_consent';

export interface ConsentConfig {
  filingsEnabled: boolean;
  founderRootMode: FounderRootMode;
}

export const DEFAULT_CONSENT_CONFIG: ConsentConfig = {
  filingsEnabled: true,
  founderRootMode: 'founder_only',
};

export async function getConsentConfig(db: Firestore): Promise<ConsentConfig> {
  try {
    const snap = await db.collection('settings').doc('consent_config').get();
    if (!snap || !snap.exists) return { ...DEFAULT_CONSENT_CONFIG };
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    return {
      filingsEnabled:
        typeof data.filingsEnabled === 'boolean'
          ? data.filingsEnabled
          : DEFAULT_CONSENT_CONFIG.filingsEnabled,
      founderRootMode:
        data.founderRootMode === 'founder_or_cto_under_consent' ||
        data.founderRootMode === 'founder_only'
          ? (data.founderRootMode as FounderRootMode)
          : DEFAULT_CONSENT_CONFIG.founderRootMode,
    };
  } catch {
    return { ...DEFAULT_CONSENT_CONFIG };
  }
}

/**
 * THE single Decision 6 switch point (spec A.12): who may decide Consent
 * requests. Mode 'founder_only' (default): uid === FOUNDER_UID.
 * Mode 'founder_or_cto_under_consent': full semantics are deferred until
 * Decision 6 is taken; until then this ALSO returns uid === FOUNDER_UID,
 * so the gate never widens by accident.
 */
export async function isConsentDecider(
  db: Firestore,
  uid: string | null | undefined,
): Promise<boolean> {
  if (!uid) return false;
  const config = await getConsentConfig(db);
  if (config.founderRootMode === 'founder_or_cto_under_consent') {
    // Deferred semantics (see above): founder only until Decision 6 lands.
    return uid === FOUNDER_UID;
  }
  return uid === FOUNDER_UID;
}
