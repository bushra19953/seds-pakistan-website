"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ONBOARDING_MILESTONES } from '@/lib/applicant-status';

interface OnboardingChecklistProps {
  milestones: Record<string, string | null>;
  milestonesEditable: boolean;
  onToggle: (key: string, done: boolean) => Promise<void>;
}

export default function OnboardingChecklist({ milestones, milestonesEditable, onToggle }: OnboardingChecklistProps) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const completed = ONBOARDING_MILESTONES.filter((m) => milestones[m.key]).length;

  if (!milestonesEditable && completed === 0) return null;

  const handleToggle = async (key: string, done: boolean) => {
    setPendingKey(key);
    try {
      await onToggle(key, done);
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle>Onboarding checklist</CardTitle>
        <CardDescription>
          {milestonesEditable
            ? `Complete these steps to finish onboarding. ${completed} of ${ONBOARDING_MILESTONES.length} done.`
            : 'Your onboarding steps. The checklist unlocks once your application is shortlisted.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {ONBOARDING_MILESTONES.map((milestone) => {
            const done = Boolean(milestones[milestone.key]);
            const isPending = pendingKey === milestone.key;
            const inputId = `milestone-${milestone.key}`;
            return (
              <li key={milestone.key} className="flex items-start gap-3">
                {milestonesEditable ? (
                  <Checkbox
                    id={inputId}
                    checked={done}
                    disabled={isPending}
                    onCheckedChange={(checked) => handleToggle(milestone.key, checked === true)}
                    className="mt-1"
                  />
                ) : (
                  <span
                    aria-hidden
                    className={`mt-1 flex h-5 w-5 items-center justify-center rounded border ${
                      done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border bg-muted/40'
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : null}
                  </span>
                )}
                <div className="min-w-0">
                  <Label htmlFor={milestonesEditable ? inputId : undefined} className="font-medium text-foreground">
                    {milestone.title}
                    {isPending && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-hidden />}
                  </Label>
                  <p className="mt-0.5 text-sm text-muted-foreground">{milestone.description}</p>
                  {done && milestones[milestone.key] && (
                    <p className="mt-0.5 text-xs text-emerald-300">
                      Completed {new Date(milestones[milestone.key] as string).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
