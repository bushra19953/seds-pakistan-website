"use client";

/**
 * IssueBulkWarningDialog - CONVERTED by the Phase 2 discipline rebuild
 * (spec E.6.5).
 *
 * Bulk warning issuance is retired. Discipline is individual: each
 * case names one subject, one constitutional ground, and one set of
 * facts. The component keeps its name and props so existing callers
 * compile unchanged, but it only explains the change and links to the
 * discipline queue, where cases are opened one member at a time.
 */
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type IssueBulkWarningDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUsers: { uid: string; displayName: string; warningCount?: number }[];
  onSuccess?: () => void;
};

export default function IssueBulkWarningDialog({
  open,
  onOpenChange,
  selectedUsers,
}: IssueBulkWarningDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk warnings retired</DialogTitle>
          <DialogDescription>
            {selectedUsers.length} member(s) selected. Warnings are no
            longer issued in bulk or directly: each one is the outcome of
            an individual disciplinary case with a served notice, a
            defence window of at least 7 days, and a hearing.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Open a case per member from the discipline queue. Nothing is
          recorded against anyone until their case is decided.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button asChild>
            <Link href="/admin/discipline" onClick={() => onOpenChange(false)}>
              Go to discipline queue
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
