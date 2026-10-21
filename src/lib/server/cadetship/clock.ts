/**
 * Cadetship clock + fiscal-year helpers (phase2_spec.md Sections F.1, F.2).
 *
 * The 56-day probation window and the 28-day extension exist in exactly one
 * place: probationWindow(). No caller hardcodes 56 or 28.
 *
 * fiscalYearOf() is shared with the compliance workstream (Section G): the
 * FY start month is a PARAMETER because the two workstreams use different
 * conventions - cadetship uses the Constitution's Jul-Jun (start month 7),
 * compliance uses the Calendar's Oct-Sep (start month 10). One
 * implementation, two conventions, never a silent fork.
 */

export const PROBATION_DAYS = 56;
export const EXTENSION_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProbationWindow {
  probationEnd: Date;
  extendedEnd: Date;
}

export function probationWindow(startedAt: Date): ProbationWindow {
  const probationEnd = new Date(startedAt.getTime() + PROBATION_DAYS * DAY_MS);
  const extendedEnd = new Date(probationEnd.getTime() + EXTENSION_DAYS * DAY_MS);
  return { probationEnd, extendedEnd };
}

export interface FiscalYear {
  fyStartYear: number;
  fyEndYear: number;
  /** Display label, e.g. 'FY2026-27'. */
  fyLabel: string;
  /** Machine tag, e.g. 'FY27'. */
  fyTag: string;
}

/**
 * Fiscal year containing `date`, where the FY starts on the 1st of
 * fyStartMonth (1-12) and is labelled by its END year:
 * Jul-Jun FY ending 2027 => 'FY2026-27', tag 'FY27'.
 */
export function fiscalYearOf(date: Date, fyStartMonth = 7): FiscalYear {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-12
  const fyStartYear = month >= fyStartMonth ? year : year - 1;
  const fyEndYear = fyStartYear + 1;
  const short = (y: number) => String(y % 100).padStart(2, '0');
  return {
    fyStartYear,
    fyEndYear,
    fyLabel: `FY${fyStartYear}-${short(fyEndYear)}`,
    fyTag: `FY${short(fyEndYear)}`,
  };
}

/** Cohort id per F.2: {fyEndYear}-cohort-{n}, e.g. '2027-cohort-1'. */
export function cohortIdFor(fyEndYear: number, sequence: number): string {
  return `${fyEndYear}-cohort-${sequence}`;
}

/** Display label derived from fyLabel + sequence, never stored separately. */
export function cohortDisplayLabel(fyLabel: string, sequence: number): string {
  return `${fyLabel} Cohort ${sequence}`;
}

/** 1-based cadetship week for a given instant (uncapped; UI caps display). */
export function cadetshipWeek(startedAt: Date, now: Date): number {
  const elapsed = now.getTime() - startedAt.getTime();
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / (7 * DAY_MS)) + 1;
}
