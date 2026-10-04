'use client';

import { useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

interface WorkflowDuplicateButtonProps {
  workflowId: string;
  workflowTitle: string;
  onDuplicated: (newWorkflowId: string) => void;
  className?: string;
}

// Self contained duplicate trigger for a workflow card.
// Confirms, then POSTs /api/workflows/[id]/duplicate and reports back via onDuplicated.
export function WorkflowDuplicateButton({
  workflowId,
  workflowTitle,
  onDuplicated,
  className,
}: WorkflowDuplicateButtonProps) {
  const { showToast: toast } = useEnhancedToast();
  const [open, setOpen] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);

  const handleConfirm = async () => {
    setIsDuplicating(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      let payload: { workflowId?: string; id?: string; error?: string } = {};
      try {
        payload = await response.json();
      } catch {
        // Non JSON response; fall back to status text below.
      }

      if (!response.ok) {
        throw new Error(payload.error || `Duplicate failed (HTTP ${response.status}).`);
      }

      const newWorkflowId = payload.workflowId ?? payload.id;
      if (!newWorkflowId) {
        throw new Error('Duplicate succeeded but the server did not return a workflow id.');
      }

      toast({
        title: 'Success',
        description: `Workflow duplicated. The new copy is ready as a draft.`,
      });
      setOpen(false);
      onDuplicated(newWorkflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to duplicate workflow.';
      toast({ variant: 'destructive', title: 'Error', description: message });
    } finally {
      setIsDuplicating(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        title={`Duplicate ${workflowTitle}`}
      >
        <Copy className="mr-2 h-4 w-4" />
        Duplicate
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => !isDuplicating && setOpen(next)}>
        <AlertDialogContent className="bg-card border-slate-700 text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Copy className="h-5 w-5" />
              Duplicate &quot;{workflowTitle}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              A new draft copy will be created with all steps and assignees; statuses reset to pending.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="bg-transparent border-slate-600 hover:bg-muted"
              disabled={isDuplicating}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} disabled={isDuplicating}>
              {isDuplicating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Duplicating...
                </>
              ) : (
                'Duplicate'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default WorkflowDuplicateButton;
