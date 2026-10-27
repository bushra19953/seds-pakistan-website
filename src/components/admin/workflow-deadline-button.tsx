'use client';

import { useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { toDatetimeLocal } from '@/components/admin/tasks/task-form';
import { safeFormat } from '@/lib/date-utils';

interface WorkflowDeadlineButtonProps {
  workflowId: string;
  workflowTitle: string;
  /** Current workflow deadline as an ISO string (from the workflows list). */
  currentDeadline?: string | null;
  onUpdated?: (workflowId: string, deadlineIso: string) => void;
  className?: string;
}

// Self-contained deadline editor for a workflow card.
// Opens a dialog prefilled with the workflow's current deadline and saves
// through PATCH /api/workflows/[id], which moves the deadline on every
// step at once. Reports the new ISO deadline back via onUpdated so the
// card can show it without a manual reload.
export function WorkflowDeadlineButton({
  workflowId,
  workflowTitle,
  currentDeadline,
  onUpdated,
  className,
}: WorkflowDeadlineButtonProps) {
  const { showToast: toast } = useEnhancedToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleOpen = () => {
    setValue(toDatetimeLocal(currentDeadline || undefined));
    setReason('');
    setOpen(true);
  };

  const handleSave = async () => {
    if (!value) {
      toast({ variant: 'destructive', title: 'Error', description: 'Pick a new deadline first.' });
      return;
    }
    const picked = new Date(value);
    if (isNaN(picked.getTime())) {
      toast({ variant: 'destructive', title: 'Error', description: 'That date and time is not valid.' });
      return;
    }
    if (picked.getTime() <= Date.now()) {
      toast({ variant: 'destructive', title: 'Error', description: 'The new deadline must be in the future.' });
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deadline: picked.toISOString(),
          reason: reason.trim() || undefined,
        }),
      });

      let payload: { deadline?: string; stepsUpdated?: number; error?: string } = {};
      try {
        payload = await response.json();
      } catch {
        // Non JSON response; fall back to status text below.
      }

      if (!response.ok || !payload.deadline) {
        throw new Error(payload.error || `Deadline update failed (HTTP ${response.status}).`);
      }

      toast({
        title: 'Deadline updated',
        description: `"${workflowTitle}" is now due ${safeFormat(payload.deadline, 'MMM dd, yyyy')} (${payload.stepsUpdated ?? 0} step${payload.stepsUpdated === 1 ? '' : 's'} moved).`,
      });
      setOpen(false);
      onUpdated?.(workflowId, payload.deadline);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update the deadline.';
      toast({ variant: 'destructive', title: 'Error', description: message });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={className}
        onClick={handleOpen}
        title={`Edit deadline for ${workflowTitle}`}
      >
        <CalendarClock className="mr-2 h-4 w-4" />
        Deadline
      </Button>

      <Dialog open={open} onOpenChange={(next) => !isSaving && setOpen(next)}>
        <DialogContent className="bg-card border-slate-700 text-foreground">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              Edit deadline
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Move the deadline for &quot;{workflowTitle}&quot;. The new date applies to the
              mission and to every step in it.
              {currentDeadline
                ? ` Current deadline: ${safeFormat(currentDeadline, 'MMM dd, yyyy, hh:mm a')}.`
                : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor={`deadline-${workflowId}`}>New deadline</Label>
              <Input
                id={`deadline-${workflowId}`}
                type="datetime-local"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`deadline-reason-${workflowId}`}>Reason (optional, saved to the audit log)</Label>
              <Input
                id={`deadline-reason-${workflowId}`}
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Founder moved all crucible pods to Oct 30"
                disabled={isSaving}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="bg-transparent border-slate-600 hover:bg-muted"
              onClick={() => setOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save deadline'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default WorkflowDeadlineButton;
