/**
 * Tracker cadetship stage tests (phase2_spec.md Section F.7): the fifth
 * pipeline stage, the cadetship payload block (week derivation + display
 * caps, member-safe decision view), and the legacy-approved behaviour
 * (approved without a cadetship renders exactly as before).
 */

import {
  buildCadetshipPayload,
  buildStatusPayload,
  derivePipeline,
  type ApplicationRecord,
} from '../applicant-status';

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-08-24T00:00:00Z');

function rawCadetship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    personUid: 'cadet-1',
    cohortId: '2027-cohort-1',
    chapterId: 'ist',
    status: 'active',
    startedAt: t0,
    probationEnd: new Date(t0.getTime() + 56 * DAY),
    extendedTo: null,
    items: {
      orientation: { done: true, attestedBy: 'cp-1', attestedAt: t0 },
      workshops: { count: 1, attestations: [] },
      sprintTask: { taskId: null, completedAt: null, detectedBy: null },
    },
    conduct: { acknowledged: false, acknowledgedAt: null },
    decision: {
      outcome: null,
      decidedBy: null,
      decidedByRole: null,
      decidedAt: null,
      round: 1,
      note: 'INTERNAL NOTE - must never reach the cadet',
      memberNote: null,
      exitReason: null,
      resolutionOf: null,
      chosenRecommendation: null,
    },
    ...overrides,
  };
}

describe('buildCadetshipPayload', () => {
  it('week 1 on day one; cohort label derived from the cohort id', () => {
    const payload = buildCadetshipPayload(rawCadetship(), t0)!;
    expect(payload.week).toBe(1);
    expect(payload.weekCap).toBe(8);
    expect(payload.cohortLabel).toBe('FY2026-27 Cohort 1');
    expect(payload.status).toBe('active');
  });

  it('week display caps at 8 in round 1 even at week 11, and status derives to under_review', () => {
    const now = new Date(t0.getTime() + 75 * DAY);
    const payload = buildCadetshipPayload(rawCadetship(), now)!;
    expect(payload.week).toBe(8);
    expect(payload.status).toBe('under_review');
  });

  it('extended records cap the week at 12', () => {
    const now = new Date(t0.getTime() + 100 * DAY);
    const payload = buildCadetshipPayload(
      rawCadetship({ status: 'extended', extendedTo: new Date(t0.getTime() + 84 * DAY) }),
      now,
    )!;
    expect(payload.weekCap).toBe(12);
    expect(payload.week).toBe(12);
  });

  it('items map to the four checklist states', () => {
    const payload = buildCadetshipPayload(rawCadetship(), t0)!;
    expect(payload.items.orientation).toBe(true);
    expect(payload.items.workshops).toEqual({ count: 1, required: 2 });
    expect(payload.items.sprintTask).toBe(false);
    expect(payload.items.conduct).toBe(false);
  });

  it('the decision view exposes memberNote and NEVER the internal note', () => {
    const payload = buildCadetshipPayload(
      rawCadetship({
        status: 'exited',
        decision: {
          outcome: 'exited',
          decidedAt: t0,
          note: 'INTERNAL NOTE - must never reach the cadet',
          memberNote: 'Thank you for applying; this intake was not the right fit.',
          exitReason: 'evaluation_failed',
        },
      }),
      t0,
    )!;
    expect(payload.decision?.memberNote).toContain('Thank you');
    expect(JSON.stringify(payload)).not.toContain('INTERNAL NOTE');
  });

  it('null in -> null out', () => {
    expect(buildCadetshipPayload(null, t0)).toBeNull();
    expect(buildCadetshipPayload(undefined, t0)).toBeNull();
  });
});

describe('pipeline stage + legacy behaviour', () => {
  const approvedRecord: ApplicationRecord = { status: 'approved' };

  it('five stages exist; a pending applicant sees cadetship as upcoming', () => {
    const { stages } = derivePipeline({ status: 'pending' });
    expect(stages).toHaveLength(5);
    expect(stages[4].key).toBe('cadetship');
    expect(stages[4].state).toBe('upcoming');
  });

  it('approved WITHOUT a cadetship stays on onboarding (legacy)', () => {
    const { stages, currentStageIndex } = derivePipeline(approvedRecord);
    expect(currentStageIndex).toBe(3);
    expect(stages[4].state).toBe('upcoming');
    const payload = buildStatusPayload(approvedRecord, 'uid-1', { canEdit: true });
    expect(payload.legacyApproved).toBe(true);
    expect(payload.cadetship).toBeNull();
  });

  it('approved WITH a cadetship moves to the cadetship stage', () => {
    const record: ApplicationRecord = { status: 'approved', cadetshipId: 'cad-1' };
    const { stages, currentStageIndex } = derivePipeline(record);
    expect(currentStageIndex).toBe(4);
    expect(stages[3].state).toBe('complete');
    expect(stages[4].state).toBe('current');
    const cadetship = buildCadetshipPayload(rawCadetship(), t0);
    const payload = buildStatusPayload(record, 'uid-1', { canEdit: true, cadetship });
    expect(payload.legacyApproved).toBe(false);
    expect(payload.cadetship?.cohortId).toBe('2027-cohort-1');
  });

  it('a confirmed cadetship completes the stage; an exited one skips it', () => {
    const confirmed = derivePipeline({ status: 'approved', cadetshipId: 'c', cadetshipOutcome: 'confirmed' });
    expect(confirmed.stages[4].state).toBe('complete');
    const exited = derivePipeline({ status: 'approved', cadetshipId: 'c', cadetshipOutcome: 'exited' });
    expect(exited.stages[4].state).toBe('skipped');
  });
});
