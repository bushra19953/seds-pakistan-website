/**
 * Grove Item 2 — the flagged limiting step.
 *
 * Spec: design verification (~/workspace/high-output-management/build/item-2-design.md),
 * which CORRECTED the comparison doc's step-4 pinning rule: anchoring the
 * flagged step at "final deadline minus its own duration" breaks
 * monotonicity when the flagged step is last, so the flag instead takes
 * its own duration as its weight inside the same cumulative weighted
 * split used for every step:
 *
 *   deadline_i = now + total * (sum of weights up to and including i) /
 *                (sum of all weights)
 *
 * Weights: a step's weight is its estimatedDuration; steps without one are
 * imputed the mean of the positive durations. The result is non-decreasing
 * and the last step lands exactly on the final deadline. The flag is
 * stored on the step task regardless of the math outcome.
 */
import { calculateWorkflowDeadlines } from '../workflow-utils';

type StepTiming = {
  estimatedDuration?: number; // minutes, as on the workflow step type
  isLimitingStep?: boolean;
};

const calc = calculateWorkflowDeadlines as unknown as (
  finalDeadline: Date,
  steps: number | StepTiming[],
) => Date[];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

const offsets = (dates: Date[]) => dates.map((d) => d.getTime() - NOW);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('limiting step in the cumulative weighted split', () => {
  it('gives a middle limiting step its duration share of the window', () => {
    const end = new Date(NOW + 10 * DAY);
    const steps: StepTiming[] = [
      { estimatedDuration: 60 },
      { estimatedDuration: 240, isLimitingStep: true },
      { estimatedDuration: 60 },
    ];
    // Weights 60/240/60 (total 360) over 14,400 minutes:
    // cumulative offsets 2,400 / 12,000 / 14,400 minutes.
    const result = offsets(calc(end, steps));
    expect(result[0]).toBe(2400 * MIN);
    expect(result[1]).toBe(12000 * MIN);
    expect(result[2]).toBe(10 * DAY);
    // The flagged step's slice is its duration share: 240/360 of the window.
    expect(result[1] - result[0]).toBe((240 / 360) * 10 * DAY);
  });

  it('schedules steps after a first-position limiting step by the same split', () => {
    const end = new Date(NOW + 5 * DAY);
    const steps: StepTiming[] = [
      { estimatedDuration: 120, isLimitingStep: true },
      { estimatedDuration: 60 },
      { estimatedDuration: 60 },
    ];
    // Weights 120/60/60 (total 240) over 7,200 minutes:
    // cumulative offsets 3,600 / 5,400 / 7,200 minutes.
    const result = offsets(calc(end, steps));
    expect(result[0]).toBe(3600 * MIN);
    expect(result[1]).toBe(5400 * MIN);
    expect(result[2]).toBe(5 * DAY);
  });

  it('lands a last-position limiting step exactly on the final deadline', () => {
    const end = new Date(NOW + 7 * DAY);
    const steps: StepTiming[] = [
      { estimatedDuration: 60 },
      { estimatedDuration: 60 },
      { estimatedDuration: 180, isLimitingStep: true },
    ];
    // Weights 60/60/180 (total 300) over 10,080 minutes:
    // cumulative offsets 2,016 / 4,032 / 10,080 minutes. The flagged last
    // step ends at the final deadline itself (the old pinning rule would
    // have ended it 180 minutes early and broken the sequence end).
    const result = offsets(calc(end, steps));
    expect(result[0]).toBe(2016 * MIN);
    expect(result[1]).toBe(4032 * MIN);
    expect(result[2]).toBe(7 * DAY);
  });

  it('keeps deadlines non-decreasing around the flagged step', () => {
    const end = new Date(NOW + 10 * DAY);
    const steps: StepTiming[] = [
      { estimatedDuration: 30 },
      { estimatedDuration: 90 },
      { estimatedDuration: 240, isLimitingStep: true },
      { estimatedDuration: 45 },
      { estimatedDuration: 45 },
    ];
    const result = offsets(calc(end, steps));
    expect(result).toHaveLength(5);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]);
    }
    expect(result[result.length - 1]).toBe(10 * DAY);
  });

  it('imputes the mean duration to duration-less neighbours of the flagged step', () => {
    const end = new Date(NOW + 4 * DAY);
    const steps: StepTiming[] = [
      {},
      { estimatedDuration: 120, isLimitingStep: true },
      {},
    ];
    // The only known duration is 120, so every step weighs 120 and the
    // split is even: 1,920 / 3,840 / 5,760 minutes.
    const result = offsets(calc(end, steps));
    expect(result[0]).toBe(1920 * MIN);
    expect(result[1]).toBe(3840 * MIN);
    expect(result[2]).toBe(4 * DAY);
  });
});

describe('no flag, no special handling', () => {
  it('schedules purely proportionally when no step is flagged limiting', () => {
    const end = new Date(NOW + 360 * MIN);
    const steps: StepTiming[] = [
      { estimatedDuration: 60 },
      { estimatedDuration: 240 },
      { estimatedDuration: 60 },
    ];
    // Same durations as the flagged case, but unflagged: cumulative
    // proportional offsets 60, 300, 360.
    expect(offsets(calc(end, steps))).toEqual([60 * MIN, 300 * MIN, 360 * MIN]);
  });
});
