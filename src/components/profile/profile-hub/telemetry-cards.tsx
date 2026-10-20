'use client';

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

export function TelemetryCards({ telemetry }: { telemetry: Telemetry | null }) {
  if (!telemetry) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {['Tasks completed', 'On-time rate', 'Hours logged', 'Quality index'].map((label) => (
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

  const cards = [
    {
      label: 'Tasks completed',
      value: `${telemetry.tasksCompleted} of ${telemetry.tasksAssigned} assigned`,
      sub: null as string | null,
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      progress: telemetry.tasksAssigned > 0
        ? Math.min(100, (telemetry.tasksCompleted / telemetry.tasksAssigned) * 100)
        : 0,
    },
    {
      label: 'On-time rate',
      value: fmtPct(telemetry.onTimeRate),
      sub: `${telemetry.onTimeCount} on time, ${telemetry.lateCount} late`,
      icon: <Clock className="h-4 w-4 text-sky-400" />,
      progress: telemetry.onTimeRate === null ? 0 : telemetry.onTimeRate * 100,
    },
    {
      label: 'Hours logged',
      value: `${telemetry.loggedHours}h`,
      sub: null,
      icon: <Timer className="h-4 w-4 text-amber-400" />,
      progress: null,
    },
    {
      label: 'Quality index',
      value: telemetry.qualityIndex === null ? 'No data yet' : `${telemetry.qualityIndex}/100`,
      sub: telemetry.qualityIndexBasis === 'explicit'
        ? 'From reviewer scores'
        : telemetry.qualityIndexBasis === 'derived'
          ? 'Derived from on-time and completion rates'
          : null,
      icon: <Sparkles className="h-4 w-4 text-violet-400" />,
      progress: telemetry.qualityIndex,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <Card key={c.label} className="border-border bg-background/60">
            <CardHeader className="pb-1 flex flex-row items-center justify-between">
              <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {c.label}
              </CardTitle>
              {c.icon}
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">{c.value}</p>
              {c.sub && <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>}
              {typeof c.progress === 'number' && (
                <Progress value={c.progress} className="mt-3 h-1.5" />
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card className="border-border bg-background/60">
          <CardContent className="pt-5 flex items-center gap-3">
            <Flame className="h-5 w-5 text-orange-400" />
            <div>
              <p className="text-sm font-bold text-foreground">{telemetry.totalPoints} points</p>
              <p className="text-xs text-muted-foreground">Earned across all missions</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-background/60">
          <CardContent className="pt-5 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-rose-400" />
            <div>
              <p className="text-sm font-bold text-foreground">{telemetry.penaltiesApplied} pts deducted</p>
              <p className="text-xs text-muted-foreground">Late and penalty deductions</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
