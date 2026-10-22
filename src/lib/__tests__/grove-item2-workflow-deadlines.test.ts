/**
 * Grove Item 2 — limiting-step deadline weighting.
 *
 * Spec: ~/workspace/your_files/seds_website_grove_optimization_comparison.md, Item 2.
 * calculateWorkflowDeadlines must weight each step's offset by its
 * estimatedDuration (minutes) when durations are present, and fall back to
 * the current even split when they are absent.
 *
 * The weighted signature (per-step timing objects) is exercised through a
 * cast so this suite compiles against the legacy numeric signature and
 * fails on behavior until the weighted implementation lands.
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
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Fixed "now" so the function's internal new Date() is deterministic.
const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

const offsets = (dates: Date[]) => dates.map((d) => d.getTime() - NOW);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('even split preserved when no durations exist', () => {
  it('keeps the legacy numeric signature on the even split', () => {
    const end = new Date(NOW + 8 * DAY);
    expect(offsets(calc(end, 4))).toEqual([2 * DAY, 4 * DAY, 6 * DAY, 8 * DAY]);
  });

  it('splits evenly when step objects carry no estimatedDuration', () => {
    const end = new Date(NOW + 9 * DAY);
    const steps: StepTiming[] = [{}, {}, {}];
    expect(offsets(calc(end, steps))).toEqual([3 * DAY, 6 * DAY, 9 * DAY]);
  });

  it('treats all-zero durations as absent and splits evenly', () => {
    const end = new Date(NOW + 4 * DAY);
    const steps: StepTiming[] = [{ estimatedDuration: 0 }, { estimatedDuration: 0 }];
    expect(offsets(calc(end, steps))).toEqual([2 * DAY, 4 * DAY]);
  });
});

describe('proportional deadlines when durations are present', () => {
  it('weights offsets by estimatedDuration (60/120/180 over a 360-minute window)', () => {
    const end = new Date(NOW + 360 * MIN);
    const steps: StepTiming[] = [
      { estimatedDuration: 60 },
      { estimatedDuration: 120 },
      { estimatedDuration: 180 },
    ];
    // Cumulative shares of 360 minutes: 60, 60+120, 360.
    expect(offsets(calc(end, steps))).toEqual([60 * MIN, 180 * MIN, 360 * MIN]);
  });

  it('gives the longer step the proportionally longer slice (30/90 over 4 hours)', () => {
    const end = new Date(NOW + 4 * HOUR);
    const steps: StepTiming[] = [{ estimatedDuration: 30 }, { estimatedDuration: 90 }];
    expect(offsets(calc(end, steps))).toEqual([1 * HOUR, 4 * HOUR]);
  });
});

describe('mixed steps with and without durations', () => {
  it('fills a missing duration with the average of the present ones (300 / none / 100 over 600 minutes)', () => {
    const end = new Date(NOW + 600 * MIN);
    const steps: StepTiming[] = [
      { estimatedDuration: 300 },
      {},
      { estimatedDuration: 100 },
    ];
    // Missing step takes the average of 300 and 100 = 200, so the weights
    // are 300/200/100 and cumulative offsets are 300, 500, 600 minutes.
    expect(offsets(calc(end, steps))).toEqual([300 * MIN, 500 * MIN, 600 * MIN]);
  });

  it('reduces to the even split when only one duration is present (none / 90 / none over 270 minutes)', () => {
    const end = new Date(NOW + 270 * MIN);
    const steps: StepTiming[] = [{}, { estimatedDuration: 90 }, {}];
    // The single known duration (90) is also the average, so every step
    // weighs 90 and the split is even.
    expect(offsets(calc(end, steps))).toEqual([90 * MIN, 180 * MIN, 270 * MIN]);
  });
});

describe('total span is unchanged by weighting', () => {
  it('lands the last deadline exactly on the final deadline', () => {
    const end = new Date(NOW + 2 * DAY);
    const steps: StepTiming[] = [
      { estimatedDuration: 45 },
      { estimatedDuration: 15 },
      { estimatedDuration: 120 },
      { estimatedDuration: 60 },
    ];
    const result = calc(end, steps);
    expect(result).toHaveLength(4);
    expect(result[result.length - 1].getTime()).toBe(end.getTime());
  });

  it('keeps deadlines strictly increasing and the gaps summing to the whole window', () => {
    const end = new Date(NOW + 2 * DAY);
    const steps: StepTiming[] = [
      { estimatedDuration: 45 },
      { estimatedDuration: 15 },
      { estimatedDuration: 120 },
      { estimatedDuration: 60 },
    ];
    const result = offsets(calc(end, steps));
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(result[i - 1]);
    }
    const gaps = result.map((v, i) => v - (i === 0 ? 0 : result[i - 1]));
    expect(gaps.reduce((a, b) => a + b, 0)).toBe(2 * DAY);
  });

  it('ends at the same instant as the even split for the same window and step count', () => {
    const end = new Date(NOW + 3 * DAY);
    const weighted = calc(end, [
      { estimatedDuration: 10 },
      { estimatedDuration: 500 },
      { estimatedDuration: 35 },
    ]);
    const even = calc(end, 3);
    expect(weighted[weighted.length - 1].getTime()).toBe(
      even[even.length - 1].getTime(),
    );
  });

  it('gives a single weighted step the full window', () => {
    const end = new Date(NOW + 3 * DAY);
    expect(offsets(calc(end, [{ estimatedDuration: 500 }]))).toEqual([3 * DAY]);
  });
});
