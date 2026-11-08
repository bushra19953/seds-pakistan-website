'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  CheckCircle2,
  Clock,
  Flame,
  ShieldCheck,
  Sparkles,
  Timer,
} from 'lucide-react';
import type { Telemetry } from '@/lib/profile-hub/telemetry';

function fmtPct(rate: number | null): string {
  return rate === null ? 'No data yet' : `${Math.round(rate * 100)}%`;
}

const RING_SIZE = 112;
const RING_STROKE = 9;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Progress ring adapted from the 21st.dev "Circular Progress" pattern
 * (@efferd, https://21st.dev/@efferd/components/circular-progress):
 * an SVG arc that sweeps to the value with the percentage centred.
 * Colours come from the theme tokens: the arc is the surface's single
 * gold accent (--primary); the track is the muted token. Reduced
 * motion renders the final arc with no sweep.
 */
function ProgressRing({ value, label }: { value: number; label: string }) {
  const reduceMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, value));
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="relative shrink-0"
      style={{ width: RING_SIZE, height: RING_SIZE }}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          style={{ stroke: 'hsl(var(--muted))' }}
        />
        {reduceMotion ? (
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={offset}
            style={{ stroke: 'hsl(var(--primary))' }}
          />
        ) : (
          <motion.circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            style={{ stroke: 'hsl(var(--primary))' }}
            initial={{ strokeDashoffset: RING_CIRCUMFERENCE }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xl font-bold tracking-tight text-foreground">
          {Math.round(clamped)}%
        </span>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  progress,
}: {
  label: string;
  value: string;
  sub: string | null;
  icon: React.ReactNode;
  progress: number | null;
}) {
  return (
    <Card className="border-border bg-background/60">
      <CardHeader className="pb-1 flex flex-row items-center justify-between">
        <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </CardTitle>
        <span className="text-muted-foreground/70">{icon}</span>
      </CardHeader>
      <CardContent>
        <p className="text-[28px] leading-9 font-bold tracking-tight text-foreground">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
        {typeof progress === 'number' && <Progress value={progress} className="mt-3 h-1.5" />}
      </CardContent>
    </Card>
  );
}

const PLACEHOLDER_LABELS = ['On-time rate', 'Hours logged', 'Quality index'];

export function TelemetryCards({ telemetry }: { telemetry: Telemetry | null }) {
  if (!telemetry) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-border bg-background/60 sm:col-span-2">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Tasks completed
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-5">
            <ProgressRing value={0} label="Tasks completed" />
            <p className="text-2xl font-bold text-foreground">No data yet</p>
          </CardContent>
        </Card>
        {PLACEHOLDER_LABELS.map((label) => (
          <Card key={label} className="border-border bg-background/60">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">No data yet</p>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const completionPct =
    telemetry.tasksAssigned > 0
      ? Math.min(100, (telemetry.tasksCompleted / telemetry.tasksAssigned) * 100)
      : 0;

  const cards = [
    {
      label: 'On-time rate',
      value: fmtPct(telemetry.onTimeRate),
      sub: `${telemetry.onTimeCount} on time, ${telemetry.lateCount} late`,
      icon: <Clock className="h-4 w-4" />,
      progress: telemetry.onTimeRate === null ? 0 : telemetry.onTimeRate * 100,
    },
    {
      label: 'Hours logged',
      value: `${telemetry.loggedHours}h`,
      sub: null as string | null,
      icon: <Timer className="h-4 w-4" />,
      progress: null as number | null,
    },
    {
      label: 'Quality index',
      value: telemetry.qualityIndex === null ? 'No data yet' : `${telemetry.qualityIndex}/100`,
      sub:
        telemetry.qualityIndexBasis === 'explicit'
          ? 'From reviewer scores'
          : telemetry.qualityIndexBasis === 'derived'
            ? 'Derived from on-time and completion rates'
            : null,
      icon: <Sparkles className="h-4 w-4" />,
      progress: telemetry.qualityIndex,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-border bg-background/60 sm:col-span-2">
          <CardHeader className="pb-1 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Tasks completed
            </CardTitle>
            <span className="text-muted-foreground/70">
              <CheckCircle2 className="h-4 w-4" />
            </span>
          </CardHeader>
          <CardContent className="flex items-center gap-5">
            <ProgressRing value={completionPct} label="Tasks completed" />
            <div className="min-w-0">
              <p className="text-[28px] leading-9 font-bold tracking-tight text-foreground">
                {telemetry.tasksCompleted} of {telemetry.tasksAssigned} assigned
              </p>
            </div>
          </CardContent>
        </Card>
        {cards.map((c) => (
          <StatCard key={c.label} {...c} />
        ))}
      </div>
      <Card className="border-border bg-background/60">
        <CardContent className="pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex items-center gap-3">
            <Flame className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-bold text-foreground">{telemetry.totalPoints} points</p>
              <p className="text-xs text-muted-foreground">Earned across all missions</p>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:border-l sm:border-border sm:pl-7">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-bold text-foreground">
                {telemetry.penaltiesApplied} pts deducted
              </p>
              <p className="text-xs text-muted-foreground">Late and penalty deductions</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
