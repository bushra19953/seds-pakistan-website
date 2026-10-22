/**
 * Timing information for one workflow step, used to weight step deadlines.
 * `estimatedDuration` is in minutes, matching `Task.estimatedDuration`.
 */
export interface WorkflowStepTiming {
  estimatedDuration?: number | null;
  isLimitingStep?: boolean;
}

/** A step's timing input: a bare duration in minutes, or a timing object. */
export type WorkflowStepInput = number | WorkflowStepTiming | null | undefined;

function stepDuration(step: WorkflowStepInput): number | null {
  const d = typeof step === 'number' ? step : step?.estimatedDuration;
  return typeof d === 'number' && isFinite(d) && d > 0 ? d : null;
}

/**
 * Compute the deadline for each workflow step.
 *
 * - Called with a step count, or with steps that carry no durations at all,
 *   the total time to the final deadline is split evenly (the historical
 *   behavior, preserved byte for byte).
 * - When steps carry `estimatedDuration`, the split is weighted:
 *   deadline_i = now + msTotal * (sum of weights up to and including i) /
 *   (sum of all weights), where a step's weight is its duration. Steps
 *   without a duration are imputed the mean of the positive durations, so
 *   they share the remaining time evenly and never get a zero-length
 *   slice. The result is non-decreasing and the last step lands exactly on
 *   the final deadline.
 * - A step flagged `isLimitingStep` takes its own duration as its weight
 *   inside that same cumulative split (no separate anchoring, so sequence
 *   order and monotonicity are preserved). With no durations anywhere the
 *   flag does not affect the math; it is stored for display.
 */
export function calculateWorkflowDeadlines(
  finalDeadline: Date,
  steps: number | readonly WorkflowStepInput[]
): Date[] {
  const now = new Date();
  const end = new Date(finalDeadline);
  if (isNaN(end.getTime())) throw new Error('Invalid final deadline');
  if (end.getTime() <= now.getTime()) throw new Error('Final deadline must be in the future');
  const msTotal = end.getTime() - now.getTime();

  const evenSplit = (count: number): Date[] => {
    const intervalMs = msTotal / count;
    const out: Date[] = [];
    for (let i = 0; i < count; i++) {
      out.push(new Date(now.getTime() + intervalMs * (i + 1)));
    }
    return out;
  };

  if (typeof steps === 'number') {
    return evenSplit(Math.max(1, Number(steps || 1)));
  }

  const count = steps.length;
  if (count === 0) return evenSplit(1);

  const durations = steps.map(stepDuration);
  const known = durations.filter((d): d is number => d !== null);
  if (known.length === 0) return evenSplit(count);

  const meanDuration = known.reduce((a, b) => a + b, 0) / known.length;
  const weights = durations.map((d) => (d === null ? meanDuration : d));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const out: Date[] = [];
  let cumulative = 0;
  for (let i = 0; i < count; i++) {
    cumulative += weights[i];
    out.push(new Date(now.getTime() + (msTotal * cumulative) / totalWeight));
  }
  // The final step always lands exactly on the final deadline.
  out[count - 1] = new Date(end.getTime());
  return out;
}

export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';

export function getDeadlineUrgency(deadline: Date): { level: UrgencyLevel; label: string } {
  const d = new Date(deadline);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor(diff / dayMs);
  if (diff <= 0) return { level: 'critical', label: 'Past due' };
  if (days <= 1) return { level: 'critical', label: 'Due in 1 day' };
  if (days <= 3) return { level: 'high', label: `Due in ${days} days` };
  if (days <= 7) return { level: 'medium', label: `Due in ${days} days` };
  return { level: 'low', label: `Due in ${days} days` };
}
