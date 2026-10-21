/**
 * Cadetship tracker panel (phase2_spec.md Section F.7).
 *
 * Renders the applicant-facing cadetship state from the tracker payload:
 * cohort label, week x of 8 (or 12 once extended), the four checklist
 * items with done/pending states, and the probation end date. Decision
 * outcomes render plainly:
 *   confirmed -> "You are now a Full Member."
 *   extended  -> new end date + "extended once"
 *   exited    -> a neutral line + the NMD's member-facing note if one was
 *                written (decision.memberNote) - never the internal note,
 *                which the payload does not carry at all.
 * Renders NOTHING when the payload has no cadetship block, so legacy
 * approved applicants see their portal exactly as before.
 */

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Circle } from 'lucide-react';
import type { CadetshipTrackerPayload } from '@/lib/applicant-status';

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function CadetshipPanel({
  cadetship,
}: {
  cadetship: CadetshipTrackerPayload | null;
}) {
  if (!cadetship) return null;

  const items: { label: string; detail: string; done: boolean }[] = [
    {
      label: 'Cohort orientation attended',
      detail: 'Attested by a chapter officer',
      done: cadetship.items.orientation,
    },
    {
      label: `Workshops attended (${cadetship.items.workshops.count}/${cadetship.items.workshops.required})`,
      detail: 'Attested by a chapter officer',
      done: cadetship.items.workshops.count >= cadetship.items.workshops.required,
    },
    {
      label: 'Sprint task completed',
      detail: 'Detected from your assigned tasks',
      done: cadetship.items.sprintTask,
    },
    {
      label: 'Code of conduct acknowledged',
      detail: 'Acknowledged by you',
      done: cadetship.items.conduct,
    },
  ];

  const probationEnd = formatDate(cadetship.probationEnd);
  const extendedTo = formatDate(cadetship.extendedTo);
  const decided = cadetship.decision?.outcome;

  return (
    <Card className="border-primary/20 bg-card/80 backdrop-blur-sm">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-foreground">Your Cadetship</h3>
            <p className="text-sm text-muted-foreground">{cadetship.cohortLabel}</p>
          </div>
          <Badge variant="secondary" className="uppercase tracking-wide">
            Week {cadetship.week} of {cadetship.weekCap}
          </Badge>
        </div>

        {cadetship.status === 'under_review' && (
          <p className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
            Your cadetship is under review.
          </p>
        )}

        {decided === 'confirmed' && (
          <p className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm">
            You are now a Full Member.
          </p>
        )}

        {decided === 'extended' && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            Your cadetship was extended once.
            {extendedTo ? ` Your new review date is ${extendedTo}.` : ''}
          </p>
        )}

        {decided === 'exited' && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-2">
            <p>Your cadetship has ended. Thank you for the time you gave to SEDS Pakistan.</p>
            {cadetship.decision?.memberNote && <p>{cadetship.decision.memberNote}</p>}
            <p className="text-muted-foreground">
              Questions about this outcome: please contact your chapter team.
            </p>
          </div>
        )}

        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.label} className="flex items-start gap-3 text-sm">
              {item.done ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" aria-hidden />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span>
                <span className="text-foreground">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        {probationEnd && decided !== 'confirmed' && decided !== 'exited' && (
          <p className="text-xs text-muted-foreground">
            Probation ends {probationEnd}. Approval admitted you to Cadetship; completing it
            makes you a Full Member.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
