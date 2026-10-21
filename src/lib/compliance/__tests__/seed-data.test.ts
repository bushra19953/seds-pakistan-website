import {
  OBLIGATION_TEMPLATES,
  FY2026_27_INSTANCES,
  OFFICE_LABEL_TO_ROLE_KEY,
  WAIVE_OCTOBER_2026_KEYS,
  assertSeedInvariants,
} from '../seed-data';

describe('seed catalog invariants (spec G.9)', () => {
  it('assertSeedInvariants passes on the shipped catalog', () => {
    expect(() => assertSeedInvariants()).not.toThrow();
  });

  it('has exactly 34 templates: 23 recurring + 11 event', () => {
    expect(OBLIGATION_TEMPLATES).toHaveLength(34);
    expect(OBLIGATION_TEMPLATES.filter((x) => x.cadence !== 'event')).toHaveLength(23);
    expect(OBLIGATION_TEMPLATES.filter((x) => x.cadence === 'event')).toHaveLength(11);
    expect(OBLIGATION_TEMPLATES.filter((x) => x.cadence === 'monthly')).toHaveLength(4);
    expect(OBLIGATION_TEMPLATES.filter((x) => x.cadence === 'quarterly')).toHaveLength(7);
    expect(OBLIGATION_TEMPLATES.filter((x) => x.cadence === 'annual')).toHaveLength(12);
  });

  it('has exactly 39 instances with the mandated grouping', () => {
    expect(FY2026_27_INSTANCES).toHaveLength(39);
    expect(FY2026_27_INSTANCES.filter((x) => x.templateKey === 'bank-reconciliation')).toHaveLength(12);
    expect(FY2026_27_INSTANCES.filter((x) => x.templateKey === 'board-meeting')).toHaveLength(3);
    expect(FY2026_27_INSTANCES.filter((x) => x.templateKey === 'quarterly-compliance-report')).toHaveLength(4);
  });

  it('December cluster is present, exact, and seed-held', () => {
    const byKey = new Map(FY2026_27_INSTANCES.map((x) => [x.instanceKey, x]));
    for (const key of [
      'fy2026-27:agm-notice:2026-12-10',
      'fy2026-27:agm:2026-12-31',
      'fy2026-27:seds-earth-annual-report:2026-12-31',
    ]) {
      expect(byKey.has(key)).toBe(true);
      expect(byKey.get(key)!.seedHold).toBe(true);
    }
    // No other instance is held.
    expect(FY2026_27_INSTANCES.filter((x) => x.seedHold)).toHaveLength(3);
  });

  it('every instance templateKey resolves and instanceKey matches templateKey+dueDate', () => {
    const keys = new Set(OBLIGATION_TEMPLATES.map((x) => x.key));
    const seen = new Set<string>();
    for (const instance of FY2026_27_INSTANCES) {
      expect(keys.has(instance.templateKey)).toBe(true);
      expect(instance.instanceKey).toBe(`fy2026-27:${instance.templateKey}:${instance.dueDate}`);
      expect(seen.has(instance.instanceKey)).toBe(false);
      seen.add(instance.instanceKey);
    }
  });

  it('board meeting months are exactly [10, 1, 4] - no invented July meeting', () => {
    const board = OBLIGATION_TEMPLATES.find((x) => x.key === 'board-meeting')!;
    expect(board.deadlineRule).toEqual({ kind: 'quarterly_fixed_day', day: 10, months: [10, 1, 4] });
  });

  it('bank reconciliation folds the 9 named audit rows into its evidence checklist', () => {
    const bank = OBLIGATION_TEMPLATES.find((x) => x.key === 'bank-reconciliation')!;
    expect(bank.evidenceChecklist).toHaveLength(9);
    for (const row of [9, 11, 15, 20, 22, 24, 27, 29, 32]) {
      expect(bank.evidenceChecklist!.some((e) => e.includes(`row ${row}`))).toBe(true);
    }
    expect(bank.deadlineRule).toEqual({ kind: 'fixed_day_of_month', day: 15 });
  });

  it('every template officeRole resolves through the single label map', () => {
    for (const tpl of OBLIGATION_TEMPLATES) {
      expect(OFFICE_LABEL_TO_ROLE_KEY[tpl.responsibleOffice]).toBe(tpl.officeRole);
    }
  });

  it('waive-october-2026 names exactly the 3 mandated instances', () => {
    expect(WAIVE_OCTOBER_2026_KEYS).toEqual([
      'fy2026-27:board-meeting:2026-10-10',
      'fy2026-27:bank-reconciliation:2026-10-15',
      'fy2026-27:elections-timetable:2026-10-20',
    ]);
  });

  it('all 11 event templates use event deadline rules and cite art. 5.1', () => {
    for (const tpl of OBLIGATION_TEMPLATES.filter((x) => x.cadence === 'event')) {
      expect(tpl.article).toBe('5.1');
      expect(['days_after_trigger', 'days_before_subject_date', 'prior_to_execution']).toContain(
        tpl.deadlineRule.kind,
      );
    }
  });
});
