// Consent gate lookup (spec Section 0.6). Workstream B consumes this
// exact signature; Workstream A implements the real lookup behind it
// (getDecidedConsent in consent-service.ts). Do not fork this signature.
//
// Fail-closed contract: in 'hard' mode, no decided consent (or a failed
// lookup) BLOCKS the gated act. In 'record' mode the act passes and the
// absence is reported in `reason` so the caller can write its record.

import type { Firestore } from 'firebase-admin/firestore';
import type { ConsentRequest } from '@/types/consent';
import { getReservedMatter } from '@/lib/consents/reserved-matters';
import { getDecidedConsent } from '@/lib/server/consent-service';

export interface ConsentGateInput {
  matterKey: string;
  subjectId?: string;
  mode?: 'hard' | 'record';
}

export interface ConsentGateResult {
  allowed: boolean;
  mode: 'hard' | 'record';
  consent: ConsentRequest | null;
  reason?: string;
}

export async function checkConsentGate(
  db: Firestore,
  input: ConsentGateInput,
): Promise<ConsentGateResult> {
  const matter = getReservedMatter(input.matterKey);
  const mode: 'hard' | 'record' =
    input.mode ??
    (matter
      ? matter.defaultGateMode === 'hard_block'
        ? 'hard'
        : 'record'
      : 'hard'); // unknown matter: fail closed

  if (!matter) {
    return {
      allowed: mode === 'record' ? true : false,
      mode,
      consent: null,
      reason: 'UNKNOWN_MATTER',
    };
  }

  try {
    const consent = await getDecidedConsent(db, {
      matterKey: input.matterKey,
      requestId: input.subjectId,
    });
    if (consent) {
      return { allowed: true, mode, consent };
    }
    return {
      allowed: mode === 'record',
      mode,
      consent: null,
      reason: 'NO_DECIDED_CONSENT',
    };
  } catch {
    // A failed lookup never opens a hard gate.
    return {
      allowed: mode === 'record',
      mode,
      consent: null,
      reason: 'CONSENT_LOOKUP_FAILED',
    };
  }
}
