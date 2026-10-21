import {
  canTransition,
  isDecidedStatus,
  isRegisterStatus,
  REGISTER_STATUSES,
  validateDecisionShape,
  validateSubmissionFields,
} from '@/lib/consents/consent-state';
import { RESERVED_MATTERS } from '@/lib/consents/reserved-matters';
import type { ConsentStatus } from '@/types/consent';

describe('legalTransitions', () => {
  const legal: Array<[ConsentStatus | null, ConsentStatus, 'requester' | 'founder' | 'cron']> = [
    [null, 'draft', 'requester'],
    ['draft', 'pending', 'requester'],
    ['pending', 'further_information_requested', 'founder'],
    ['further_information_requested', 'pending', 'requester'],
    ['pending', 'consented', 'founder'],
    ['pending', 'refused', 'founder'],
    ['pending', 'conditional', 'founder'],
    ['pending', 'waived', 'founder'],
    ['further_information_requested', 'waived', 'founder'],
    ['pending', 'deemed_withheld', 'cron'],
    ['consented', 'executed', 'requester'],
    ['conditional', 'executed', 'requester'],
    ['waived', 'executed', 'requester'],
    ['draft', 'cancelled', 'requester'],
    ['pending', 'cancelled', 'requester'],
    ['further_information_requested', 'cancelled', 'requester'],
  ];
  it.each(legal)('%s -> %s by %s is accepted', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(true);
  });
});

describe('illegalTransitionsRejected', () => {
  it('rejects decided-to-anything', () => {
    for (const from of ['consented', 'refused', 'waived', 'deemed_withheld', 'executed', 'cancelled'] as ConsentStatus[]) {
      for (const to of ['pending', 'consented', 'refused', 'draft'] as ConsentStatus[]) {
        if (from === 'consented' && to === 'consented') continue;
        expect(canTransition(from, to, 'founder')).toBe(false);
        expect(canTransition(from, to, 'requester')).toBe(false);
      }
    }
  });
  it('rejects draft-to-consented and cancelled-to-anything', () => {
    expect(canTransition('draft', 'consented', 'founder')).toBe(false);
    expect(canTransition('cancelled', 'pending', 'requester')).toBe(false);
    expect(canTransition('cancelled', 'draft', 'requester')).toBe(false);
  });
  it('rejects cron attempting a Founder decision', () => {
    expect(canTransition('pending', 'consented', 'cron')).toBe(false);
    expect(canTransition('pending', 'refused', 'cron')).toBe(false);
    expect(canTransition('pending', 'deemed_withheld', 'founder')).toBe(false);
  });
  it('rejects requester attempting a decision', () => {
    expect(canTransition('pending', 'consented', 'requester')).toBe(false);
    expect(canTransition('pending', 'further_information_requested', 'requester')).toBe(false);
  });
});

describe('registerStatuses', () => {
  it('is exactly the six decided statuses', () => {
    expect([...REGISTER_STATUSES].sort()).toEqual(
      ['conditional', 'consented', 'deemed_withheld', 'executed', 'refused', 'waived'].sort(),
    );
    for (const s of REGISTER_STATUSES) {
      expect(isRegisterStatus(s)).toBe(true);
      expect(isDecidedStatus(s)).toBe(true);
    }
    for (const s of ['draft', 'pending', 'further_information_requested', 'cancelled'] as ConsentStatus[]) {
      expect(isRegisterStatus(s)).toBe(false);
    }
  });
});

describe('partialConsentShapes', () => {
  it('conditions-only conditional is valid', () => {
    expect(validateDecisionShape({ decision: 'conditional_consent', conditions: 'Only phase 1' })).toBeNull();
  });
  it('scopes-only conditional is valid', () => {
    expect(validateDecisionShape({ decision: 'conditional_consent', consentedScope: 'The IST chapter only' })).toBeNull();
  });
  it('conditions and scopes together are valid', () => {
    expect(
      validateDecisionShape({ decision: 'conditional_consent', conditions: 'x', consentedScope: 'y', refusedScope: 'z' }),
    ).toBeNull();
  });
  it('conditional with neither is invalid', () => {
    expect(validateDecisionShape({ decision: 'conditional_consent' })).toBe('CONSENT_CONDITIONS_REQUIRED');
  });
  it('refuse carrying a consented scope is invalid', () => {
    expect(
      validateDecisionShape({ decision: 'consent_refused', consentedScope: 'part of it' }),
    ).toBe('CONSENT_CONDITIONS_REQUIRED');
  });
  it('plain give and plain refuse are valid', () => {
    expect(validateDecisionShape({ decision: 'consent_given' })).toBeNull();
    expect(validateDecisionShape({ decision: 'consent_refused' })).toBeNull();
  });
});

describe('reserved matters seed sanity', () => {
  it('has exactly 18 matters with unique keys', () => {
    expect(RESERVED_MATTERS).toHaveLength(18);
    expect(new Set(RESERVED_MATTERS.map((m) => m.matterKey)).size).toBe(18);
  });
});

describe('validateSubmissionFields', () => {
  const today = '2026-10-21';
  const valid = {
    matterKey: 'appoint_remove_national_officer',
    proposedAct: 'Appoint Jane Doe as National Treasurer',
    proposedActDate: '2026-11-01',
    amountPkr: null,
    materialFacts: 'The seat has been vacant since September 2026.',
    isUrgent: false,
  };
  it('accepts a complete valid submission', () => {
    expect(validateSubmissionFields(valid, today)).toEqual({});
  });
  it('reports all missing fields at once', () => {
    const errors = validateSubmissionFields({}, today);
    expect(Object.keys(errors).sort()).toEqual(
      ['materialFacts', 'matterKey', 'proposedAct', 'proposedActDate'].sort(),
    );
  });
  it('requires related party name and interest for related_party_contract', () => {
    const errors = validateSubmissionFields(
      { ...valid, matterKey: 'related_party_contract' },
      today,
    );
    expect(errors.relatedPartyName).toBeDefined();
    expect(errors.relatedPartyInterest).toBeDefined();
  });
  it('requires urgencyReason when urgent', () => {
    const errors = validateSubmissionFields({ ...valid, isUrgent: true }, today);
    expect(errors.urgencyReason).toBeDefined();
  });
  it('rejects negative or fractional amounts', () => {
    expect(validateSubmissionFields({ ...valid, amountPkr: -5 }, today).amountPkr).toBeDefined();
    expect(validateSubmissionFields({ ...valid, amountPkr: 1.5 }, today).amountPkr).toBeDefined();
    expect(validateSubmissionFields({ ...valid, amountPkr: 0 }, today)).toEqual({});
  });
});
