"use client";

import { useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Loader2, Clock, Coins } from 'lucide-react';

interface QueueItem {
  id: string;
  title: string;
  submitterUid: string;
  submitterName: string;
  submitterRole: string;
  workflowId?: string;
  sequenceIndex?: number;
  points?: number;
  submittedAt?: string;
  deadline?: string;
  via: 'chain' | 'assigner' | 'role';
  depth: number | null;
}

/**
 * Awaiting Your Validation: tasks submitted by people below the viewer in
 * the reporting chain (or assigned by the viewer) that are waiting for a
 * validation decision. Rendered only when non-empty, on the viewer's own
 * profile, pinned above Mission Control.
 */
export function ValidationQueue({ onReview }: { onReview?: (taskId: string) => void }) {
  const { user } = useUser();
  const [items, setItems] = useState<QueueItem[] | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/tasks/review-queue', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setItems(Array.isArray(data.tasks) ? data.tasks : []);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.uid]);

  if (!items || items.length === 0) return null;

  const chainLabel = (item: QueueItem) => {
    if (item.via === 'assigner') return 'Assigner';
    if (item.via === 'chain' && item.depth != null) {
      return `${item.depth} ${item.depth === 1 ? 'level' : 'levels'} above submitter`;
    }
    return 'Task manager';
  };

  const formatDate = (iso?: string) => {
    if (!iso) return 'No deadline';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? 'No deadline' : d.toLocaleString();
  };

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-primary">
          <ShieldCheck className="h-5 w-5" />
          Awaiting Your Validation
          <span className="ml-auto text-xs font-mono bg-primary text-black rounded-full px-2 py-0.5">
            {items.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="p-4 rounded-xl border border-border bg-card/60 flex flex-col gap-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  Submitted by {item.submitterName}
                  {item.submitterRole ? ` (${item.submitterRole.replace(/_/g, ' ')})` : ''}
                </p>
                <p className="text-[11px] text-primary font-medium">
                  Your role: {chainLabel(item)}
                </p>
              </div>
              {typeof item.points === 'number' && (
                <span className="shrink-0 inline-flex items-center gap-1 text-xs font-bold text-amber-400">
                  <Coins className="h-3.5 w-3.5" /> {item.points}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
              {item.submittedAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Submitted {new Date(item.submittedAt).toLocaleDateString()}
                </span>
              )}
              <span>Deadline: {formatDate(item.deadline)}</span>
            </div>
            <div>
              <Button
                size="sm"
                className="min-h-[44px]"
                onClick={() => {
                  if (onReview) onReview(item.id);
                  else window.location.href = `/profile/unified?uid=${user?.uid}&task=${item.id}`;
                }}
              >
                Review Submission
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ValidationQueueLoader() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
      <Loader2 className="h-4 w-4 animate-spin" /> Checking for submissions awaiting your validation...
    </div>
  );
}
