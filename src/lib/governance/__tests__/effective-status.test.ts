import {
  deriveEffectiveStatus,
  type RegistrationStatus,
} from '../effective-status';
import type { GovernanceSeries } from '../types';

const IN_PROCESS: RegistrationStatus = {
  status: 'in_process',
  registrationNumber: null,
  registrationDate: null,
  registrarJurisdiction: null,
};

const REGISTERED: RegistrationStatus = {
  status: 'registered',
  registrationNumber: 'ICT-1860-2026-001',
  registrationDate: '2026-09-01T00:00:00.000Z',
  registrarJurisdiction: 'ICT',
};

describe('deriveEffectiveStatus (spec 3.4)', () => {
  it('T-01: adopted_executed constitution_suite with registration in_process derives not_in_force_pending_registration', () => {
    expect(
      deriveEffectiveStatus(
        { series: 'constitution_suite', adoptionStatus: 'adopted_executed' },
        IN_PROCESS,
      ),
    ).toBe('not_in_force_pending_registration');
  });

  it('T-02: the same record with registration registered derives in_force with no record edit', () => {
    const record = { series: 'constitution_suite' as const, adoptionStatus: 'adopted_executed' };
    expect(deriveEffectiveStatus(record, IN_PROCESS)).toBe(
      'not_in_force_pending_registration',
    );
    expect(deriveEffectiveStatus(record, REGISTERED)).toBe('in_force');
  });

  it('T-03: minutes, registrar_filing, and fbr_receipt derive not_applicable regardless of registration and adoption', () => {
    const series: GovernanceSeries[] = ['minutes', 'registrar_filing', 'fbr_receipt'];
    for (const s of series) {
      for (const reg of [IN_PROCESS, REGISTERED]) {
        for (const adoptionStatus of [
          'not_adopted',
          'adopted_pending_execution',
          'adopted_executed',
          'not_applicable',
        ]) {
          expect(deriveEffectiveStatus({ series: s, adoptionStatus }, reg)).toBe(
            'not_applicable',
          );
        }
      }
    }
  });

  it('T-03 extended: every rule-1 series derives not_applicable', () => {
    const series: GovernanceSeries[] = [
      'minutes',
      'resolution',
      'registrar_filing',
      'fbr_receipt',
      'benchmarking_pack',
      'charter',
      'acceptance_letter',
      'consent_record',
    ];
    for (const s of series) {
      expect(
        deriveEffectiveStatus({ series: s, adoptionStatus: 'adopted_executed' }, REGISTERED),
      ).toBe('not_applicable');
    }
  });

  it('rule 2: not_adopted and adopted_pending_execution instruments are never in force', () => {
    for (const series of ['constitution_suite', 'policy', 'mou', 'other'] as GovernanceSeries[]) {
      for (const adoptionStatus of ['not_adopted', 'adopted_pending_execution']) {
        expect(deriveEffectiveStatus({ series, adoptionStatus }, IN_PROCESS)).toBe(
          'not_in_force_pending_registration',
        );
        // Even once registered, an unexecuted instrument has no force.
        expect(deriveEffectiveStatus({ series, adoptionStatus }, REGISTERED)).toBe(
          'not_in_force_pending_registration',
        );
      }
    }
  });

  it('rule 3: adopted_executed policy and mou are in_force only when registered', () => {
    for (const series of ['policy', 'mou'] as GovernanceSeries[]) {
      expect(
        deriveEffectiveStatus({ series, adoptionStatus: 'adopted_executed' }, REGISTERED),
      ).toBe('in_force');
      expect(
        deriveEffectiveStatus({ series, adoptionStatus: 'adopted_executed' }, IN_PROCESS),
      ).toBe('not_in_force_pending_registration');
    }
  });

  it('adoptionStatus not_applicable on an instrument series derives not_applicable', () => {
    expect(
      deriveEffectiveStatus(
        { series: 'constitution_suite', adoptionStatus: 'not_applicable' },
        REGISTERED,
      ),
    ).toBe('not_applicable');
  });
});
