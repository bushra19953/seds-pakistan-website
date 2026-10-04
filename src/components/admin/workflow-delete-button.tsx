'use client';

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { cn } from '@/lib/utils';

interface WorkflowDeleteButtonProps {
  workflowId: string;
  workflowTitle: string;
  taskCount: number;
  completedCount: number;
  onDeleted: (id: string) => void;
  className?: string;
}

/**
 * Self-contained delete trigger + confirmation dialog for an AI workflow.
 * Handles the full delete flow (confirm, force-on-completed, 409/404 handling)
 * so the parent page only needs to render it and react via onDeleted.
 */
export default function WorkflowDeleteButton({
  workflowId,
  workflowTitle,
  taskCount,
  completedCount,
  onDeleted,
  className,
}: WorkflowDeleteButtonProps) {
  const { showToast: toast } = useEnhancedToast();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const requiresAcknowledgement = completedCount > 0;
  const canConfirm = !requiresAcknowledgement || acknowledged;

  const resetDialogState = () => {
    setAcknowledged(false);
    setServerError(null);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setIsDeleting(false);
      resetDialogState();
    }
  };

  const handleConfirm = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setServerError(null);
    const force = requiresAcknowledgement && acknowledged;
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}?confirm=${encodeURIComponent(workflowId)}&force=${force}`,
        { method: 'DELETE' }
      );

      if (res.status === 409) {
        let message = 'This workflow cannot be deleted right now.';
        try {
          const data = await res.json();
          if (typeof data?.message === 'string' && data.message.trim()) {
            message = data.message;
          }
        } catch {
          // fall back to the generic message
        }
        setServerError(message);
        return;
      }

      if (res.status === 404) {
        toast({ title: 'Already deleted', description: `"${workflowTitle}" no longer exists.` });
        handleOpenChange(false);
        onDeleted(workflowId);
        return;
      }

      if (!res.ok) {
        let description = 'Failed to delete the workflow. Please try again.';
        try {
          const data = await res.json();
          if (typeof data?.message === 'string' && data.message.trim()) {
            description = data.message;
          }
        } catch {
          // keep the generic description
        }
        toast({ variant: 'destructive', title: 'Error', description });
        return;
      }

      toast({ title: 'Workflow deleted', description: `"${workflowTitle}" was permanently deleted.` });
      handleOpenChange(false);
      onDeleted(workflowId);
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to delete the workflow. Please try again.',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Delete workflow"
        aria-label={`Delete workflow ${workflowTitle}`}
        className={cn(
          'h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive',
          className
        )}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                <span className="font-medium text-foreground">&ldquo;{workflowTitle}&rdquo;</span> and its{' '}
                {taskCount} step {taskCount === 1 ? 'task' : 'tasks'} will be permanently deleted. This
                cannot be undone.
              </p>
              {requiresAcknowledgement && (
                <div className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <Checkbox
                    id={`delete-workflow-ack-${workflowId}`}
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    disabled={isDeleting}
                  />
                  <Label
                    htmlFor={`delete-workflow-ack-${workflowId}`}
                    className="cursor-pointer text-sm font-normal leading-snug"
                  >
                    I understand {completedCount} completed {completedCount === 1 ? 'step' : 'steps'} will
                    be permanently deleted
                  </Label>
                </div>
              )}
              {serverError && (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {serverError}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!canConfirm || isDeleting}
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
