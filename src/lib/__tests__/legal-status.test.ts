/**
 * legal-status.test.ts - Item 8 (T8.1-T8.7).
 *
 * Pure unit tests of the Status Line A generator in src/lib/legal-status.ts.
 * The fail-safe is the point: incomplete or corrupt data must never
 * produce a "registered" claim.
 */

import {
  LEGAL_NAME,
  IN_PROCESS_STATUS_LINE,
  getStatusLineA,
  getShortStatusLine,
  resolveRegistrationInfo,
} from '@/lib/legal-status';

const EXPECTED_IN_PROCESS =
  'SEDS Pakistan is an independent student-led aerospace engineering initiative. Its registration under the Societies Registration Act 1860 (Act XXI of 1860) is currently in process. Operations operate under strict safety guidelines with zero chemical propellants permitted on university grounds.';

const COMPLETE_REGISTERED = {
  status: 'registered',
  registrationNumber: 'TEST-123',
  registrationDate: '2026-01-15',
  registrarJurisdiction: 'Islamabad Capital Territory',
};

describe('getStatusLineA in-process output (T8.1, T8.2)', () => {
  it('T8.1: no argument returns the exact in-process text, character for character', () => {
    expect(getStatusLineA()).toBe(EXPECTED_IN_PROCESS);
    expect(IN_PROCESS_STATUS_LINE).toBe(EXPECTED_IN_PROCESS);
  });

  it('T8.2: explicit in_process status returns the same exact text', () => {
    expect(getStatusLineA({ status: 'in_process' })).toBe(EXPECTED_IN_PROCESS);
  });
});

describe('getStatusLineA fail-safe on absent/corrupt data (T8.3)', () => {
  it('T8.3: null, {}, garbage status, and undefined status all fail safe', () => {
    expect(getStatusLineA(null)).toBe(EXPECTED_IN_PROCESS);
    expect(getStatusLineA({})).toBe(EXPECTED_IN_PROCESS);
    expect(getStatusLineA({ status: 'garbage' })).toBe(EXPECTED_IN_PROCESS);
    expect(getStatusLineA({ status: undefined })).toBe(EXPECTED_IN_PROCESS);
  });

  it('accepts the settings field name registrationStatus as an alias', () => {
    expect(getStatusLineA({ registrationStatus: 'garbage' })).toBe(EXPECTED_IN_PROCESS);
    const line = getStatusLineA({
      registrationStatus: 'registered',
      registrationNumber: 'TEST-123',
      registrationDate: '2026-01-15',
      registrarJurisdiction: 'Islamabad Capital Territory',
    });
    expect(line).toContain('TEST-123');
  });
});

describe('getStatusLineA registered output (T8.4)', () => {
  it('T8.4: complete registered info interpolates the slots and drops the in-process claim', () => {
    const line = getStatusLineA(COMPLETE_REGISTERED);
    expect(line).toContain('TEST-123');
    expect(line).toContain('2026-01-15');
    expect(line).toContain('Islamabad Capital Territory');
    expect(line).not.toContain('currently in process');
  });
});

describe('fail-safe downgrade (T8.5)', () => {
  it.each(['registrationNumber', 'registrationDate', 'registrarJurisdiction'] as const)(
    'T8.5: registered with empty %s returns the in-process text exactly',
    (field) => {
      const info: Record<string, string> = { ...COMPLETE_REGISTERED };
      info[field] = '';
      expect(getStatusLineA(info)).toBe(EXPECTED_IN_PROCESS);
    },
  );

  it('T8.5: whitespace-only detail fields also downgrade', () => {
    expect(
      getStatusLineA({ ...COMPLETE_REGISTERED, registrationNumber: '   ' }),
    ).toBe(EXPECTED_IN_PROCESS);
    expect(resolveRegistrationInfo(COMPLETE_REGISTERED).status).toBe('registered');
    expect(
      resolveRegistrationInfo({ ...COMPLETE_REGISTERED, registrationDate: ' ' }).status,
    ).toBe('in_process');
  });
});

describe('getShortStatusLine (T8.6)', () => {
  it('T8.6: default is the exact short in-process line', () => {
    expect(getShortStatusLine()).toBe(
      'Society under the Societies Registration Act, 1860 - registration in process',
    );
  });

  it('T8.6: complete registered info contains the number and not "in process"', () => {
    const line = getShortStatusLine(COMPLETE_REGISTERED);
    expect(line).toContain('TEST-123');
    expect(line).not.toContain('in process');
  });
});

describe('LEGAL_NAME (T8.7)', () => {
  it('T8.7: equals the Const 1.1 name and does not contain "Chapter"', () => {
    expect(LEGAL_NAME).toBe(
      'Students for the Exploration and Development of Space - Pakistan',
    );
    expect(LEGAL_NAME).not.toContain('Chapter');
  });
});
