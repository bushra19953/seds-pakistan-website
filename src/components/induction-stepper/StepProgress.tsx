"use client";

import { Fragment, memo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StepProgressStep = {
  id: string;
  title: string;
};

type StepProgressProps = {
  steps: StepProgressStep[];
  currentStep: number;
};

// Step progress indicator for the induction application, adapted from the
// "Stepper" pattern on 21st.dev (@framecn/components/stepper): numbered
// circles joined by a connector line whose fill animates as the active
// step changes. The 21st.dev source is account-gated, so the pattern is
// re-implemented here against the project's own components.
//
// Gold is the single accent: it marks only the current step node, the
// connector fill leading to it, and (in the page) the primary action
// buttons. Completed steps stay neutral with a check mark.
export const StepProgress = memo(function StepProgress({ steps, currentStep }: StepProgressProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <nav aria-label="Application progress">
      <ol className="flex items-start">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          return (
            <Fragment key={step.id}>
              <li
                aria-current={isCurrent ? 'step' : undefined}
                className="flex flex-col items-center gap-2"
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors duration-300',
                    isCurrent &&
                      'border-amber-400 bg-amber-400 text-black shadow-[0_0_0_4px_rgba(251,191,36,0.18)]',
                    isCompleted && 'border-white/10 bg-white/10 text-foreground',
                    !isCurrent && !isCompleted && 'border-white/15 text-muted-foreground',
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  className={cn(
                    'hidden max-w-[7.5rem] text-center text-[11px] leading-tight sm:block',
                    isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {step.title}
                  <span className="sr-only">
                    {isCompleted ? ' (completed)' : isCurrent ? ' (current step)' : ''}
                  </span>
                </span>
              </li>
              {index < steps.length - 1 && (
                <li aria-hidden="true" className="mx-2 mt-4 h-px min-w-4 flex-1 bg-white/10 sm:mx-3">
                  <motion.div
                    className="h-full origin-left bg-amber-400/60"
                    initial={false}
                    animate={{ scaleX: index < currentStep ? 1 : 0 }}
                    transition={{ duration: shouldReduceMotion ? 0 : 0.45, ease: 'easeOut' }}
                  />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
});
