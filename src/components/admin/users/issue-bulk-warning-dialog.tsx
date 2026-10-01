"use client";

import { useEffect, useState } from "react";
import { useFirestore, useUser } from "@/firebase";
import {
  writeBatch,
  collection,
  serverTimestamp,
  Timestamp,
  doc,
  getDoc,
} from "firebase/firestore";
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
        }
      } catch {
        // Use defaults
      }
    };
    if (open) {
      setReason("");
      setWarningType("misconduct");
      setIsPermanent(false);
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
    const threshold = settings.blacklistThreshold ?? DEFAULT_WARNING_SETTINGS.blacklistThreshold;
    const now = new Date();
    // If permanent, set expiry 100 years in the future
    const days = isPermanent ? 36500 : Math.max(1, Number(expiresDays || settings.expirationDays));
    const expiresAtDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    
    // Chunking to respect 500 op limit (2 ops per user = 250 max, using 100 chunks for safety)
    const CHUNK_SIZE = 100;
    let successCount = 0;

    try {
      for (let i = 0; i < selectedUsers.length; i += CHUNK_SIZE) {
        const chunk = selectedUsers.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(firestore);

        chunk.forEach((targetUser) => {
          // 1. Add to subcollection
          const newWarningRef = doc(collection(firestore, "users", targetUser.uid, "warnings"));
          batch.set(newWarningRef, {
            reason: reason.trim(),
            type: warningType,
            severity: "medium",
            createdBy: user.uid,
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromDate(expiresAtDate),
            isActive: true,
            isPermanent: isPermanent,
            appealStatus: "none",
          });

          // 2. Update user doc (increment count & check blacklist)
          const userRef = doc(firestore, "users", targetUser.uid);
          const currentCount = targetUser.warningCount || 0;
          const newCount = currentCount + 1;
          const shouldBlacklist = newCount >= threshold;

          const userUpdate: Record<string, any> = {
             warningCount: newCount, 
             updatedAt: serverTimestamp(),
          };

          if (shouldBlacklist) {
            userUpdate.isBlacklisted = true;
            userUpdate.blacklistReason = `Reached ${threshold} active warnings via bulk issue.`;
            userUpdate.blacklistedAt = serverTimestamp();
          }

          batch.update(userRef, userUpdate);
        });

        await batch.commit();
        successCount += chunk.length;
        setProgress(10 + Math.floor((successCount / selectedUsers.length) * 90));
      }

      toast({
        title: "Bulk Warnings Issued",
        description: `Successfully issued warnings to ${successCount} users.`,
      });
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
