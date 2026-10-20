"use client";

import { useEffect, useState } from "react";
import { useFirestore, useUser } from "@/firebase";
import { doc, getDoc } from "firebase/firestore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEnhancedToast } from "@/hooks/use-enhanced-toast";
import { useAuthorization } from "@/hooks/use-authorization";
import {
  WarningType,
  WARNING_TYPE_LABELS,
  WarningSettings,
  DEFAULT_WARNING_SETTINGS,
} from "@/types/user";
import { Progress } from "@/components/ui/progress";

type IssueBulkWarningDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUsers: { uid: string; displayName: string; warningCount?: number }[];
  onSuccess?: () => void;
};

const REASON_TEMPLATES = [
  "Missed 3 consecutive General Body Meetings without prior notice.",
  "Repeated failure to meet project deadlines.",
  "Inappropriate conduct during a club event.",
  "Violation of SEDS hardware/lab usage policy.",
  "Unexcused absence from mandatory volunteering activity.",
];

export default function IssueBulkWarningDialog({
  open,
  onOpenChange,
  selectedUsers,
  onSuccess,
}: IssueBulkWarningDialogProps) {
  const firestore = useFirestore();
  const { user } = useUser();
  const { showToast: toast } = useEnhancedToast();
  const { isAuthorized: canManageUsers } = useAuthorization("canManageUsers");

  const [reason, setReason] = useState<string>("");
  const [warningType, setWarningType] = useState<WarningType>("misconduct");
  const [expiresDays, setExpiresDays] = useState<number>(DEFAULT_WARNING_SETTINGS.expirationDays);
  const [isPermanent, setIsPermanent] = useState<boolean>(false);
  const [severity, setSeverity] = useState<"low" | "medium" | "high">("medium");
  const [notes, setNotes] = useState<string>("");
  const [penaltyPoints, setPenaltyPoints] = useState<number>(DEFAULT_WARNING_SETTINGS.penaltyPoints);
  const [saving, setSaving] = useState<boolean>(false);
  const [progress, setProgress] = useState(0);
  const [settings, setSettings] = useState<WarningSettings>(DEFAULT_WARNING_SETTINGS);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settingsRef = doc(firestore, "warningConfig", "global");
        const snap = await getDoc(settingsRef);
        if (snap.exists()) {
          const data = snap.data() as WarningSettings;
          setSettings(data);
          setExpiresDays(data.expirationDays ?? DEFAULT_WARNING_SETTINGS.expirationDays);
          setPenaltyPoints(data.penaltyPoints ?? DEFAULT_WARNING_SETTINGS.penaltyPoints);
        }
      } catch {
        // Use defaults
      }
    };
    if (open) {
      setReason("");
      setWarningType("misconduct");
      setIsPermanent(false);
      setSeverity("medium");
      setNotes("");
      setPenaltyPoints(DEFAULT_WARNING_SETTINGS.penaltyPoints);
      setProgress(0);
      loadSettings();
    }
  }, [open, firestore]);

  const handleTemplateChange = (val: string) => {
    if (val !== "custom") {
      setReason(val);
    }
  };

  const handleBulkIssue = async () => {
    if (!user?.uid || !canManageUsers) return;
    if (!reason.trim()) {
      toast({ variant: "destructive", title: "Reason required", description: "Please provide a warning reason." });
      return;
    }
    if (selectedUsers.length === 0) return;

    setSaving(true);
    setProgress(10);

    const days = Math.max(1, Number(expiresDays || settings.expirationDays));
    const penalty = Math.max(0, Number(penaltyPoints || 0));
    const failures: string[] = [];

    try {
      const token = await user.getIdToken();

      for (let i = 0; i < selectedUsers.length; i += 1) {
        const targetUser = selectedUsers[i];
        try {
          const res = await fetch("/api/admin/issue-warning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              userUid: targetUser.uid,
              warningType,
              reason: reason.trim(),
              expiresDays: days,
              isPermanent,
              penaltyPoints: penalty,
              severity,
              notes: notes.trim(),
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data?.error || `Request failed (${res.status})`);
          }
        } catch (err: any) {
          failures.push(targetUser.displayName || targetUser.uid);
        }
        setProgress(10 + Math.floor(((i + 1) / selectedUsers.length) * 90));
      }

      const successCount = selectedUsers.length - failures.length;
      if (failures.length > 0) {
        toast({
          variant: "destructive",
          title: "Bulk Operation Partially Failed",
          description: `Issued ${successCount} of ${selectedUsers.length} warnings. Failed for: ${failures.join(", ")}`,
        });
      } else {
        toast({
          title: "Bulk Warnings Issued",
          description: `Successfully issued warnings to ${successCount} users.`,
        });
      }
      if (onSuccess) onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      console.error("Bulk warning issue failed", e);
      toast({ variant: "destructive", title: "Bulk Operation Failed", description: e.message || "Failed to process all warnings." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="text-destructive font-bold flex items-center gap-2">
            <span className="bg-destructive/10 text-destructive p-1 rounded-md">⚠️</span> 
            Issue Bulk Warning
          </DialogTitle>
          <DialogDescription>
            You are about to issue a formal warning to <strong>{selectedUsers.length}</strong> selected users.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="bg-muted/50 p-3 rounded-lg max-h-24 overflow-y-auto text-sm border">
            <strong>Target Users:</strong>{" "}
            <span className="text-muted-foreground">
              {selectedUsers.map(u => u.displayName).join(", ")}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Warning Type</Label>
              <Select value={warningType} onValueChange={(v) => setWarningType(v as WarningType)} disabled={saving}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(WARNING_TYPE_LABELS).map(([k, l]) => (
                    <SelectItem key={k} value={k}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Quick Template</Label>
              <Select onValueChange={handleTemplateChange} disabled={saving}>
                <SelectTrigger>
                  <SelectValue placeholder="Custom Reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">-- Custom --</SelectItem>
                  {REASON_TEMPLATES.map((tmpl, idx) => (
                    <SelectItem key={idx} value={tmpl}>
                      {tmpl.substring(0, 30)}...
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Reason (applies to all)</Label>
            <Textarea 
              value={reason} 
              onChange={(e) => setReason(e.target.value)} 
              disabled={saving} 
              placeholder="E.g., Missed 3 consecutive general body meetings."
              className="resize-none h-24"
            />
          </div>

          <div className="flex items-end gap-4 p-4 bg-muted/30 rounded-lg border">
            <div className="space-y-2 flex-grow">
              <Label>Expires in (days)</Label>
              <Input 
                type="number" 
                min={1} 
                value={String(expiresDays)} 
                onChange={(e) => setExpiresDays(Number(e.target.value))} 
                disabled={saving || isPermanent} 
              />
            </div>
            <div className="flex items-center space-x-2 pb-[10px]">
              <Checkbox 
                id="permanent-bulk" 
                checked={isPermanent}
                onCheckedChange={(c) => setIsPermanent(!!c)}
                disabled={saving}
              />
              <Label htmlFor="permanent-bulk" className="text-destructive font-semibold cursor-pointer">
                Permanent Warning
              </Label>
            </div>
          </div>
          
          <p className="text-xs text-muted-foreground">
            {!isPermanent ? `Global default expiry is ${settings.expirationDays}d.` : 'Permanent warnings do not expire organically.'}
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Penalty points (applies to all)</Label>
              <Input
                type="number"
                min={0}
                value={String(penaltyPoints)}
                onChange={(e) => setPenaltyPoints(Number(e.target.value))}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label>Severity (applies to all)</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as "low" | "medium" | "high")} disabled={saving}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Internal notes (applies to all)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              placeholder="Optional notes visible to admins only."
              className="resize-none h-16"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {`Global default penalty is ${settings.penaltyPoints} points per warning. Penalty points are deducted from each user when the warning is issued.`}
          </p>

          {saving && (
            <div className="space-y-2 mt-4 flex-col gap-2">
              <div className="flex justify-between text-xs text-muted-foreground w-full">
                <span>Processing batch operation...</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2 w-full" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => !saving && onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="destructive" onClick={handleBulkIssue} disabled={saving || !reason.trim() || selectedUsers.length === 0}>
            {saving ? "Executing..." : `Issue to ${selectedUsers.length} Users`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
