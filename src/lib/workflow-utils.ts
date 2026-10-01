export function calculateWorkflowDeadlines(finalDeadline: Date, steps: number): Date[] {
  const now = new Date();
  const end = new Date(finalDeadline);
  if (isNaN(end.getTime())) throw new Error('Invalid final deadline');
  if (end.getTime() <= now.getTime()) throw new Error('Final deadline must be in the future');
  const count = Math.max(1, Number(steps || 1));
  const msTotal = end.getTime() - now.getTime();
  const intervalMs = msTotal / count;
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    const deadlineMs = now.getTime() + intervalMs * (i + 1);
    out.push(new Date(deadlineMs));
  }
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
