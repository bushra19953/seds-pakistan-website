// Pure Consent state machine, clock math, and submission validation
// (Phase 2 spec, Section A.6). No Firestore imports: every function here
// is deterministic and unit-testable with an injected `now`/today string.

import type { ConsentDecision, ConsentStatus } from '@/types/consent';
import { isValidMatterKey } from '@/lib/consents/reserved-matters';

export type ConsentActor = 'requester' | 'founder' | 'cron';

export const TERMINAL_STATUSES: ConsentStatus[] = [
  'refused',
  'deemed_withheld',
  'executed',
  'cancelled',
];

// The six decided statuses shown in the Register of Consents.
export const REGISTER_STATUSES: ConsentStatus[] = [
  'consented',
  'refused',
  'conditional',
  'waived',
  'deemed_withheld',
  'executed',
];

export const DECIDED_STATUSES: ConsentStatus[] = [...REGISTER_STATUSES];

export function isTerminalStatus(status: ConsentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isDecidedStatus(status: ConsentStatus): boolean {
  return DECIDED_STATUSES.includes(status);
}

export function isRegisterStatus(status: ConsentStatus): boolean {
  return REGISTER_STATUSES.includes(status);
}

// Transition table (spec A.6). `from` is null for creation.
// Every transition is written by the consent service together with one
// history entry and one audit_logs entry.
const TRANSITIONS: Array<{
  from: ConsentStatus | null;
  to: ConsentStatus;
  actor: ConsentActor;
}> = [
  { from: null, to: 'draft', actor: 'requester' },
  { from: 'draft', to: 'pending', actor: 'requester' },
  { from: 'pending', to: 'further_information_requested', actor: 'founder' },
  { from: 'further_information_requested', to: 'pending', actor: 'requester' },
  { from: 'pending', to: 'consented', actor: 'founder' },
  { from: 'pending', to: 'refused', actor: 'founder' },
  { from: 'pending', to: 'conditional', actor: 'founder' },
  { from: 'pending', to: 'waived', actor: 'founder' },
  { from: 'further_information_requested', to: 'waived', actor: 'founder' },
  { from: 'pending', to: 'deemed_withheld', actor: 'cron' },
  { from: 'consented', to: 'executed', actor: 'requester' },
  { from: 'conditional', to: 'executed', actor: 'requester' },
  { from: 'waived', to: 'executed', actor: 'requester' },
  { from: 'draft', to: 'cancelled', actor: 'requester' },
  { from: 'pending', to: 'cancelled', actor: 'requester' },
  { from: 'further_information_requested', to: 'cancelled', actor: 'requester' },
];

export function canTransition(
  from: ConsentStatus | null,
  to: ConsentStatus,
  actor: ConsentActor,
): boolean {
  return TRANSITIONS.some(
    (t) => t.from === from && t.to === to && t.actor === actor,
  );
}

// The 30-day decision clock: exactly 30 calendar days from `from`
// (Schedule s.4.4). setDate arithmetic keeps month/year boundaries
// correct (Jan 15 -> Feb 14, Dec 20 -> Jan 19).
export function computeDecisionDeadline(from: Date): Date {
  const deadline = new Date(from.getTime());
  deadline.setDate(deadline.getDate() + 30);
  return deadline;
}

export interface DecisionShape {
  decision: ConsentDecision;
  conditions?: string | null;
  consentedScope?: string | null;
  refusedScope?: string | null;
}

// Partial consent shapes (Schedule s.4.5): a conditional consent needs
// conditions and/or a consented scope; a refusal is never conditional
// and must not carry a consented scope.
export function validateDecisionShape(
  shape: DecisionShape,
): 'CONSENT_CONDITIONS_REQUIRED' | null {
  const hasConditions = !!shape.conditions?.trim();
  const hasConsentedScope = !!shape.consentedScope?.trim();
  if (shape.decision === 'conditional_consent') {
    if (!hasConditions && !hasConsentedScope) {
      return 'CONSENT_CONDITIONS_REQUIRED';
    }
  }
  if (shape.decision === 'consent_refused' && hasConsentedScope) {
    return 'CONSENT_CONDITIONS_REQUIRED';
  }
  return null;
}

export interface SubmissionInput {
  matterKey?: unknown;
  proposedAct?: unknown;
  proposedActDate?: unknown;
  amountPkr?: unknown;
  relatedPartyName?: unknown;
  relatedPartyInterest?: unknown;
  materialFacts?: unknown;
  isUrgent?: unknown;
  urgencyReason?: unknown;
}

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Validate every submission field at once; returns a field -> message
// map (empty when valid). `todayStr` is YYYY-MM-DD in Asia/Karachi.
export function validateSubmissionFields(
  input: SubmissionInput,
  todayStr: string,
): Record<string, string> {
  const errors: Record<string, string> = {};

  const matterKey =
    typeof input.matterKey === 'string' ? input.matterKey : '';
  if (!matterKey || !isValidMatterKey(matterKey)) {
    errors.matterKey = 'Select a Reserved Matter from the Schedule list.';
  }

  const proposedAct =
    typeof input.proposedAct === 'string' ? input.proposedAct.trim() : '';
  if (proposedAct.length < 20) {
    errors.proposedAct =
      'State the proposed Act in full (at least 20 characters).';
  }

  const materialFacts =
    typeof input.materialFacts === 'string' ? input.materialFacts.trim() : '';
  if (materialFacts.length < 20) {
    errors.materialFacts =
      'State all material facts (at least 20 characters, Schedule s.4.3).';
  }

  const amount = input.amountPkr;
  if (amount !== null && amount !== undefined) {
    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount < 0
    ) {
      errors.amountPkr = 'Amount must be a whole number of PKR, 0 or more.';
    }
  }

  const dateStr =
    typeof input.proposedActDate === 'string' ? input.proposedActDate : '';
  if (!dateStr || !isRealCalendarDate(dateStr)) {
    errors.proposedActDate = 'Proposed date must be a real date (YYYY-MM-DD).';
  } else if (dateStr < todayStr && input.isUrgent !== true) {
    // A past proposed date is allowed only for urgent Acts (retroactive
    // consent), per spec A.6.
    errors.proposedActDate =
      'Proposed date is in the past; only urgent requests may seek retroactive consent.';
  }

  if (matterKey === 'related_party_contract') {
    const name =
      typeof input.relatedPartyName === 'string'
        ? input.relatedPartyName.trim()
        : '';
    const interest =
      typeof input.relatedPartyInterest === 'string'
        ? input.relatedPartyInterest.trim()
        : '';
    if (!name) {
      errors.relatedPartyName = 'Name the Related Party.';
    }
    if (!interest) {
      errors.relatedPartyInterest =
        'State the nature of the interest in the Related Party.';
    }
  }

  if (input.isUrgent === true) {
    const reason =
      typeof input.urgencyReason === 'string' ? input.urgencyReason.trim() : '';
    if (!reason) {
      errors.urgencyReason = 'Urgent requests must state the urgency reason.';
    }
  }

  return errors;
}
