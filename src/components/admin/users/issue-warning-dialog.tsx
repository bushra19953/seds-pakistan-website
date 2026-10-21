"use client";

/**
 * IssueWarningDialog - CONVERTED by the Phase 2 discipline rebuild
 * (spec E.6.5).
 *
 * This component used to issue warnings directly (client Firestore
 * writes, points deductions, threshold blacklist/ban). That machinery
 * is retired: a warning now exists only as the Strike 1 outcome of a
 * decided disciplinary case. The component keeps its name and props so
 * existing callers compile unchanged, but its only action is "Refer to
 * discipline" - a deep link into the case creation flow, prefilled
 * with the subject.
 */
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type IssueWarningDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userUid: string;
  userName?: string;
};

export default function IssueWarningDialog({
  open,
  onOpenChange,
  userUid,
  userName,
}: IssueWarningDialogProps) {
  const router = useRouter();

  const refer = () => {
    onOpenChange(false);
    router.push(`/admin/discipline/new?subject=${encodeURIComponent(userUid)}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Refer to discipline</DialogTitle>
          <DialogDescription>
            Warnings are no longer issued directly
            {userName ? ` for ${userName}` : ""}. Under the discipline
            process, a warning (Strike 1) is the recorded outcome of a
            decided case: a notice is served by the National General
            Secretary, the member has at least 7 days to submit a defence,
            and a hearing is held before any sanction is applied.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Open a disciplinary case to start that process. Nothing is
          recorded against the member until a case is decided.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={refer}>Refer to discipline</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
