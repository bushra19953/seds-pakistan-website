"use client";

import { Check, Circle, Hourglass, X } from 'lucide-react';
import type { PipelineStageState } from '@/lib/applicant-status';

interface StageTrackerProps {
  stages: PipelineStageState[];
  terminalRejected: boolean;
  status: string;
}

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Karachi',
  });
}

function StageIcon({ stage, terminalRejected }: { stage: PipelineStageState; terminalRejected: boolean }) {
  if (stage.state === 'complete') {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Check className="h-5 w-5" aria-hidden />
      </span>
    );
  }
  if (stage.state === 'current') {
    if (terminalRejected) {
      return (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500 text-white">
          <X className="h-5 w-5" aria-hidden />
        </span>
      );
    }
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-primary/15 text-primary">
        <Hourglass className="h-5 w-5 animate-pulse" aria-hidden />
      </span>
    );
  }
  if (stage.state === 'skipped') {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground/50">
        <X className="h-5 w-5" aria-hidden />
      </span>
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
      <Circle className="h-5 w-5" aria-hidden />
    </span>
  );
}

export default function StageTracker({ stages, terminalRejected, status }: StageTrackerProps) {
  return (
    <ol aria-label="Application progress" className="space-y-0">
      {stages.map((stage, index) => {
        const timestamp = formatTimestamp(stage.timestamp);
        const isLast = index === stages.length - 1;
        const stateLabel =
          stage.state === 'complete'
            ? 'Completed'
            : stage.state === 'current'
              ? terminalRejected
                ? 'Decision made'
                : 'In progress'
              : stage.state === 'skipped'
                ? 'Not reached'
                : 'Upcoming';
        return (
          <li key={stage.key} className="relative flex gap-4 pb-8 last:pb-0">
            {!isLast && (
              <span
                aria-hidden
                className={`absolute left-5 top-10 h-[calc(100%-2.25rem)] w-0.5 -translate-x-1/2 ${
                  stage.state === 'complete' ? 'bg-emerald-500' : 'bg-border'
                }`}
              />
            )}
            <StageIcon stage={stage} terminalRejected={terminalRejected} />
            <div className="min-w-0 pt-1">
              <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                {stage.title}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
                    stage.state === 'complete'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : stage.state === 'current'
                        ? terminalRejected
                          ? 'bg-red-500/15 text-red-300'
                          : 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {stateLabel}
                </span>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{stage.description}</p>
              {timestamp && (
                <p className="mt-1 text-xs font-medium text-muted-foreground">
                  {stage.state === 'complete' ? 'Reached' : 'Started'}: {timestamp} PKT
                </p>
              )}
              {stage.note && (
                <p className={`mt-1 text-sm ${terminalRejected ? 'text-red-300' : 'text-amber-300'}`}>
                  {stage.note}
                </p>
              )}
              {status === 'on_hold' && stage.key === 'screening' && stage.state === 'current' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  No action is needed from you while your application is on hold.
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
