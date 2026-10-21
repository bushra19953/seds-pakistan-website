/**
 * Compliance generator + transitions + owner resolution tests (spec
 * G.2, G.3, G.4): deterministic ids, horizon contents, Board months
 * never invented, idempotency, FY rollover set, state-machine legality,
 * and vacancy routing (a stale snapshot never routes a send).
 */

jest.mock('firebase-admin', () => ({
  firestore: {
    FieldValue: { serverTimestamp: () => '__ts__', increment: (n: number) => ({ __inc: n }) },
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
  },
}));

const mockState = { holders: new Map<string, string[]>() };
let mockDocs: Record<string, any> = {};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('@/lib/server/compliance-role-holders', () => ({
  resolveRoleHolders: async (role: string) => mockState.holders.get(role) ?? [],
}));

function makeDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      mockDocs[path] = opts?.merge ? { ...(mockDocs[path] ?? {}), ...data } : { ...data };
    },
    update: async (data: any) => {
      mockDocs[path] = { ...(mockDocs[path] ?? {}), ...data };
    },
  };
}
function makeQuery(collectionPath: string, filters: any[] = []): any {
  return {
    where: (field: string, op: string, value: any) => makeQuery(collectionPath, [...filters, { field, op, value }]),
    get: async () => {
      const docs = Object.entries(mockDocs)
        .filter(([p]) => p.startsWith(`${collectionPath}/`) && p.split('/').length === 2)
        .filter(([, data]) => filters.every((f) => data[f.field] === f.value))
        .map(([p, data]) => ({ id: p.split('/').pop()!, data: () => data, ref: makeDocRef(p) }));
      return { docs, empty: docs.length === 0, forEach: (fn: any) => docs.forEach(fn) };
    },
  };
}
const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => makeDocRef(`${name}/${id}`),
    where: (field: string, op: string, value: any) => makeQuery(name, [{ field, op, value }]),
    get: async () => makeQuery(name).get(),
  }),
};

import { planHorizonInstances, runGenerator, dueDatesInFy, type TemplateLike } from '../generator';
import { LEGAL_TRANSITIONS, assertLegalTransition, IllegalTransitionError, ladderStateFor } from '../transitions';
import { resolveObligationRecipients } from '../owner-resolution';
import { FOUNDER_UID } from '@/lib/roles';

const bankRec: TemplateLike = {
  templateKey: 'bank-reconciliation',
  title: 'Monthly bank reconciliation',
  officeRole: 'national_treasurer',
  cadence: 'monthly',
  deadlineRule: { kind: 'fixed_day_of_month', day: 15 },
  chapterScoped: false,
  templateVersion: 1,
  active: true,
};
const board: TemplateLike = {
  templateKey: 'board-meeting',
  title: 'Board meeting',
  officeRole: 'national_general_secretary',
  cadence: 'quarterly',
  deadlineRule: { kind: 'quarterly_fixed_day', day: 10, months: [10, 1, 4] },
  chapterScoped: false,
  templateVersion: 1,
  active: true,
};
const agm: TemplateLike = {
  templateKey: 'agm',
  title: 'AGM',
  officeRole: 'president_national',
  cadence: 'annual',
  deadlineRule: { kind: 'fixed_date', month: 12, day: 31 },
  chapterScoped: false,
  templateVersion: 1,
  active: true,
};

