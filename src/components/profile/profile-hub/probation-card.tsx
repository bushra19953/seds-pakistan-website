'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import type { ProbationSummary } from '@/lib/profile-hub/telemetry';

function fmtDate(iso: string | null): string {
  if (!iso) return 'No expiry set';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return 'No expiry set';
  }
}

/**
 * Probation status card. Renders only from the private telemetry endpoint,
 * which is gated to the member and admins server-side, so this component
 * can never receive data it must not show.
 */
export function ProbationCard({ probation }: { probation: ProbationSummary | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!probation) return null;

  const active = probation.activeWarningCount > 0;
  return (
    <Card
      className={
        active
          ? 'border-amber-500/50 bg-amber-950/20'
          : 'border-emerald-500/30 bg-emerald-950/10'
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {active ? (
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            )}
            Probation status
          </CardTitle>
          <Badge variant={active ? 'destructive' : 'secondary'}>
            {active ? `${probation.activeWarningCount} active` : 'Good standing'}
          </Badge>
        </div>
        <CardDescription>
          {active
            ? probation.daysUntilNextExpiry === null
              ? 'An active warning has no expiry set. Complete the redemption checklist below.'
              : `Earliest expiry in ${probation.daysUntilNextExpiry} day${probation.daysUntilNextExpiry === 1 ? '' : 's'}.`
            : 'No active warnings. Keep your record clean.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(probation.isBlacklisted || probation.isBanned) && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-950/20 p-3">
            <Ban className="h-4 w-4 text-red-400" />
            <p className="text-sm text-red-300">
              {probation.isBanned
                ? 'Account banned. Contact the national president about an appeal.'
                : 'Blacklisted. Complete the checklist and contact your chapter president about an appeal.'}
            </p>
          </div>
        )}

        {active && (
          <>
            <div className="space-y-2">
              {(expanded ? probation.warnings : probation.warnings.slice(0, 2)).map((w) => (
                <div
                  key={w.id}
                  className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-amber-200">{w.reason}</p>
                    {w.isPermanent && (
                      <Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-400">
                        <ShieldAlert className="h-3 w-3 mr-1" /> Permanent
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-amber-500/70">
                    {w.type ? `${w.type} · ` : ''}Issued {fmtDate(w.createdAt)} · Expires {fmtDate(w.expiresAt)}
                    {w.taskTitle ? ` · from "${w.taskTitle}"` : ''}
                  </p>
                </div>
              ))}
              {probation.warnings.length > 2 && (
                <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} className="text-amber-400">
                  {expanded ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
                  {expanded ? 'Show fewer' : `Show all ${probation.warnings.length} warnings`}
                </Button>
              )}
            </div>

            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
                Redemption checklist
              </p>
              <ul className="space-y-1.5">
                {probation.redemptionChecklist.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
