import {
  checklistComplete,
  checklistDoneCount,
  evaluationOutcome,
  cadetshipEffectiveStatus,
} from '../checklist';
import { emptyCadetshipItems } from '../types';

function docWith(overrides: {
  orientation?: boolean;
  workshops?: number;
  sprint?: boolean;
  conduct?: boolean;
}) {
  const items = emptyCadetshipItems();
  if (overrides.orientation) {
    items.orientation = { done: true, attestedBy: 'officer1', attestedAt: new Date() };
  }
  const count = overrides.workshops ?? 0;
  items.workshops = {
    count,
    attestations: Array.from({ length: count }, (_, i) => ({
      attestedBy: `officer${i}`,
      attestedAt: new Date(),
      eventRef: null,
    })),
  };
  if (overrides.sprint) {
    items.sprintTask = { taskId: 'task1', completedAt: new Date(), detectedBy: 'auto' };
  }
  return {
    items,
    conduct: { acknowledged: !!overrides.conduct, acknowledgedAt: overrides.conduct ? new Date() : null },
  };
}

describe('checklistComplete (F.4 truth table)', () => {
  it('is false when nothing is done', () => {
    expect(checklistComplete(docWith({}))).toBe(false);
    expect(checklistDoneCount(docWith({}))).toBe(0);
  });

  it('requires all four items; each missing item fails it', () => {
    const full = { orientation: true, workshops: 2, sprint: true, conduct: true };
    expect(checklistComplete(docWith(full))).toBe(true);
    expect(checklistComplete(docWith({ ...full, orientation: false }))).toBe(false);
    expect(checklistComplete(docWith({ ...full, workshops: 1 }))).toBe(false);
    expect(checklistComplete(docWith({ ...full, sprint: false }))).toBe(false);
    expect(checklistComplete(docWith({ ...full, conduct: false }))).toBe(false);
  });

  it('workshops count above 2 still counts as complete', () => {
    expect(
      checklistComplete(docWith({ orientation: true, workshops: 3, sprint: true, conduct: true })),
    ).toBe(true);
  });
});

describe('evaluationOutcome (F.5 agreement rules)', () => {
  const ev = (recommendation: 'confirm' | 'extend' | 'exit') => ({ recommendation });

  it('zero or one submitted evaluation is incomplete', () => {
    expect(evaluationOutcome([], 1)).toBe('incomplete');
    expect(evaluationOutcome([ev('confirm')], 1)).toBe('incomplete');
  });

  it('agreeing pairs map to their outcomes in round 1', () => {
    expect(evaluationOutcome([ev('confirm'), ev('confirm')], 1)).toBe('confirmable');
    expect(evaluationOutcome([ev('extend'), ev('extend')], 1)).toBe('extendable');
    expect(evaluationOutcome([ev('exit'), ev('exit')], 1)).toBe('exitable');
  });

  it('any disagreement escalates to the NMD', () => {
    expect(evaluationOutcome([ev('confirm'), ev('exit')], 1)).toBe('escalated');
    expect(evaluationOutcome([ev('confirm'), ev('extend')], 1)).toBe('escalated');
    expect(evaluationOutcome([ev('extend'), ev('exit')], 1)).toBe('escalated');
  });

  it('round 2 has no extension: extend/extend escalates, never extendable', () => {
    expect(evaluationOutcome([ev('extend'), ev('extend')], 2)).toBe('escalated');
    expect(evaluationOutcome([ev('confirm'), ev('confirm')], 2)).toBe('confirmable');
    expect(evaluationOutcome([ev('exit'), ev('exit')], 2)).toBe('exitable');
  });
});

describe('cadetshipEffectiveStatus (F.3 read-time derivation)', () => {
  const started = new Date('2026-10-22T00:00:00Z');
  const probationEnd = new Date('2026-12-17T00:00:00Z');
  const extendedTo = new Date('2027-01-14T00:00:00Z');

  it('active before probationEnd stays active', () => {
    const out = cadetshipEffectiveStatus(
      { status: 'active', probationEnd, extendedTo: null },
      started,
    );
    expect(out).toEqual({ status: 'active', reviewDue: false });
  });

  it('active at/after probationEnd reads as under_review even if the cron never ran', () => {
    const out = cadetshipEffectiveStatus(
      { status: 'active', probationEnd, extendedTo: null },
      new Date('2026-12-20T00:00:00Z'),
    );
    expect(out).toEqual({ status: 'under_review', reviewDue: true });
  });

  it('extended stays extended but reads reviewDue at extendedTo', () => {
    const before = cadetshipEffectiveStatus(
      { status: 'extended', probationEnd, extendedTo },
      new Date('2027-01-01T00:00:00Z'),
    );
    expect(before).toEqual({ status: 'extended', reviewDue: false });
    const at = cadetshipEffectiveStatus(
      { status: 'extended', probationEnd, extendedTo },
      extendedTo,
    );
    expect(at).toEqual({ status: 'extended', reviewDue: true });
  });

  it('terminal states pass through untouched', () => {
    const out = cadetshipEffectiveStatus(
      { status: 'confirmed', probationEnd, extendedTo: null },
      new Date('2027-06-01T00:00:00Z'),
    );
    expect(out).toEqual({ status: 'confirmed', reviewDue: false });
  });
});
