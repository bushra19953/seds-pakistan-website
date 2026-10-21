/**
 * legal-status.ts - Single source of truth for SEDS Pakistan's legal
 * identity and registration status (Item 8, Phase 0 bylaws implementation).
 *
 * Pure module: no Firebase imports, no 'use client' / 'use server'
 * directive, so it is importable from client components, server code,
 * and document generators alike.
 *
 * FAIL-SAFE RULE: incomplete or corrupt data can never produce a
 * "registered" claim. A status of 'registered' is only honoured when
 * registrationNumber, registrationDate, and registrarJurisdiction are
 * all non-empty; otherwise the status is downgraded to 'in_process'.
 */

export const LEGAL_NAME =
  'Students for the Exploration and Development of Space - Pakistan';

export const LEGAL_SHORT_NAME = 'SEDS Pakistan';

export type RegistrationStatus = 'in_process' | 'registered';

export interface RegistrationInfo {
  status?: RegistrationStatus | string | null;
  /**
   * Alias matching the settings/siteWide field name
   * (SiteWideSettings.registrationStatus), so a settings object can be
   * passed straight to the generator.
   */
  registrationStatus?: RegistrationStatus | string | null;
  registrationNumber?: string | null;
  registrationDate?: string | null;
  registrarJurisdiction?: string | null;
}

export const IN_PROCESS_STATUS_LINE =
  'SEDS Pakistan is an independent student-led aerospace engineering initiative. Its registration under the Societies Registration Act 1860 (Act XXI of 1860) is currently in process. Operations operate under strict safety guidelines with zero chemical propellants permitted on university grounds.';

const IN_PROCESS_SHORT_STATUS_LINE =
  'Society under the Societies Registration Act, 1860 - registration in process';

function nonEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalises any input into a safe RegistrationInfo.
 * - Unknown, missing, or misspelled status becomes 'in_process'.
 * - 'registered' with any of registrationNumber / registrationDate /
 *   registrarJurisdiction empty after trim is downgraded to 'in_process'.
 */
export function resolveRegistrationInfo(
  info: Partial<RegistrationInfo> | null | undefined,
): RegistrationInfo {
  const registrationNumber = nonEmpty(info?.registrationNumber);
  const registrationDate = nonEmpty(info?.registrationDate);
  const registrarJurisdiction = nonEmpty(info?.registrarJurisdiction);

  const wantsRegistered =
    (info?.registrationStatus ?? info?.status) === 'registered';
  const complete =
    registrationNumber.length > 0 &&
    registrationDate.length > 0 &&
    registrarJurisdiction.length > 0;

  return {
    status: wantsRegistered && complete ? 'registered' : 'in_process',
    registrationNumber,
    registrationDate,
    registrarJurisdiction,
  };
}

/**
 * THE Status Line A generator.
 *
 * The registered-variant sentence 2 below is DRAFT wording pending
 * Decision 1/2 approval (see spec 8(b).1 / 8(i)); only its slot
 * structure is fixed. Do not treat the draft sentence as approved copy.
 */
export function getStatusLineA(
  info?: Partial<RegistrationInfo> | null,
): string {
  const resolved = resolveRegistrationInfo(info);
  if (resolved.status !== 'registered') {
    return IN_PROCESS_STATUS_LINE;
  }
  // DRAFT (pending Decision 1/2 approval): slot-interpolated registered line.
  return (
    'SEDS Pakistan is an independent student-led aerospace engineering initiative. ' +
    `It is registered under the Societies Registration Act 1860 (Act XXI of 1860) as registration number ${resolved.registrationNumber}, dated ${resolved.registrationDate}, with the Registrar of Joint Stock Companies, ${resolved.registrarJurisdiction}. ` +
    'Operations operate under strict safety guidelines with zero chemical propellants permitted on university grounds.'
  );
}

/** Short status line for space-constrained surfaces (footer, PDFs). */
export function getShortStatusLine(
  info?: Partial<RegistrationInfo> | null,
): string {
  const resolved = resolveRegistrationInfo(info);
  if (resolved.status !== 'registered') {
    return IN_PROCESS_SHORT_STATUS_LINE;
  }
  // DRAFT (pending Decision 1/2 approval): same slot structure as long form.
  return `Society registered under the Societies Registration Act, 1860 - registration number ${resolved.registrationNumber}`;
}

/** Convenience object for components that render name + line together. */
export function getLegalIdentityBlock(
  info?: Partial<RegistrationInfo> | null,
): {
  legalName: string;
  shortName: string;
  statusLine: string;
  shortStatusLine: string;
} {
  return {
    legalName: LEGAL_NAME,
    shortName: LEGAL_SHORT_NAME,
    statusLine: getStatusLineA(info),
    shortStatusLine: getShortStatusLine(info),
  };
}