describe('dueDatesInFy', () => {
  it('board meetings exist ONLY in Oct, Jan, Apr - the generator never invents a July meeting', () => {
    const dates = dueDatesInFy(board, 2027).map((d) => d.toISOString().slice(0, 10));
    expect(dates).toEqual(['2026-10-10', '2027-01-10', '2027-04-10']);
  });

  it('monthly produces 12 dates on the fixed day; annual fixed_date lands inside the FY', () => {
    expect(dueDatesInFy(bankRec, 2027)).toHaveLength(12);
    expect(dueDatesInFy(agm, 2027).map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-12-31']);
  });
});

describe('planHorizonInstances', () => {
  it('at 2026-10-21: monthly current+next, quarterly current+next quarter, annual current FY', () => {
    const planned = planHorizonInstances([bankRec, board, agm], new Date('2026-10-21T00:00:00Z'), {
      chapters: [],
      includeNextFySet: false,
    });
    const ids = planned.map((p) => p.docId);
    expect(ids).toContain('bank-reconciliation__FY27__2026-10');
    expect(ids).toContain('bank-reconciliation__FY27__2026-11');
    expect(ids).not.toContain('bank-reconciliation__FY27__2026-12');
    expect(ids).toContain('board-meeting__FY27__Q1');
    expect(ids).toContain('board-meeting__FY27__Q2');
    expect(ids).not.toContain('board-meeting__FY27__Q3');
    expect(ids).toContain('agm__FY27__annual');
  });

  it('chapter-scoped templates fan out per chapter with chapter-suffixed ids', () => {
    const chapterReturn: TemplateLike = {
      ...bankRec,
      templateKey: 'chapter-activity-return',
      cadence: 'quarterly',
      deadlineRule: { kind: 'quarterly_fixed_day', day: 15, months: [10, 1, 4, 7] },
      chapterScoped: true,
    };
    const planned = planHorizonInstances([chapterReturn], new Date('2026-10-21T00:00:00Z'), {
      chapters: ['ist', 'khi'],
      includeNextFySet: false,
    });
    const ids = planned.map((p) => p.docId);
    expect(ids).toContain('chapter-activity-return__FY27__Q1__ist');
    expect(ids).toContain('chapter-activity-return__FY27__Q1__khi');
    expect(planned.find((p) => p.docId.endsWith('__ist'))?.chapterId).toBe('ist');
  });
});

describe('runGenerator', () => {
  beforeEach(() => {
    mockDocs = {
      'compliance_templates/bank-reconciliation': { title: 'Bank rec', officeRole: 'national_treasurer', cadence: 'monthly', deadlineRule: { kind: 'fixed_day_of_month', day: 15 }, active: true, templateVersion: 3 },
      'compliance_templates/agm': { title: 'AGM', officeRole: 'president_national', cadence: 'annual', deadlineRule: { kind: 'fixed_date', month: 12, day: 31 }, active: true, templateVersion: 1 },
    };
  });

  it('creates the horizon set with pinned templateVersion, then a re-run creates nothing', async () => {
    const first = await runGenerator(new Date('2026-10-21T00:00:00Z'));
    expect(first.created).toContain('bank-reconciliation__FY27__2026-10');
    expect(first.created).toContain('agm__FY27__annual');
    // The December AGM instance is created HELD even by the generator (Decision 16).
    expect(mockDocs['compliance_obligations/agm__FY27__annual'].seedHold).toBe(true);
    expect(mockDocs['compliance_obligations/bank-reconciliation__FY27__2026-10'].templateVersion).toBe(3);

    const second = await runGenerator(new Date('2026-10-21T00:00:00Z'));
    expect(second.created).toHaveLength(0);
    expect(second.skippedExisting).toBeGreaterThan(0);
    expect(second.rollover).toBe(false);
  });

  it('regeneration guard: a changed template never rewrites an existing instance', async () => {
    await runGenerator(new Date('2026-10-21T00:00:00Z'));
    mockDocs['compliance_templates/bank-reconciliation'].templateVersion = 9;
    await runGenerator(new Date('2026-10-22T00:00:00Z'));
    expect(mockDocs['compliance_obligations/bank-reconciliation__FY27__2026-10'].templateVersion).toBe(3);
  });

  it('FY rollover generates the next-FY annual set', async () => {
    await runGenerator(new Date('2027-09-15T00:00:00Z'));
    const rolloverRun = await runGenerator(new Date('2027-10-02T00:00:00Z'));
    expect(rolloverRun.rollover).toBe(true);
    expect(rolloverRun.created).toContain('agm__FY28__annual');
  });
});

describe('transitions (G.4)', () => {
  it('legal paths exist; backwards and terminal escapes are illegal', () => {
    expect(() => assertLegalTransition('scheduled', 'evidence_submitted')).not.toThrow();
    expect(() => assertLegalTransition('under_review', 'due')).not.toThrow();
    expect(() => assertLegalTransition('cure_period', 'escalated')).not.toThrow();
    expect(() => assertLegalTransition('escalated', 'completed')).not.toThrow();
    expect(() => assertLegalTransition('overdue', 'waived')).not.toThrow();
    expect(() => assertLegalTransition('completed', 'scheduled')).toThrow(IllegalTransitionError);
    expect(() => assertLegalTransition('waived', 'due')).toThrow(IllegalTransitionError);
    // The critical guard: under_review can NEVER go overdue.
    expect(LEGAL_TRANSITIONS.under_review).not.toContain('overdue');
    expect(LEGAL_TRANSITIONS.evidence_submitted).not.toContain('overdue');
  });

  it('ladder state is computed from dates, skipping rungs when needed', () => {
    const due = new Date('2026-11-15T00:00:00Z');
    expect(ladderStateFor(due, [30, 14, 7], new Date('2026-10-01T00:00:00Z'))).toBe('scheduled');
    expect(ladderStateFor(due, [30, 14, 7], new Date('2026-10-20T00:00:00Z'))).toBe('reminded_30');
    expect(ladderStateFor(due, [30, 14, 7], new Date('2026-11-05T00:00:00Z'))).toBe('reminded_14');
    expect(ladderStateFor(due, [30, 14, 7], new Date('2026-11-15T00:00:00Z'))).toBe('due');
  });
});

describe('resolveObligationRecipients (G.2)', () => {
  beforeEach(() => mockState.holders.clear());

  it('a filled office routes to its current holder only', async () => {
    mockState.holders.set('national_treasurer', ['treasurer-1']);
    const out = await resolveObligationRecipients('national_treasurer');
    expect(out).toEqual({ holderUid: 'treasurer-1', vacant: false, recipients: ['treasurer-1'], officeVacant: false });
  });

  it('a vacant office routes to Founder + NGS, flagged vacant', async () => {
    mockState.holders.set('national_general_secretary', ['ngs-1']);
    const out = await resolveObligationRecipients('national_treasurer');
    expect(out.vacant).toBe(true);
    expect(out.officeVacant).toBe(true);
    expect(out.recipients).toEqual([FOUNDER_UID, 'ngs-1']);
  });

  it('when the vacant office IS the NGS, routing is Founder + President', async () => {
    mockState.holders.set('president_national', ['pres-1']);
    const out = await resolveObligationRecipients('national_general_secretary');
    expect(out.recipients).toEqual([FOUNDER_UID, 'pres-1']);
  });
});
