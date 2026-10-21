// Effective status derivation (Workstream D, spec 3.4).
// This is the ONLY place effective status is computed. It is a pure
// function of (record.series, record.adoptionStatus, registrationStatus);
// no admin-editable field, note, or file name can influence it (rule 4).

import type { EffectiveStatus, GovernanceSeries } from './types';

export interface RegistrationStatus {
  status: 'in_process' | 'registered';
  registrationNumber: string | null;
  registrationDate: string | null;
  registrarJurisdiction: string | null;
}

export const DEFAULT_REGISTRATION_STATUS: RegistrationStatus = {
  status: 'in_process',
  registrationNumber: null,
  registrationDate: null,
  registrarJurisdiction: null,
};

// Spec 3.4 rule 1: these series evidence acts; they are not instruments
// that wait on registration to have legal force.
const NOT_APPLICABLE_SERIES: ReadonlySet<GovernanceSeries> = new Set([
  'minutes',
  'resolution',
  'registrar_filing',
  'fbr_receipt',
  'benchmarking_pack',
  'charter',
  'acceptance_letter',
  'consent_record',
]);

export interface EffectiveStatusInput {
  series: GovernanceSeries;
  adoptionStatus: string;
}

export function deriveEffectiveStatus(
  record: EffectiveStatusInput,
  registrationStatus: RegistrationStatus,
): EffectiveStatus {
  // Rule 1: evidence-type series never wait on registration.
  if (NOT_APPLICABLE_SERIES.has(record.series)) {
    return 'not_applicable';
  }
  // An instrument whose adoption does not apply carries no force question.
  if (record.adoptionStatus === 'not_applicable') {
    return 'not_applicable';
  }
  // Rule 3: executed instruments are in force only once registered
  // (Constitution 3.9: the constitution takes effect on registration).
  if (record.adoptionStatus === 'adopted_executed') {
    return registrationStatus.status === 'registered'
      ? 'in_force'
      : 'not_in_force_pending_registration';
  }
  // Rule 2: not_adopted or adopted_pending_execution. While registration
  // is in_process this is not_in_force_pending_registration. It stays
  // not in force even if registration completes first, because an
  // unexecuted instrument has no force to give; the adoptionStatus label
  // layer distinguishes "not yet executed" from "executed, awaiting
  // registration", so no information is lost by sharing the one value.
  return 'not_in_force_pending_registration';
}
