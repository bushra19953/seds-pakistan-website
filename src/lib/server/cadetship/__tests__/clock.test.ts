import {
  probationWindow,
  fiscalYearOf,
  cohortIdFor,
  cohortDisplayLabel,
  cadetshipWeek,
} from '../clock';

describe('probationWindow (clock math)', () => {
  it('probationEnd is exactly startedAt + 56 days', () => {
    const startedAt = new Date('2026-10-22T09:00:00.000Z');
    const { probationEnd } = probationWindow(startedAt);
    expect(probationEnd.getTime() - startedAt.getTime()).toBe(56 * 24 * 60 * 60 * 1000);
    expect(probationEnd.toISOString()).toBe('2026-12-17T09:00:00.000Z');
  });

  it('extendedEnd is exactly probationEnd + 28 days', () => {
    const startedAt = new Date('2026-10-22T09:00:00.000Z');
    const { probationEnd, extendedEnd } = probationWindow(startedAt);
    expect(extendedEnd.getTime() - probationEnd.getTime()).toBe(28 * 24 * 60 * 60 * 1000);
    expect(extendedEnd.toISOString()).toBe('2027-01-14T09:00:00.000Z');
  });
});

describe('fiscalYearOf (cadetship convention: Jul-Jun, start month 7)', () => {
  it('an October 2026 approval falls in FY2026-27 (end year 2027)', () => {
    const fy = fiscalYearOf(new Date('2026-10-22T00:00:00Z'));
    expect(fy.fyEndYear).toBe(2027);
    expect(fy.fyStartYear).toBe(2026);
    expect(fy.fyLabel).toBe('FY2026-27');
    expect(fy.fyTag).toBe('FY27');
  });

  it('a March 2027 approval falls in the same FY2026-27', () => {
    const fy = fiscalYearOf(new Date('2027-03-15T00:00:00Z'));
    expect(fy.fyEndYear).toBe(2027);
    expect(fy.fyLabel).toBe('FY2026-27');
  });

  it('30 June 2027 is still FY2026-27; 1 July 2027 opens FY2027-28', () => {
    expect(fiscalYearOf(new Date('2027-06-30T23:59:59Z')).fyEndYear).toBe(2027);
    const next = fiscalYearOf(new Date('2027-07-01T00:00:00Z'));
    expect(next.fyEndYear).toBe(2028);
    expect(next.fyLabel).toBe('FY2027-28');
  });
});

describe('fiscalYearOf (compliance convention: Oct-Sep, start month 10)', () => {
  it('1 October 2026 opens the FY ending 2027', () => {
    const fy = fiscalYearOf(new Date('2026-10-01T00:00:00Z'), 10);
    expect(fy.fyEndYear).toBe(2027);
    expect(fy.fyLabel).toBe('FY2026-27');
  });

  it('30 September 2026 still belongs to the FY ending 2026', () => {
    const fy = fiscalYearOf(new Date('2026-09-30T23:59:59Z'), 10);
    expect(fy.fyEndYear).toBe(2026);
    expect(fy.fyLabel).toBe('FY2025-26');
  });
});

describe('cohort ids and weeks', () => {
  it('cohortIdFor formats {fyEndYear}-cohort-{n}', () => {
    expect(cohortIdFor(2027, 1)).toBe('2027-cohort-1');
    expect(cohortIdFor(2027, 12)).toBe('2027-cohort-12');
    expect(cohortDisplayLabel('FY2026-27', 1)).toBe('FY2026-27 Cohort 1');
  });

  it('cadetshipWeek is 1-based and floors elapsed weeks', () => {
    const start = new Date('2026-10-22T00:00:00Z');
    expect(cadetshipWeek(start, start)).toBe(1);
    expect(cadetshipWeek(start, new Date('2026-10-28T23:59:59Z'))).toBe(1);
    expect(cadetshipWeek(start, new Date('2026-10-29T00:00:00Z'))).toBe(2);
    expect(cadetshipWeek(start, new Date('2026-12-17T00:00:00Z'))).toBe(9);
  });
});
