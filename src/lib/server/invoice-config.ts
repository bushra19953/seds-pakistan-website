/**
 * invoice-config: AGP institutional invoice payee configuration.
 *
 * Reads the billing identity (payee name, NTN, bank name, IBAN) from env at
 * call time so configuration changes do not depend on module cold-start
 * caching and tests can inject values through process.env.
 *
 * Fail closed (Phase 0, Item 2): invoice generation is blocked while any of
 * NTN, IBAN, or bank name is unset, empty, or still a shipped placeholder.
 * The placeholder values themselves are never a valid configuration.
 */

export const PLACEHOLDER_NTN = '0000000-0';
export const PLACEHOLDER_IBAN = 'PK00 0000 0000 0000 0000 0000';
export const PLACEHOLDER_BANK_NAME = 'Bank name (configure SEDS_BANK_NAME)';

/** Bank-name values shipped in the env templates; all count as placeholders. */
export const PLACEHOLDER_BANK_NAMES: readonly string[] = [
  PLACEHOLDER_BANK_NAME,
  'your_bank_name',
  'your_official_bank_name_here',
];

/**
 * Interim payee name (the value previously hardcoded in the invoice route).
 * Overridable via the optional SEDS_PAYEE_NAME env var; whether this name may
 * remain at all is a pending governance decision, not an engineering one.
 */
export const DEFAULT_PAYEE_NAME = 'SEDS Aerospace Private Limited';

export const INVOICE_NOT_CONFIGURED_ERROR =
  'Invoice issuance is not configured: verified payee bank details are not set.';
export const INVOICE_NOT_CONFIGURED_CODE = 'INVOICE_NOT_CONFIGURED';

export interface AgpConfig {
  payee: string;
  ntn: string;
  bankName: string;
  iban: string;
  currency: string;
  validityDays: number;
}

/** Read the current AGP invoice configuration from env, at call time. */
export function getAgpConfig(env: NodeJS.ProcessEnv = process.env): AgpConfig {
  return {
    payee: env.SEDS_PAYEE_NAME?.trim() || DEFAULT_PAYEE_NAME,
    ntn: env.SEDS_NTN ?? '',
    bankName: env.SEDS_BANK_NAME ?? '',
    iban: env.SEDS_IBAN ?? '',
    currency: 'PKR',
    validityDays: 30,
  };
}

function stripSpaces(value: string): string {
  return value.replace(/\s+/g, '');
}

function isNtnConfigured(ntn: string): boolean {
  const v = ntn.trim();
  return v.length > 0 && v !== PLACEHOLDER_NTN;
}

function isIbanConfigured(iban: string): boolean {
  const v = iban.trim();
  return v.length > 0 && stripSpaces(v) !== stripSpaces(PLACEHOLDER_IBAN);
}

function isBankNameConfigured(bankName: string): boolean {
  const v = bankName.trim();
  return v.length > 0 && !PLACEHOLDER_BANK_NAMES.includes(v);
}

/**
 * Names of the config fields that are unset, empty, or placeholder.
 * Field names only: never returns the configured values, so it is safe to log.
 */
export function getUnconfiguredInvoiceFields(config: AgpConfig): string[] {
  const fields: string[] = [];
  if (!isNtnConfigured(config.ntn)) fields.push('SEDS_NTN');
  if (!isIbanConfigured(config.iban)) fields.push('SEDS_IBAN');
  if (!isBankNameConfigured(config.bankName)) fields.push('SEDS_BANK_NAME');
  return fields;
}

/** True only when NTN, IBAN, and bank name are all set to non-placeholder values. */
export function isInvoiceConfigured(config: AgpConfig): boolean {
  return getUnconfiguredInvoiceFields(config).length === 0;
}

export class InvoiceNotConfiguredError extends Error {
  readonly code = INVOICE_NOT_CONFIGURED_CODE;
  /** Field names (never values) that failed the configuration check. */
  readonly unconfiguredFields: string[];
  constructor(config: AgpConfig) {
    super(INVOICE_NOT_CONFIGURED_ERROR);
    this.name = 'InvoiceNotConfiguredError';
    this.unconfiguredFields = getUnconfiguredInvoiceFields(config);
  }
}

/** Throw InvoiceNotConfiguredError when the payee configuration is incomplete. */
export function assertInvoiceConfigured(config: AgpConfig): void {
  if (!isInvoiceConfigured(config)) {
    throw new InvoiceNotConfiguredError(config);
  }
}
