'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollText, ExternalLink, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import type { MissionTimelineEntry } from '@/lib/profile-hub/telemetry';

function fmtDate(iso: string | null): string {
  if (!iso) return 'Unknown date';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown date';
  }
}

/** Chronological audit trail of completed tasks with proof links (private hub). */
export function MissionTimeline({ entries, limit = 25 }: { entries: MissionTimelineEntry[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!entries || entries.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-border rounded-3xl bg-muted">
        <ScrollText className="h-10 w-10 text-slate-600 mx-auto mb-3 opacity-40" />
        <h3 className="text-xl font-bold text-foreground mb-2">No completed missions yet</h3>
        <p className="text-muted-foreground max-w-sm mx-auto text-sm">
          Finished tasks appear here with their proof links as a permanent record.
        </p>
      </div>
    );
  }

  const visible = expanded ? entries : entries.slice(0, limit);
  return (
    <div className="space-y-3">
      {visible.map((e) => (
        <Card key={e.taskId} className="border-border bg-background/60">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base leading-tight">{e.title}</CardTitle>
                <CardDescription className="mt-1">
                  {e.workflowTitle ? `${e.workflowTitle} · ` : ''}Completed {fmtDate(e.completedAt)}
                </CardDescription>
              </div>
              <Badge
                variant="outline"
                className={
                  e.wasOnTime === true
                    ? 'border-emerald-500/40 text-emerald-400'
                    : e.wasOnTime === false
                      ? 'border-amber-500/40 text-amber-400'
                      : 'border-border text-muted-foreground'
                }
              >
                {e.wasOnTime === true ? 'On time' : e.wasOnTime === false ? 'Late' : 'No deadline'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground mb-2">
              {e.hoursWorked > 0 && <span>{e.hoursWorked}h logged</span>}
              {e.points > 0 && <span>{e.points} pts earned</span>}
              {e.deadline && <span>Deadline {fmtDate(e.deadline)}</span>}
            </div>
            {e.proof.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {e.proof.map((p, i) => (
                  <a
                    key={i}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-primary hover:underline break-all"
                  >
                    {p.kind === 'file' ? <FileText className="h-3 w-3 shrink-0" /> : <ExternalLink className="h-3 w-3 shrink-0" />}
                    {p.label}
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {entries.length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} className="w-full">
          {expanded ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
          {expanded ? 'Show fewer' : `Show all ${entries.length} missions`}
        </Button>
      )}
    </div>
  );
}
