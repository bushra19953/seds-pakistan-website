/**
 * @jest-environment node
 *
 * Unit tests for the fail-closed payee configuration predicate
 * (src/lib/server/invoice-config.ts, Phase 0 Item 2).
 *
 * isInvoiceConfigured must return false for every single-field
 * placeholder/unset variant and true only when NTN, IBAN, and bank name
 * are all non-empty and non-placeholder.
 */

import {
  getAgpConfig,
  isInvoiceConfigured,
  getUnconfiguredInvoiceFields,
  assertInvoiceConfigured,
  InvoiceNotConfiguredError,
  PLACEHOLDER_NTN,
  PLACEHOLDER_IBAN,
  PLACEHOLDER_BANK_NAME,
  type AgpConfig,
} from '../invoice-config';

const VALID: AgpConfig = {
  payee: 'Fixture Payee',
  ntn: '1234567-8',
  bankName: 'Fixture Bank Limited',
  iban: 'PK36FIXT0000001123456702',
  currency: 'PKR',
  validityDays: 30,
};

describe('isInvoiceConfigured', () => {
  it('returns true when NTN, IBAN, and bank name are all set and non-placeholder', () => {
    expect(isInvoiceConfigured(VALID)).toBe(true);
    expect(getUnconfiguredInvoiceFields(VALID)).toEqual([]);
  });

  it('returns false when NTN is the placeholder', () => {
    expect(isInvoiceConfigured({ ...VALID, ntn: PLACEHOLDER_NTN })).toBe(false);
  });

  it('returns false when NTN is unset/empty/whitespace', () => {
    expect(isInvoiceConfigured({ ...VALID, ntn: '' })).toBe(false);
    expect(isInvoiceConfigured({ ...VALID, ntn: '   ' })).toBe(false);
  });

  it('returns false when IBAN is the placeholder (spaced form)', () => {
    expect(isInvoiceConfigured({ ...VALID, iban: PLACEHOLDER_IBAN })).toBe(false);
  });

  it('returns false when IBAN is the placeholder in space-stripped form', () => {
    expect(isInvoiceConfigured({ ...VALID, iban: 'PK0000000000000000000000' })).toBe(false);
  });

  it('returns false when IBAN is unset/empty', () => {
    expect(isInvoiceConfigured({ ...VALID, iban: '' })).toBe(false);
  });

  it('returns false when bank name is the route placeholder', () => {
    expect(isInvoiceConfigured({ ...VALID, bankName: PLACEHOLDER_BANK_NAME })).toBe(false);
  });

  it('returns false when bank name is a shipped template value', () => {
    expect(isInvoiceConfigured({ ...VALID, bankName: 'your_bank_name' })).toBe(false);
    expect(isInvoiceConfigured({ ...VALID, bankName: 'your_official_bank_name_here' })).toBe(false);
  });

  it('returns false when bank name is unset/empty', () => {
    expect(isInvoiceConfigured({ ...VALID, bankName: '' })).toBe(false);
  });

  it('names only the failing fields, never their values', () => {
    const fields = getUnconfiguredInvoiceFields({ ...VALID, ntn: PLACEHOLDER_NTN, iban: '' });
    expect(fields).toEqual(['SEDS_NTN', 'SEDS_IBAN']);
    expect(fields.join(' ')).not.toContain(PLACEHOLDER_NTN);
  });

  it('assertInvoiceConfigured throws InvoiceNotConfiguredError for placeholder config', () => {
    expect(() => assertInvoiceConfigured({ ...VALID, ntn: PLACEHOLDER_NTN })).toThrow(
      InvoiceNotConfiguredError
    );
    expect(() => assertInvoiceConfigured(VALID)).not.toThrow();
  });
});

describe('getAgpConfig', () => {
  it('reads env at call time', () => {
    const a = getAgpConfig({ SEDS_NTN: '1111111-1', SEDS_BANK_NAME: 'Bank A', SEDS_IBAN: 'PK11AAAA' } as NodeJS.ProcessEnv);
    const b = getAgpConfig({ SEDS_NTN: '2222222-2', SEDS_BANK_NAME: 'Bank B', SEDS_IBAN: 'PK22BBBB' } as NodeJS.ProcessEnv);
    expect(a.ntn).toBe('1111111-1');
    expect(b.ntn).toBe('2222222-2');
    expect(a.currency).toBe('PKR');
    expect(a.validityDays).toBe(30);
  });

  it('returns empty strings (not placeholder fallbacks) for unset env', () => {
    const config = getAgpConfig({} as NodeJS.ProcessEnv);
    expect(config.ntn).toBe('');
    expect(config.bankName).toBe('');
    expect(config.iban).toBe('');
    expect(isInvoiceConfigured(config)).toBe(false);
  });

  it('uses the interim payee name by default and SEDS_PAYEE_NAME when set', () => {
    expect(getAgpConfig({} as NodeJS.ProcessEnv).payee).toBe('SEDS Aerospace Private Limited');
    expect(
      getAgpConfig({ SEDS_PAYEE_NAME: 'Fixture Society' } as NodeJS.ProcessEnv).payee
    ).toBe('Fixture Society');
  });
});
